/**
 * Unit tests for backups/tar.ts — the tar builder used to put-archive
 * metadata/stack files into the backup helper (replacing the inline-base64 Cmd
 * that blew ARG_MAX). buildTar wraps modern-tar, so these tests lock the two
 * things we depend on: byte-exact round-trips of file CONTENT, and — the bug that
 * broke many users' stack backups — PATHS far longer than the 100-byte USTAR
 * name field (`.git/objects/…`, `cache/images/…`, deep trees), which the old
 * hand-rolled writer rejected. We extract with modern-tar's own unpackTar so the
 * assertions reflect what a real PAX-aware reader (restic's) sees.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { unpackTar } from 'modern-tar';
import { buildTar, buildTarStream, type TarEntry, type TarFileSource } from '../../src/lib/server/backups/tar';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytelen = (s: string) => enc.encode(s).length;

/** Extract a tar (built by buildTar) back into { path -> content bytes }. */
async function extractTar(tar: Uint8Array): Promise<Record<string, Uint8Array>> {
	const out: Record<string, Uint8Array> = {};
	for (const e of await unpackTar(tar)) {
		out[e.header.name] = e.data ?? new Uint8Array();
	}
	return out;
}

/** Drain a web ReadableStream<Uint8Array> into one Uint8Array. */
async function drainStream(rs: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = rs.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) { out.set(c, o); o += c.length; }
	return out;
}

/** Ordered list of entry names from a tar (to assert inline-before-sources ordering). */
async function tarNames(tar: Uint8Array): Promise<string[]> {
	return (await unpackTar(tar)).map((e) => e.header.name);
}

describe('buildTar', () => {
	it('round-trips a single small file byte-for-byte', async () => {
		const tar = await buildTar([{ path: 'metadata/metadata.json', content: enc.encode('{"hello":"world"}') }], 1000);
		expect(dec.decode((await extractTar(tar))['metadata/metadata.json'])).toBe('{"hello":"world"}');
	});

	it('round-trips multiple files including nested stack paths', async () => {
		const entries: TarEntry[] = [
			{ path: 'metadata/metadata.json', content: enc.encode('{}') },
			{ path: 'metadata/stacks/web/compose.yaml', content: enc.encode('services: {}') },
			{ path: 'metadata/stacks/web/stackfiles/.env', content: enc.encode('A=1\nB=2\n') },
		];
		const parsed = await extractTar(await buildTar(entries, 1000));
		expect(Object.keys(parsed).sort()).toEqual([
			'metadata/metadata.json',
			'metadata/stacks/web/compose.yaml',
			'metadata/stacks/web/stackfiles/.env',
		]);
		expect(dec.decode(parsed['metadata/stacks/web/stackfiles/.env'])).toBe('A=1\nB=2\n');
	});

	it('round-trips a >1 MB file exactly — the ARG_MAX case', async () => {
		const big = new Uint8Array(3 * 1024 * 1024);
		for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
		const parsed = await extractTar(await buildTar([{ path: 'metadata/stacks/x/stackfiles/big.bin', content: big }], 1000));
		expect(Buffer.from(parsed['metadata/stacks/x/stackfiles/big.bin']).equals(Buffer.from(big))).toBe(true);
	});

	it('strips a leading slash from entry paths', async () => {
		const parsed = await extractTar(await buildTar([{ path: '/metadata/x', content: new Uint8Array([1]) }], 1000));
		expect(Object.keys(parsed)).toEqual(['metadata/x']);
	});

	// ── Long paths: the bug (backup broke with "USTAR name field >100 bytes") ──

	it('round-trips the EXACT reported paths (99–107 bytes) that used to fail', async () => {
		const reported = [
			'metadata/stacks/audiobookshelf/stackfiles/config/migrations/v2.17.4-use-subfolder-for-oidc-redirect-uris.js',
			'metadata/stacks/jellyfin/stackfiles/cache/images/resized-images/0/005a4137-deaf-7b24-24ad-8c7de46aa9cb.webp',
			'metadata/stacks/myapp/stackfiles/.git/objects/pack/pack-8d3ba5ac644a51bfc926e985bab3cd3afbd6e1dc.idx',
		];
		const parsed = await extractTar(await buildTar(reported.map((p, i) => ({ path: p, content: enc.encode(`f${i}`) })), 1000));
		for (let i = 0; i < reported.length; i++) {
			expect(bytelen(reported[i])).toBeGreaterThanOrEqual(100); // at/over the old limit
			expect(dec.decode(parsed[reported[i]])).toBe(`f${i}`);
		}
		expect(reported.some((p) => bytelen(p) > 100)).toBe(true); // at least one strictly over
	});

	it('round-trips a path in the 101–255-byte range', async () => {
		const path = 'metadata/stacks/' + 'deep/'.repeat(20) + 'file.txt';
		expect(bytelen(path)).toBeGreaterThan(100);
		expect(bytelen(path)).toBeLessThanOrEqual(255);
		const parsed = await extractTar(await buildTar([{ path, content: enc.encode('X') }], 1000));
		expect(dec.decode(parsed[path])).toBe('X');
	});

	it('round-trips a path far beyond 255 bytes (needs PAX)', async () => {
		const path = 'metadata/stacks/app/stackfiles/' + 'segment/'.repeat(40) + 'leaf.bin';
		expect(bytelen(path)).toBeGreaterThan(255);
		const parsed = await extractTar(await buildTar([{ path, content: enc.encode('deep') }], 1000));
		expect(dec.decode(parsed[path])).toBe('deep');
	});

	it('round-trips a path whose single SEGMENT exceeds 100 bytes (unsplittable, needs PAX)', async () => {
		const path = `metadata/stacks/app/stackfiles/${'z'.repeat(140)}.dat`;
		const parsed = await extractTar(await buildTar([{ path, content: enc.encode('seg') }], 1000));
		expect(dec.decode(parsed[path])).toBe('seg');
	});

	it('round-trips a UTF-8 (multi-byte) long path', async () => {
		const path = 'metadata/stacks/app/stackfiles/' + 'ćęłż/'.repeat(30) + 'plik.txt';
		expect(bytelen(path)).toBeGreaterThan(100);
		const parsed = await extractTar(await buildTar([{ path, content: enc.encode('utf') }], 1000));
		expect(dec.decode(parsed[path])).toBe('utf');
	});

	it('mixes short, mid, and very-long paths in one archive', async () => {
		const short = 'metadata/metadata.json';
		const mid = 'metadata/stacks/web/' + 'x/'.repeat(45) + 'f';
		const huge = 'metadata/stacks/web/' + 'y/'.repeat(160) + 'g';
		expect(bytelen(huge)).toBeGreaterThan(255);
		const parsed = await extractTar(await buildTar([
			{ path: short, content: enc.encode('a') },
			{ path: mid, content: enc.encode('b') },
			{ path: huge, content: enc.encode('c') },
		], 1000));
		expect(dec.decode(parsed[short])).toBe('a');
		expect(dec.decode(parsed[mid])).toBe('b');
		expect(dec.decode(parsed[huge])).toBe('c');
	});

	it('is deterministic for a fixed mtime (incl. a long PAX path)', async () => {
		const e = [{ path: 'metadata/stacks/app/stackfiles/' + 'q/'.repeat(160) + 'z', content: enc.encode('x') }];
		const a = await buildTar(e, 1000);
		const b = await buildTar(e, 1000);
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
	});
});

describe('buildTarStream (lazy, disk-sourced, O(1) RAM)', () => {
	let dir: string;
	const mk = (name: string, bytes: Uint8Array): TarFileSource => {
		const p = join(dir, name);
		writeFileSync(p, bytes);
		return { diskPath: p, archivePath: `volumes/__dockhand_stackdir__/${name}` };
	};

	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tarstream-')); });
	afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

	it('round-trips inline entries + disk file sources byte-for-byte', async () => {
		const inline: TarEntry[] = [{ path: 'metadata/metadata.json', content: enc.encode('{"v":1}') }];
		const big = new Uint8Array(200_000).map((_, i) => i & 0xff);
		const sources = [mk('compose.yaml', enc.encode('services: {}\n')), mk('data.bin', big)];
		const tar = await drainStream(buildTarStream(sources, inline, 1000));
		const files = await extractTar(tar);
		expect(dec.decode(files['metadata/metadata.json'])).toBe('{"v":1}');
		expect(dec.decode(files['volumes/__dockhand_stackdir__/compose.yaml'])).toBe('services: {}\n');
		expect(Buffer.from(files['volumes/__dockhand_stackdir__/data.bin']).equals(Buffer.from(big))).toBe(true);
	});

	it('writes inline entries BEFORE file sources (order is load-bearing for metadata-first)', async () => {
		const inline: TarEntry[] = [{ path: 'metadata/metadata.json', content: enc.encode('m') }];
		const sources = [mk('a.txt', enc.encode('a')), mk('b.txt', enc.encode('b'))];
		const names = await tarNames(await drainStream(buildTarStream(sources, inline, 1000)));
		expect(names[0]).toBe('metadata/metadata.json');
		expect(names.slice(1)).toEqual(['volumes/__dockhand_stackdir__/a.txt', 'volumes/__dockhand_stackdir__/b.txt']);
	});

	it('handles a PAX long path (>100 bytes) from a disk source', async () => {
		const longName = 'x/'.repeat(80) + 'deep.txt';   // ~168 bytes, over USTAR 100
		const src: TarFileSource = { diskPath: join(dir, 'f'), archivePath: `volumes/${longName}` };
		writeFileSync(src.diskPath, enc.encode('deep'));
		const files = await extractTar(await drainStream(buildTarStream([src], [], 1000)));
		expect(dec.decode(files[`volumes/${longName}`])).toBe('deep');
	});

	it('strips a leading slash from archive paths', async () => {
		const src: TarFileSource = { diskPath: join(dir, 'g'), archivePath: '/volumes/x/y' };
		writeFileSync(src.diskPath, enc.encode('z'));
		const names = await tarNames(await drainStream(buildTarStream([src], [], 1000)));
		expect(names).toEqual(['volumes/x/y']);   // no leading slash in the archive
	});

	it('handles an empty file source (zero bytes)', async () => {
		const src = mk('empty', new Uint8Array(0));
		const files = await extractTar(await drainStream(buildTarStream([src], [], 1000)));
		expect(files['volumes/__dockhand_stackdir__/empty'].length).toBe(0);
	});

	it('ERRORS the stream if a file GROWS between stat and read (modern-tar enforces the declared size)', async () => {
		// Regression for the "size change is tolerated" comment: modern-tar declares
		// header.size from statSync but streams from createReadStream; if the file grew,
		// the packer throws "exceeds given size" and errors the whole stream. Prove the
		// consumer sees a rejection (NOT a silently-truncated tar reported as success).
		const src: TarFileSource = { diskPath: join(dir, 'growing'), archivePath: 'volumes/x' };
		writeFileSync(src.diskPath, enc.encode('small'));   // 5 bytes -> header says size=5
		const stream = buildTarStream([src], [], 1000);
		// Grow the file AFTER buildTarStream captured the stat but before/while it reads.
		writeFileSync(src.diskPath, enc.encode('much-longer-than-five-bytes'));
		await expect(drainStream(stream)).rejects.toBeDefined();
	});
});
