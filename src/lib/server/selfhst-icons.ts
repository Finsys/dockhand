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

/** Absolute cache path for a ref's svg. Throws on an invalid ref (never builds a path from junk). */
export function selfhstCachePath(ref: string): string {
	if (!isValidSelfhstRef(ref)) throw new Error('Invalid selfh.st icon reference');
	return join(cacheDir(), `${ref}.svg`);
}

async function fetchWithTimeout(url: string): Promise<Response> {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { signal: ac.signal, headers: { Accept: 'image/svg+xml,*/*' } });
	} finally {
		clearTimeout(t);
	}
}

/**
 * Return the cached SVG bytes for a ref, fetching+caching from the CDN on a miss.
 * Returns null when the ref is invalid, not found upstream, or the fetch fails -
 * the caller then serves a 404 and the UI falls back to a generic icon. Never throws.
 */
export async function getSelfhstIcon(ref: string): Promise<Buffer | null> {
	if (!isValidSelfhstRef(ref)) return null;
	const path = selfhstCachePath(ref);
	if (existsSync(path)) {
		try {
			const cached = readFileSync(path);
			// A zero-byte file is a negative-cache tombstone; honour it until it expires,
			// then fall through to refetch (a ref added upstream later, or a transient
			// failure, must not be stuck on the fallback forever).
			if (cached.length === 0) {
				if (Date.now() - statSync(path).mtimeMs < NEG_CACHE_TTL_MS) return null;
			} else if (cached[0] === 0x3c) {
				return cached; // still looks like an SVG - serve it
			}
			// zero-byte-but-stale, or a nonzero-but-corrupt file (e.g. a truncated write):
			// drop it and refetch.
			try {
				unlinkSync(path);
			} catch {
				/* best-effort */
			}
		} catch {
			// fall through to refetch
		}
	}
	const tombstone = () => {
		try {
			atomicWrite(path, Buffer.alloc(0));
		} catch {
			/* best-effort */
		}
	};
	try {
		const res = await fetchWithTimeout(`${CDN_BASE}/svg/${ref}.svg`);
		if (!res.ok) {
			// Remember the miss (with a TTL) so a matched-but-missing ref isn't re-fetched
			// every render - covers 404 and transient 5xx/timeouts alike.
			tombstone();
			return null;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null;
		// Sanity check: SVG starts with '<' (xml/svg), never binary junk.
		if (buf[0] !== 0x3c) return null;
		// Strip active content before caching. The icons come from a third-party
		// community repo; an SVG is an active-content format, so a poisoned/scripted
		// logo could carry <script>/on*/<foreignObject>. We render only via <img>
		// (script-inert) AND serve with a locked-down CSP, but sanitizing at rest is
		// defense in depth so a cached file can never be a stored-XSS payload.
		const clean = Buffer.from(sanitizeSvg(buf.toString('utf-8')), 'utf-8');
		atomicWrite(path, clean);
		return clean;
	} catch {
		// Network error / timeout: tombstone with a TTL so we back off instead of
		// re-running an 8s-timeout fetch on every remount of the row.
		tombstone();
		return null;
	}
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
