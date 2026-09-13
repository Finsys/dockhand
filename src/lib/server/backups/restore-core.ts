/**
 * backups/restore-core.ts — the PURE mapping an in-place restore needs to bind
 * each snapshot volume back to its ORIGINAL live location. No docker, no DB, so
 * it is unit-testable directly.
 *
 * A snapshot stores each captured volume's data under `/volumes/<key>`. To
 * restore in place we must bind the live target back at that same path, writing
 * (`:rw`):
 *   - named volume → `<volumeName>:/volumes/<key>:rw`  (source is the volume name)
 *   - bind mount   → `<absoluteHostPath>:/volumes/<key>:rw` (source is the host path)
 *
 * The critical safety property: a bind's source MUST be the absolute host path.
 * A non-absolute docker source auto-creates a fresh NAMED volume, so restoring a
 * bind into a slug would silently write to an orphan volume and never touch the
 * real host path — data loss reported as success. So when we cannot recover the
 * true source for a bind key, we FAIL LOUD rather than fall back to the slug.
 */
import { BackupError } from './models';
import { safeKey, volumeInclude, volumeBind } from './discovery-core';
import type { SnapshotLayout, SnapshotVolume } from './snapshot-layout';

export { volumeInclude, volumeBind };

/** One volume entry as stored in a snapshot (the typed contract, not a parallel copy - so
 * a SnapshotVolume field rename is a compile error here too, not a silent undefined). */
export type StoredVolume = SnapshotVolume;

/** A docker mount as recorded in a snapshot's container inspect (Mounts[]). */
interface StoredMount {
	Type?: string;
	Name?: string;
	Source?: string;
	Destination?: string;
}

/** The snapshot metadata this mapping reads. `volumes` is intentionally `unknown`: this is
 * the boundary that reads BOTH the typed SnapshotVolume[] (current) AND legacy string[]
 * name/destination entries (pre-enrichment snapshots), narrowing each defensively. A
 * SnapshotLayout is assignable here (its volumes: SnapshotVolume[] widens to unknown).
 * `container` stays unknown (opaque inspect JSON); mountSource narrows it. */
export interface SnapshotMetadata {
	volumes?: unknown;
	container?: unknown;
}

/** A `<source>:/volumes/<key>:rw` bind + its `/volumes/<key>` include. `type` and
 * `source` describe the ORIGINAL location, used to pre-fill a clone's default
 * destination (named volume → its name; bind → its absolute host path). */
export interface VolumeBind {
	bind: string;
	include: string;
	source: string;
	type: 'volume' | 'bind';
}

/** Build the rw bind for a resolved source + key. */
function bindFor(source: string, key: string, type: 'volume' | 'bind'): VolumeBind {
	return { bind: volumeBind(source, key, 'rw'), include: volumeInclude(key), source, type };
}

/**
 * Resolve the in-place restore bind for one snapshot volume `key` from the
 * snapshot metadata. Order of recovery:
 *   1. the enriched `volumes[]` entry whose key matches → use its stored
 *      type + source (a bind's source is asserted absolute);
 *   2. the stored docker inspect `container.Mounts` (bind: safeKey(Destination)
 *      matches → its Source; volume: Name matches → its Name);
 *   3. a key that is a NAMED VOLUME (key === its own name) binds directly.
 *
 * For a BIND key whose absolute source can't be recovered we THROW rather than
 * default to the slug (docker would turn the slug into an orphan named volume —
 * silent data loss).
 */
export function resolveBindFromMetadata(metadata: SnapshotMetadata | null, key: string): VolumeBind {
	// 1. enriched volumes[] entry (the normal path once metadata carries type/source).
	const entry = enrichedVolume(metadata, key);
	if (entry) {
		if (entry.type === 'bind' && !entry.source.startsWith('/')) throw bindSourceError(key);
		return bindFor(entry.source, key, entry.type);
	}

	// 2. recover from the stored docker inspect Mounts (older snapshots, or the
	// container inspect path).
	const fromMounts = mountSource(metadata, key);
	if (fromMounts) {
		if (fromMounts.type === 'bind' && !fromMounts.source.startsWith('/')) throw bindSourceError(key);
		return bindFor(fromMounts.source, key, fromMounts.type);
	}

	// 3. Named-volume fallback. Discovery keys a named volume on its own volume
	// name, so key === name and binding `<key>:/volumes/<key>:rw` is correct and
	// unambiguous. But if the metadata knows this key is a BIND (legacy string
	// list of destinations, or an inspect bind we couldn't source), we must NOT
	// slug-bind it — that's the data-loss path. So only take this fallback when
	// nothing in the metadata identifies the key as a bind.
	if (!keyIsKnownBind(metadata, key)) return bindFor(key, key, 'volume');

	throw bindSourceError(key);
}

/** Find the enriched volumes[] entry for a key, if present and well-formed. */
function enrichedVolume(metadata: SnapshotMetadata | null, key: string): StoredVolume | null {
	const vols = metadata?.volumes;
	if (!Array.isArray(vols)) return null;
	for (const v of vols) {
		const sv = v as StoredVolume;
		if (v && typeof v === 'object' && sv.key === key && typeof sv.source === 'string'
			&& (sv.type === 'bind' || sv.type === 'volume')) {
			return sv;
		}
	}
	return null;
}

/** Recover a source from the stored docker inspect Mounts for a key. */
function mountSource(metadata: SnapshotMetadata | null, key: string): { source: string; type: 'bind' | 'volume' } | null {
	const c = metadata?.container as { Mounts?: StoredMount[] } | null | undefined;
	const mounts = c?.Mounts;
	if (!Array.isArray(mounts)) return null;
	for (const m of mounts) {
		if (m?.Type === 'volume' && m.Name && m.Name === key) return { source: m.Name, type: 'volume' };
		if (m?.Type === 'bind' && m.Source && m.Destination && safeKey(m.Destination) === key) {
			return { source: m.Source, type: 'bind' };
		}
	}
	return null;
}

/**
 * Whether the metadata identifies this key as a BIND we could not source. A
 * legacy pre-enrichment `volumes` was `string[]` of names/destinations: a named
 * volume's name equals its key, but a bind's destination slugs to the key. So if
 * a legacy string entry is NOT equal to the key yet slugs to it, the key is a
 * bind whose absolute source is unknown — refuse. Likewise an inspect Mount that
 * is a bind for this key (already tried in mountSource and returned null only if
 * it had no Source) marks it a bind.
 */
function keyIsKnownBind(metadata: SnapshotMetadata | null, key: string): boolean {
	const vols = metadata?.volumes;
	if (Array.isArray(vols)) {
		for (const v of vols) {
			// Legacy string entry: a destination path that slugs to this key but is
			// not itself the key ⇒ it's a bind, and we have no source for it.
			if (typeof v === 'string' && v !== key && safeKey(v) === key) return true;
			// Enriched entry flagged bind for this key (source was non-absolute/missing).
			const sv = v as StoredVolume;
			if (v && typeof v === 'object' && sv.key === key && sv.type === 'bind') return true;
		}
	}
	const c = metadata?.container as { Mounts?: StoredMount[] } | null | undefined;
	const mounts = c?.Mounts;
	if (Array.isArray(mounts)) {
		for (const m of mounts) {
			if (m?.Type === 'bind' && m.Destination && safeKey(m.Destination) === key) return true;
		}
	}
	return false;
}

function bindSourceError(key: string): BackupError {
	return new BackupError(
		'VALIDATION',
		`cannot resolve the original location for volume '${key}' from the snapshot metadata; restore aborted to avoid writing to the wrong place`,
	);
}
