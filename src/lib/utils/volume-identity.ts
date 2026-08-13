// Shared volume identity for the backup feature: ONE place that decides how a container mount
// becomes (a) the identity two mounts share when they are the same volume (dedup key) and (b) the
// restic `/volumes/<key>` storage key. Server discovery (discovery-core.ts) and the client picker
// (utils/mounts.ts) both import this so they compute identity the same way. Dependency-free so
// it's safe in the browser bundle. (#1373)

export interface MountIdentity {
	type: 'volume' | 'bind';
	/** volume name (for a volume) or absolute host path (for a bind). */
	source: string;
	/** container path the mount is mounted at. */
	destination: string;
	/** volume name (volumes only). */
	name?: string;
}

/**
 * The identity two mounts share when they are the SAME volume, so a shared volume mounted by
 * several containers is captured once. A named volume is identified by its name; a bind by its
 * (source, destination) pair - two binds to the same destination from DIFFERENT sources are
 * DIFFERENT volumes and must both survive (that is #1373). Mirrors discovery's original
 * `seenVolumeNames` + `pairKey` (`Source\nDestination`) exactly.
 */
export function volumeDedupKey(m: MountIdentity): string {
	if (m.type === 'volume') return `vol:${m.name ?? m.source}`;
	return `bind:${m.source}\n${m.destination}`;
}

/** Slug an arbitrary path segment into the `/volumes/` key charset. */
function slug(s: string): string {
	return s.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Segments of a host path that carry no identity on their own - dropping them keeps the
 * meaningful tail (e.g. `.../gitea/data` -> `gitea_data`, not `data`). */
const GENERIC_SEGMENTS = new Set(['', 'data', 'config', 'conf', 'mnt', 'srv', 'var', 'opt', 'home', 'volumes', 'appdata']);

/** The last 1-2 meaningful segments of a bind's host source, so two binds to the same container
 * path get distinguishable keys. `/mnt/cache/appdata/gitea/data` -> `gitea_data`. */
function sourceTail(source: string): string {
	const parts = source.split('/').filter(Boolean);
	if (parts.length === 0) return 'bind';
	const last = parts[parts.length - 1];
	const prev = parts[parts.length - 2];
	// If the last segment is generic (data/config/...), qualify it with its parent dir.
	if (prev && GENERIC_SEGMENTS.has(last.toLowerCase())) return slug(`${prev}_${last}`);
	return slug(last);
}

/**
 * The restic `/volumes/<key>` storage key for a mount, collision-suffixed against `taken` so two
 * mounts never share a key (restic would overwrite one with the other). Named volumes key on
 * their name (stable, restore knows it). Binds key on `<destination-slug>__<source-tail>` so two
 * containers binding different host paths to the same container path get distinct, readable keys
 * (#1373: `/data` from gitea vs gitea-runner -> `data__gitea_data` / `data__gitea-runner_data`).
 */
export function volumeStorageKey(m: MountIdentity, taken: Set<string> = new Set()): string {
	if (m.type === 'volume') return safeKey(m.name ?? m.source, taken);
	const base = `${slug(m.destination) || 'bind'}__${sourceTail(m.source)}`;
	return safeKey(base, taken);
}

/** Make a base string into a safe `/volumes/` key. Non-safe chars become `_`; a collision gets a
 * short numeric suffix so two mounts never map to the same key. Moved here from discovery-core so
 * capture and the UI share ONE key allocator; discovery-core re-exports it for existing callers. */
export function safeKey(base: string, taken: Set<string> = new Set()): string {
	let key = base.replace(/^\//, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'bind';
	if (!taken.has(key)) { taken.add(key); return key; }
	let i = 2;
	while (taken.has(`${key}_${i}`)) i++;
	const out = `${key}_${i}`;
	taken.add(out);
	return out;
}
