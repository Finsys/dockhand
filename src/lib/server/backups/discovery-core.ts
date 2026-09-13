/**
 * backups/discovery-core.ts — the PURE logic that turns a set of container
 * mounts into the volume binds + names a backup will capture. No docker, no DB,
 * so it is unit-testable directly; the docker-calling orchestration lives in
 * ./docker.
 *
 * A backup mounts each volume/bind READ-ONLY into the helper at `/volumes/<key>`
 * and runs `restic backup /volumes/`. This module decides the `<key>` and the
 * bind string for each mount, and reports anything it can't back up.
 *
 * Only `volume` and `bind` mounts are backed up. tmpfs / npipe / cluster and any
 * future mount type are SKIPPED (reported, not silently dropped) — a backup that
 * quietly omits data is exactly the failure mode we refuse.
 */

import { isUnbackupableBindSource } from '../../utils/unbackupable-mounts';
import { safeKey, volumeDedupKey, volumeStorageKey } from '../../utils/volume-identity';

// Capture and the UI picker share ONE key allocator (utils/volume-identity) so they can't drift.
// Re-exported so server callers (restore-core.ts) import safeKey from here.
export { safeKey };

/** The `/volumes/<key>` mount point a captured/restored volume rides on. ONE definition of the
 * mount-point contract so backup capture (ro), restore (rw), and the preview can't drift on it. */
export function volumeInclude(key: string): string {
	return `/volumes/${key}`;
}

/** The `<source>:/volumes/<key>:<mode>` helper bind string. Backup capture uses `ro`, restore `rw`. */
export function volumeBind(source: string, key: string, mode: 'ro' | 'rw'): string {
	return `${source}:${volumeInclude(key)}:${mode}`;
}

/** A single mount as returned by a container inspect (the fields we use). */
export interface Mount {
	Type: string;
	Name?: string;
	Source?: string;
	Destination?: string;
}

/** A discovered volume/bind to capture. `bind` is the docker bind string
 * (`<src>:/volumes/<key>:ro`); `name` is the human/restore identity. */
export interface DiscoveredVolume {
	/** The restore-side key under /volumes/ (a safe name). */
	key: string;
	/** The docker `:ro` bind string for the helper. */
	bind: string;
	/** Restore identity: the volume name, or the bind's container destination. */
	name: string;
	/** Whether this capture is a named volume or a host bind mount. */
	type: 'volume' | 'bind';
	/** The docker bind SOURCE — the volume name (for a volume) or the absolute
	 * host path (for a bind). This is what an in-place restore must bind back to;
	 * for a bind it is NOT the slugged key. */
	source: string;
}

/** A mount that was skipped, with the reason (surfaced to the run log). */
export interface SkippedMount {
	type: string;
	destination: string;
	reason: string;
}

export interface DiscoveryResult {
	volumes: DiscoveredVolume[];
	skipped: SkippedMount[];
}

const SUPPORTED = new Set(['volume', 'bind']);

/**
 * Turn a list of containers' mounts into the volumes to back up. Named volumes
 * key on their volume name (stable, restore knows it); binds key on a
 * sanitized destination path. Duplicate named volumes and identical
 * (source,destination) bind pairs are de-duplicated so a shared volume is
 * captured once.
 */
export function discoverVolumesFromMounts(containers: Array<{ name: string; mounts: Mount[] }>): DiscoveryResult {
	const volumes: DiscoveredVolume[] = [];
	const skipped: SkippedMount[] = [];
	const seen = new Set<string>();      // a volume shared across containers is captured once
	const takenKeys = new Set<string>(); // no two captures share a /volumes/<key>

	for (const container of containers) {
		for (const mount of container.mounts) {
			if (!SUPPORTED.has(mount.Type)) {
				skipped.push({
					type: mount.Type || '(unknown)',
					destination: mount.Destination ?? '',
					reason: `${mount.Type || 'unknown'} mounts are not backed up`,
				});
				continue;
			}

			if (mount.Type === 'volume' && mount.Name) {
				const dedup = volumeDedupKey({ type: 'volume', source: mount.Name, destination: mount.Destination ?? '', name: mount.Name });
				if (seen.has(dedup)) continue;
				seen.add(dedup);
				// Named volumes key on their name; volumeStorageKey routes it through the shared
				// allocator so it can't collide with a bind whose slug equals the volume name.
				const key = volumeStorageKey({ type: 'volume', source: mount.Name, destination: mount.Destination ?? '', name: mount.Name }, takenKeys);
				volumes.push({
					key,
					bind: volumeBind(mount.Name, key, 'ro'),
					name: mount.Name,
					type: 'volume',
					source: mount.Name,
				});
			} else if (mount.Type === 'bind' && mount.Source && mount.Destination) {
				if (isUnbackupableBindSource(mount.Source)) {
					skipped.push({
						type: 'bind',
						destination: mount.Destination,
						reason: `${mount.Source} is a socket or host system path, not backed up`,
					});
					continue;
				}
				// Two binds to the same destination from DIFFERENT sources are different volumes
				// and both survive (#1373); only an identical (source,destination) is deduped.
				const dedup = volumeDedupKey({ type: 'bind', source: mount.Source, destination: mount.Destination });
				if (seen.has(dedup)) continue;
				seen.add(dedup);
				const key = volumeStorageKey({ type: 'bind', source: mount.Source, destination: mount.Destination }, takenKeys);
				volumes.push({
					key,
					bind: volumeBind(mount.Source, key, 'ro'),
					name: mount.Destination,
					type: 'bind',
					source: mount.Source,
				});
			}
			// A volume mount with no Name, or a bind with no Source/Destination, is
			// malformed inspect data — skip silently (nothing to capture).
		}
	}

	return { volumes, skipped };
}

/**
 * Apply a volume-selection filter (config.selectedVolumes). A selected entry
 * matches a discovered volume by its `name` (volume name or bind destination).
 * An empty selection means "back up nothing" and returns an empty list.
 */
export function filterSelectedVolumes(all: DiscoveredVolume[], selected: string[] | null): DiscoveredVolume[] {
	if (selected === null) return all; // no filter = all volumes
	const wanted = new Set(selected);
	return all.filter((v) => wanted.has(v.name) || wanted.has(v.key));
}

/** Inspect a container's mounts. Injected so discovery is testable without a
 * real docker daemon (the production impl lives in ./docker). */
export type InspectMounts = (id: string, envId: number | null | undefined) => Promise<Mount[]>;

/** Thrown when a target container can't be inspected — a data-safety abort, not
 * a transient warning: proceeding would take a partial backup. */
export class DiscoveryInspectError extends Error {
	constructor(readonly container: string, cause: string) {
		super(`Could not inspect container "${container}" during volume discovery: ${cause}. Refusing to take a partial backup that could omit its volumes.`);
		this.name = 'DiscoveryInspectError';
	}
}

/**
 * Inspect every target container and discover the volumes to back up.
 *
 * FAIL CLOSED: if ANY target container fails to inspect, throw
 * DiscoveryInspectError. A partial discovery would produce a snapshot missing
 * that container's volumes which, recorded as success, could let retention prune
 * the older COMPLETE snapshots — unrecoverable data loss presented as a healthy
 * backup. So an inspect failure aborts the whole backup rather than dropping data.
 */
export async function discoverVolumes(
	containers: Array<{ id: string; name: string }>,
	envId: number | null | undefined,
	selectedVolumes: string[] | null,
	inspect: InspectMounts,
): Promise<DiscoveryResult> {
	const withMounts: Array<{ name: string; mounts: Mount[] }> = [];
	for (const c of containers) {
		let mounts: Mount[];
		try {
			mounts = await inspect(c.id, envId);
		} catch (err) {
			throw new DiscoveryInspectError(c.name, err instanceof Error ? err.message : String(err));
		}
		withMounts.push({ name: c.name, mounts });
	}
	const result = discoverVolumesFromMounts(withMounts);
	return { volumes: filterSelectedVolumes(result.volumes, selectedVolumes), skipped: result.skipped };
}
