// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
	isValidSelfhstRef,
	selfhstCachePath,
	sanitizeSvg,
	getSelfhstIcon,
	sanitizeRefList,
	magicOk
} from '../src/lib/server/selfhst-icons';
import { looksLikeImage } from '../src/lib/server/stack-icons';

describe('isValidSelfhstRef', () => {
	test('accepts normal references', () => {
		for (const r of ['plex', 'jellyfin', 'home-assistant', 'pihole', 'nextcloud', '2fauth']) {
			expect(isValidSelfhstRef(r)).toBe(true);
		}
	});

	test('rejects path traversal and junk', () => {
		for (const r of ['../etc/passwd', 'a/b', 'foo.svg', 'Foo', 'a_b', 'a b', '', '..', './x', 'x/../y']) {
			expect(isValidSelfhstRef(r)).toBe(false);
		}
	});

	test('rejects an over-long ref', () => {
		expect(isValidSelfhstRef('a'.repeat(65))).toBe(false);
	});

	test('selfhstCachePath throws on an invalid ref (never builds a path from junk)', () => {
		expect(() => selfhstCachePath('../../etc/passwd')).toThrow();
		expect(() => selfhstCachePath('ok-ref')).not.toThrow();
	});

	test('selfhstCachePath keeps the ref inside the cache dir', () => {
		const p = selfhstCachePath('plex');
		expect(p.endsWith('/icon-cache/selfhst/plex.svg')).toBe(true);
	});
});

describe('sanitizeSvg (SVG-XSS defense)', () => {
	test('strips <script> elements', () => {
		const out = sanitizeSvg('<svg><script>alert(document.cookie)</script><rect/></svg>');
		expect(out).not.toContain('<script');
		expect(out).toContain('<rect');
	});

	test('strips on* event-handler attributes', () => {
		const out = sanitizeSvg('<svg onload="evil()"><rect onclick=\'x\'/></svg>');
		expect(out).not.toMatch(/onload/i);
		expect(out).not.toMatch(/onclick/i);
	});

	test('strips <foreignObject> (can embed HTML)', () => {
		const out = sanitizeSvg('<svg><foreignObject><body onload="x"/></foreignObject></svg>');
		expect(out).not.toMatch(/foreignObject/i);
	});

	test('strips javascript: URLs', () => {
		const out = sanitizeSvg('<svg><a href="javascript:alert(1)">x</a></svg>');
		expect(out.toLowerCase()).not.toContain('javascript:');
	});

	test('leaves a clean logo SVG intact', () => {
		const clean = '<svg viewBox="0 0 24 24"><path d="M1 1h2v2z" fill="#fff"/></svg>';
		expect(sanitizeSvg(clean)).toBe(clean);
	});
});

describe('magicOk (selfh.st icon format detection)', () => {
	test('accepts each format by its magic bytes', () => {
		expect(magicOk('svg', Buffer.from('<svg></svg>'))).toBe(true);
		expect(magicOk('png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
		expect(magicOk('webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe(true);
	});
	test('rejects mislabelled or garbage bytes', () => {
		expect(magicOk('svg', Buffer.from([0x89, 0x50]))).toBe(false); // png bytes, not svg
		expect(magicOk('png', Buffer.from('<svg>'))).toBe(false);      // svg bytes, not png
		expect(magicOk('webp', Buffer.from('RIFFxxxxNOPE'))).toBe(false); // RIFF but not WEBP
		expect(magicOk('webp', Buffer.from('RIFF'))).toBe(false);      // too short for the WEBP tag
		expect(magicOk('png', Buffer.alloc(0))).toBe(false);
	});
});

describe('looksLikeImage (upload magic-byte check)', () => {
	test('accepts real image magic bytes', () => {
		expect(looksLikeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe(true); // PNG
		expect(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true); // JPEG
		expect(looksLikeImage(Buffer.from('GIF89a'))).toBe(true);
		expect(looksLikeImage(Buffer.from('RIFF\0\0\0\0WEBP'))).toBe(true);
		expect(looksLikeImage(Buffer.from('<svg></svg>'))).toBe(true);
	});

	test('rejects arbitrary / non-image bytes', () => {
		expect(looksLikeImage(Buffer.from('#!/bin/sh\nrm -rf /'))).toBe(false);
		expect(looksLikeImage(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(false);
		expect(looksLikeImage(Buffer.from('MZ\x90\x00'))).toBe(false); // PE/exe
		expect(looksLikeImage(Buffer.alloc(0))).toBe(false);
	});
});

// getSelfhstIcon's cache-HIT paths are deterministic (no network). We seed the on-disk
// cache under a temp DATA_DIR and assert what the cache read returns. Stale/corrupt
// entries fall through to a fetch; we stub fetch to a synchronous 404 miss so the test
// never touches the CDN (a real fetch has an 8s timeout that outlives the 5s test
// budget, so any slow/blocked CDN would time the suite out - the fetch is not the SUT
// here, the cache read is).
describe('getSelfhstIcon cache-hit handling', () => {
	let dir: string;
	let realFetch: typeof globalThis.fetch;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'selfhst-cache-'));
		process.env.DATA_DIR = dir;
		realFetch = globalThis.fetch;
		// Every fall-through fetch is a deterministic miss - no network, no timeout race.
		globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch;
	});
	afterAll(() => {
		globalThis.fetch = realFetch;
		delete process.env.DATA_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	test('serves a valid cached SVG without refetching', async () => {
		const p = selfhstCachePath('plex');
		writeFileSync(p, '<svg>ok</svg>');
		const icon = await getSelfhstIcon('plex');
		expect(icon?.buffer.toString()).toBe('<svg>ok</svg>');
		expect(icon?.contentType).toBe('image/svg+xml');
	});

	test('serves a cached WebP when there is no SVG (raster fallback)', async () => {
		// unpackerr-style ref: only a raster format is cached.
		const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('payload')]);
		writeFileSync(selfhstCachePath('unpackerr', 'webp'), webp);
		const icon = await getSelfhstIcon('unpackerr');
		expect(icon?.contentType).toBe('image/webp');
		expect(icon?.buffer.length).toBe(webp.length);
	});

	test('prefers SVG over a cached raster format', async () => {
		writeFileSync(selfhstCachePath('grafana', 'svg'), '<svg>v</svg>');
		writeFileSync(selfhstCachePath('grafana', 'png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
		const icon = await getSelfhstIcon('grafana');
		expect(icon?.contentType).toBe('image/svg+xml');
	});

	test('a fresh zero-byte tombstone returns null (no refetch)', async () => {
		const p = selfhstCachePath('jellyfin');
		writeFileSync(p, Buffer.alloc(0)); // mtime = now -> within TTL
		expect(await getSelfhstIcon('jellyfin')).toBeNull();
		expect(existsSync(p)).toBe(true); // tombstone kept
	});

	// A syntactically valid ref; the stubbed fetch returns a 404 miss for it.
	const MISSING = 'zzz-nonexistent-test-icon';

	test('a corrupt (nonzero non-SVG) cache file is never served (dropped, refetched)', async () => {
		const p = selfhstCachePath(MISSING);
		writeFileSync(p, Buffer.from([0x00, 0x01, 0x02])); // binary, no leading '<'
		const buf = await getSelfhstIcon(MISSING);
		// The corrupt bytes are NOT returned. The 404 miss -> null; the file is either
		// gone or replaced by a 0-byte tombstone, never the original garbage.
		expect(buf).toBeNull();
		if (existsSync(p)) {
			expect(readFileSync(p).length).toBe(0); // tombstone, not the corrupt content
		}
	});

	test('a stale tombstone (older than the TTL) is not treated as a live miss', async () => {
		const p = selfhstCachePath(MISSING);
		writeFileSync(p, Buffer.alloc(0));
		const old = Date.now() / 1000 - 3 * 24 * 60 * 60; // 3 days ago (TTL is 1 day)
		utimesSync(p, old, old);
		const before = statSync(p).mtimeMs;
		await getSelfhstIcon(MISSING); // stale -> refetch (misses) -> fresh tombstone
		// The stale tombstone was acted on (dropped then rewritten), i.e. its mtime advanced -
		// proving it was NOT returned as a still-valid negative-cache hit.
		if (existsSync(p)) expect(statSync(p).mtimeMs).toBeGreaterThan(before);
	});

	test('a fresh tombstone is honoured WITHOUT any refetch', async () => {
		const ref = 'tomb-no-refetch';
		writeFileSync(selfhstCachePath(ref), Buffer.alloc(0)); // fresh 0-byte tombstone
		let calls = 0;
		const prev = globalThis.fetch;
		globalThis.fetch = (async () => { calls++; return new Response(null, { status: 404 }); }) as typeof globalThis.fetch;
		try {
			expect(await getSelfhstIcon(ref)).toBeNull();
			expect(calls).toBe(0); // the negative cache suppressed every CDN fetch
			expect(existsSync(selfhstCachePath(ref))).toBe(true); // tombstone still there
		} finally {
			globalThis.fetch = prev;
		}
	});
});

// The multi-format FETCH fallback (svg -> webp -> png over the wire). A url-discriminating
// stub returns the format-specific status/body so we exercise the real fetch loop, magic-byte
// validation, verbatim raster caching, and the svg-first short-circuit - none of which the
// cache-HIT tests above reach.
describe('getSelfhstIcon fetch fallback', () => {
	let dir: string;
	let realFetch: typeof globalThis.fetch;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'selfhst-fetch-'));
		process.env.DATA_DIR = dir;
		realFetch = globalThis.fetch;
	});
	afterAll(() => {
		globalThis.fetch = realFetch;
		delete process.env.DATA_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	test('svg 404 falls through to a webp 200 and caches it verbatim as image/webp', async () => {
		const ref = 'raster-only';
		const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('bytes')]);
		const seen: string[] = [];
		globalThis.fetch = (async (url: string) => {
			seen.push(url);
			if (url.endsWith('.svg')) return new Response(null, { status: 404 });
			if (url.endsWith('.webp')) return new Response(new Uint8Array(webp), { status: 200 });
			return new Response(null, { status: 404 });
		}) as typeof globalThis.fetch;

		const icon = await getSelfhstIcon(ref);
		expect(icon?.contentType).toBe('image/webp');
		expect(icon?.buffer.length).toBe(webp.length);
		// svg was tried first, webp second; the raster is cached verbatim.
		expect(seen.some((u) => u.endsWith('/svg/raster-only.svg'))).toBe(true);
		expect(seen.some((u) => u.endsWith('/webp/raster-only.webp'))).toBe(true);
		expect(readFileSync(selfhstCachePath(ref, 'webp')).length).toBe(webp.length);
	});

	test('svg 200 short-circuits: webp/png are never requested', async () => {
		const ref = 'has-svg';
		const seen: string[] = [];
		globalThis.fetch = (async (url: string) => {
			seen.push(url);
			if (url.endsWith('.svg')) return new Response('<svg>x</svg>', { status: 200 });
			return new Response(null, { status: 404 });
		}) as typeof globalThis.fetch;

		const icon = await getSelfhstIcon(ref);
		expect(icon?.contentType).toBe('image/svg+xml');
		expect(seen.some((u) => u.endsWith('.webp'))).toBe(false);
		expect(seen.some((u) => u.endsWith('.png'))).toBe(false);
	});

	test('a raster with wrong magic bytes is rejected (not cached, not served)', async () => {
		const ref = 'bad-magic';
		globalThis.fetch = (async (url: string) => {
			if (url.endsWith('.svg')) return new Response(null, { status: 404 });
			// 200 but the body is not a real webp/png (fails magicOk)
			return new Response('not-an-image', { status: 200 });
		}) as typeof globalThis.fetch;

		expect(await getSelfhstIcon(ref)).toBeNull();
		expect(existsSync(selfhstCachePath(ref, 'webp'))).toBe(false);
		expect(existsSync(selfhstCachePath(ref, 'png'))).toBe(false);
	});

	test('all formats missing writes a tombstone (creation is mandated, not optional)', async () => {
		const ref = 'no-format-anywhere';
		globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch;
		expect(await getSelfhstIcon(ref)).toBeNull();
		const tomb = selfhstCachePath(ref); // <ref>.svg
		expect(existsSync(tomb)).toBe(true);
		expect(readFileSync(tomb).length).toBe(0); // a 0-byte negative-cache tombstone
	});
});

describe('sanitizeRefList (batch endpoint input, #1467)', () => {
	test('keeps only valid refs, de-dupes, and caps the count', () => {
		const out = sanitizeRefList(['plex', 'plex', 'Bad Ref', '../etc', 'gitea', 42, null], 10);
		expect(out).toEqual(['plex', 'gitea']); // dupes + invalid dropped
	});

	test('caps at the given max', () => {
		const many = Array.from({ length: 300 }, (_, i) => `icon-${i}`);
		expect(sanitizeRefList(many, 200)).toHaveLength(200);
	});

	test('returns [] for a non-array', () => {
		expect(sanitizeRefList('plex', 10)).toEqual([]);
		expect(sanitizeRefList(undefined, 10)).toEqual([]);
	});
});
