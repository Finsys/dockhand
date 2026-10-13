/**
 * backups/locks.ts — the TWO kinds of exclusion the backup domain needs. They
 * guard different things and must not be collapsed into one:
 *
 *  1. LIVE-TARGET MUTEX (reject). Two operations that touch the same live data
 *     (a volume/bind) must never overlap — a backup reading a volume while a
 *     restore rewrites it produces a torn snapshot reported as success. There is
 *     no safe way to "wait and run"; the second operation is REJECTED. Keyed on
 *     the underlying data (env + the volume/bind identity), not the container
 *     name, so two containers sharing a volume under different names still
 *     exclude each other.
 *
 *  2. PER-DESTINATION SERIALIZATION (queue). Two operations on the same restic
 *     repository must not run restic concurrently (restic locks the repo). This
 *     is benign to WAIT on, so operations SERIALIZE behind a per-destination
 *     promise chain rather than being rejected.
 *
 * The key-building and "is it held" decisions are pure functions so they can be
 * unit-tested directly; the module also holds the small in-memory state.
 */

import { KeyedSerializer } from '../keyed-serializer';

/**
 * Build the live-target lock key from the env and the set of data paths the
 * operation touches. Callers pass the docker bind strings they will use
 * (`<source>:/volumes/<key>:ro` for a backup, `<source>:/volumes/<key>:rw` for a
 * restore). The lock must key on the STABLE DATA IDENTITY — the same for a backup
 * and a restore of the same live volume — so it is normalized to just the SOURCE
 * (the volume name or absolute host path, the part before the first `:`),
 * dropping the container mount-point and the `:ro`/`:rw`/`:z`/`:Z` mode suffix.
 * Otherwise a backup (`:ro`) and a restore (`:rw`) of the same data would produce
 * different keys, fail to collide, and run concurrently — a torn snapshot
 * reported as success.
 */
export function liveTargetKey(envId: number | null | undefined, dataPaths: string[], fallbackIdentity?: string): string {
	const env = envId ?? 'local';
	const sources = dataPaths.map(bindSource).filter(Boolean).sort();
	// Config-only targets (no named volumes, no binds) have NO data sources, so keying on
	// sources alone makes every such target on the same env collide (`${env}::`), and the
	// REJECT lock silently skips all but one - two disjoint config-only backups in one cron
	// window lose one every run. Fall back to a per-target identity ONLY when there are no
	// sources, so disjoint config-only targets don't alias. Targets that DO share data still
	// key on the data identity (a backup:ro and restore:rw of the same volume must collide).
	if (sources.length === 0 && fallbackIdentity) {
		return `${env}::config:${fallbackIdentity}`;
	}
	return `${env}::${sources.join('|')}`;
}

/**
 * Reduce a bind string to its stable source identity. From
 * `<source>:/volumes/<key>:ro` take `<source>`; a bare source or volume name is
 * returned as-is (minus any trailing mode suffix). The source may itself contain
 * a `:` only if it's a windows path, which docker binds don't use here, so the
 * part before the FIRST `:` is the source.
 */
function bindSource(dataPath: string): string {
	const trimmed = dataPath.trim().replace(/:(ro|rw|z|Z)$/, '');
	if (!trimmed) return '';
	const colon = trimmed.indexOf(':');
	return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * The live-target registry: a set of keys currently held. `tryAcquire` returns a
 * release function on success, or null if the key is already held (the caller
 * then rejects its operation). This is intentionally a REJECT lock, not a queue.
 */
export class LiveTargetLocks {
	private held = new Set<string>();

	/** Attempt to claim a key. Returns a release fn, or null if already held. */
	tryAcquire(key: string): (() => void) | null {
		if (this.held.has(key)) return null;
		this.held.add(key);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.held.delete(key);
		};
	}

	/** Whether a key is currently held (for tests / diagnostics). */
	isHeld(key: string): boolean {
		return this.held.has(key);
	}

	/** Number of held keys (for the startup-only assertion in recovery). */
	get size(): number {
		return this.held.size;
	}
}

/**
 * Per-destination serialization: operations on the same restic REPOSITORY run
 * one at a time, in arrival order. The key is the repository rather than the
 * destination id, because the restic lock is per-repo: two different destination
 * rows pointing at the same repo must serialize together or they collide on that
 * lock (a backup then waits out `--retry-lock`, ~5-10 min).
 *
 * The queueing itself is the shared KeyedSerializer.
 */
export class DestinationSerializer extends KeyedSerializer {}
