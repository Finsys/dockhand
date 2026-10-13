/**
 * selfh.st icon proxy + on-disk cache.
 *
 * The browser NEVER hits an external CDN: it asks our /api/icons/selfhst/<ref>
 * endpoint, we fetch the SVG from jsdelivr ONCE, cache it under DATA_DIR, and
 * serve it locally forever after. This keeps what a user self-hosts private (no
 * per-view CDN request that would reveal their app list) and works offline once
 * cached. Icons are CC-BY-4.0 (attribution shown in the picker + manual).
 */
import { resolve, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, renameSync, unlinkSync } from 'fs';

// Only these hosts/paths are ever fetched - the ref is the sole user-controlled
// input and is strictly validated below, so there is no SSRF surface.
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/selfhst/icons';
const MANIFEST_URL = `${CDN_BASE}/index.json`;
const FETCH_TIMEOUT_MS = 8000;
const MAX_ICON_BYTES = 512 * 1024; // an SVG logo is a few KB; cap defensively
const MANIFEST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// A negative-cache tombstone (0-byte file) expires so a ref added upstream later, or a
// transiently-failed fetch, is retried instead of stuck on the fallback glyph forever.
const NEG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

// selfh.st serves each icon in up to three formats. About 16% of the collection has no
// SVG (e.g. `unpackerr`), so we fall back to raster. SVG first (scalable, sanitizable),
// then WebP (smaller than PNG at equal quality), then PNG as the last resort. All render
// via <img>, so a raster icon is as safe as the sanitized SVG.
const ICON_FORMATS = [
	{ ext: 'svg', dir: 'svg', contentType: 'image/svg+xml' },
	{ ext: 'webp', dir: 'webp', contentType: 'image/webp' },
	{ ext: 'png', dir: 'png', contentType: 'image/png' }
] as const;
type IconFormat = (typeof ICON_FORMATS)[number];

/** Cached icon bytes plus the media type to serve them with. */
export interface SelfhstIcon {
	buffer: Buffer;
	contentType: string;
}

/** True when the buffer's magic bytes match the format (rejects mislabelled/garbage bytes). */
export function magicOk(ext: 'svg' | 'webp' | 'png', buf: Buffer): boolean {
	if (ext === 'svg') return buf[0] === 0x3c; // '<'
	if (ext === 'png') return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
	// webp: "RIFF"...."WEBP"
	return buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

/** Write bytes atomically (temp + rename) so a crash mid-write never leaves a partial file. */
function atomicWrite(path: string, data: Buffer): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

/** A selfh.st Reference: lowercase letters, digits, hyphens only. Anti-traversal. */
export function isValidSelfhstRef(ref: string): boolean {
	return /^[a-z0-9-]{1,64}$/.test(ref);
}

/**
 * Clean a client-supplied ref list for the batch endpoint: keep only valid string
 * refs, de-dupe, and cap the count so one request can't fan out unboundedly. Pure.
 */
export function sanitizeRefList(refs: unknown, max: number): string[] {
	if (!Array.isArray(refs)) return [];
	const valid = refs.filter((r): r is string => typeof r === 'string' && isValidSelfhstRef(r));
	return Array.from(new Set(valid)).slice(0, max);
}

function cacheDir(): string {
	const dataDir = process.env.DATA_DIR || './data';
	const dir = resolve(dataDir, 'icon-cache', 'selfhst');
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Absolute cache path for a ref's icon in a given format (default svg). Throws on an
 * invalid ref (never builds a path from junk). The ext is from a fixed internal set.
 */
export function selfhstCachePath(ref: string, ext: IconFormat['ext'] = 'svg'): string {
	if (!isValidSelfhstRef(ref)) throw new Error('Invalid selfh.st icon reference');
	return join(cacheDir(), `${ref}.${ext}`);
}

async function fetchWithTimeout(url: string): Promise<Response> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { signal: ac.signal, headers: { Accept: 'image/*,*/*' } });
	} finally {
		clearTimeout(t);
	}
}

/**
 * A valid cached file for this format, or null. A NON-EMPTY file that fails the magic
 * check is corrupt and dropped so it refetches. A 0-byte file is left alone: for the svg
 * format that is the negative-cache tombstone, honoured by the dedicated check in the
 * caller (deleting it here would defeat the negative cache).
 */
function readCachedFormat(ref: string, fmt: IconFormat): Buffer | null {
	const path = selfhstCachePath(ref, fmt.ext);
	if (!existsSync(path)) return null;
	try {
		const cached = readFileSync(path);
		if (cached.length === 0) return null; // tombstone / empty - leave it in place
		if (magicOk(fmt.ext, cached)) return cached;
		try { unlinkSync(path); } catch { /* best-effort */ }
	} catch {
		/* fall through */
	}
	return null;
}

/**
 * Return the cached icon bytes + content type for a ref, fetching+caching from the CDN
 * on a miss. Tries SVG, then WebP, then PNG (about 16% of the collection has no SVG).
 * Returns null when the ref is invalid, exists in no format upstream, or every fetch
 * fails - the caller then serves a placeholder. Never throws.
 */
export async function getSelfhstIcon(ref: string): Promise<SelfhstIcon | null> {
	if (!isValidSelfhstRef(ref)) return null;

	// Serve from cache if any format is already stored.
	for (const fmt of ICON_FORMATS) {
		const cached = readCachedFormat(ref, fmt);
		if (cached) return { buffer: cached, contentType: fmt.contentType };
	}

	// Negative-cache tombstone (keyed on the .svg path) means "no format exists"; honour
	// it until it expires, then fall through to refetch every format.
	const tombPath = selfhstCachePath(ref, 'svg');
	if (existsSync(tombPath)) {
		try {
			const st = statSync(tombPath);
			if (st.size === 0 && Date.now() - st.mtimeMs < NEG_CACHE_TTL_MS) return null;
		} catch { /* fall through */ }
	}

	// Try each format in order. A 404 for one format just moves to the next; only when
	// ALL formats miss (or error) do we tombstone below.
	for (const fmt of ICON_FORMATS) {
		try {
			const res = await fetchWithTimeout(`${CDN_BASE}/${fmt.dir}/${ref}.${fmt.ext}`);
			if (!res.ok) continue; // not in this format - try the next
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length === 0 || buf.length > MAX_ICON_BYTES || !magicOk(fmt.ext, buf)) continue;
			if (fmt.ext === 'svg') {
				// Strip active content before caching. An SVG from a third-party repo could
				// carry <script>/on*/<foreignObject>; we render via <img> and a locked-down
				// CSP, but sanitizing at rest is defense in depth against a stored payload.
				const clean = Buffer.from(sanitizeSvg(buf.toString('utf-8')), 'utf-8');
				atomicWrite(selfhstCachePath(ref, 'svg'), clean);
				return { buffer: clean, contentType: fmt.contentType };
			}
			// Raster formats are inert bytes; cache verbatim after the magic-byte check.
			atomicWrite(selfhstCachePath(ref, fmt.ext), buf);
			return { buffer: buf, contentType: fmt.contentType };
		} catch {
			// timeout / network for this format - try the next, then tombstone if all fail
		}
	}

	// Every format missed. Tombstone (with a TTL) so a matched-but-missing ref isn't
	// re-fetched on every render; a transient network error backs off the same way.
	try { atomicWrite(tombPath, Buffer.alloc(0)); } catch { /* best-effort */ }
	return null;
}

/**
 * Remove active content from an SVG string: <script> elements, on* event-handler
 * attributes, <foreignObject> (can embed HTML), and javascript: URLs. Conservative
 * regex strip - the SVGs are simple logos, not documents.
 */
export function sanitizeSvg(svg: string): string {
	return svg
		.replace(/<script[\s\S]*?<\/script\s*>/gi, '')
		.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
		.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
		.replace(/(href|xlink:href)\s*=\s*("|')?\s*javascript:[^"'>]*("|')?/gi, '');
}

// --- manifest (index.json, ~2880 entries) cached for the search picker ---

function manifestPath(): string {
	return join(cacheDir(), 'index.json');
}

function manifestFresh(): boolean {
	try {
		const st = statSync(manifestPath());
		return Date.now() - st.mtimeMs < MANIFEST_TTL_MS;
	} catch {
		return false;
	}
}

/**
 * Return the selfh.st manifest JSON (as a string), cached on disk with a 7-day TTL.
 * Returns null if it has never been fetched and the fetch fails.
 */
export async function getSelfhstManifest(): Promise<string | null> {
	const path = manifestPath();
	if (manifestFresh()) {
		try {
			return readFileSync(path, 'utf-8');
		} catch {
			// fall through to refetch
		}
	}
	try {
		const res = await fetchWithTimeout(MANIFEST_URL);
		if (!res.ok) throw new Error(`manifest ${res.status}`);
		const text = await res.text();
		JSON.parse(text); // validate it parses before caching
		atomicWrite(path, Buffer.from(text, 'utf-8'));
		return text;
	} catch {
		// Serve a stale cached copy if we have one; otherwise null.
		if (existsSync(path)) {
			try {
				return readFileSync(path, 'utf-8');
			} catch {
				return null;
			}
		}
		return null;
	}
}
