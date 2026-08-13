/**
 * Canonical "Docker mounts -> pickable volume list" for the backup UI — the single
 * source of truth, so the surfaces that use it can't drift. Dependency-free so it's
 * unit-testable under `bun test`.
 */

import { isUnbackupableBindSource } from './unbackupable-mounts';
import { volumeDedupKey, volumeStorageKey } from './volume-identity';

export interface VolumeInfo {
	/** The volume's identity: the restic `/volumes/<key>` key, computed the same way capture does
	 *  (utils/volume-identity). Selection and dedup key on this, not on `name` - two binds sharing
	 *  a container destination have the same `name` but different `key` (#1373). */
	key: string;
	name: string;
	mountPoint: string;
	mountType: 'volume' | 'bind';
	/** Bind mounts only: the host source path, shown as the picker's disambiguator. */
	source?: string;
	/** Bind mounts only: true when the host source is a socket or host system path
	 *  the backup engine refuses to capture. Shown in the picker but not selectable,
	 *  and excluded from "backup all" — mirrors the engine's isUnbackupableBindSource. */
	unbackupable?: boolean;
}

/** A raw Docker mount as returned by the containers API (list or inspect).
 *  Both lowercase (our normalized) and PascalCase (raw Docker) keys are
 *  tolerated because callers pass either shape. */
interface RawMount {
	type?: string;
	Type?: string;
	name?: string;
	Name?: string;
	source?: string;
	Source?: string;
	destination?: string;
	Destination?: string;
}

/** Docker's Binds are `hostPath:containerPath[:mode]`; a named volume's
 *  "hostPath" is the volume NAME (no leading slash), a bind mount's is an
 *  absolute host path. This is the standard heuristic Docker itself uses. */
export function mountTypeFromHostPath(hostPath: string): 'volume' | 'bind' {
	return hostPath.startsWith('/') ? 'bind' : 'volume';
}

/**
 * A parsed bind entry (`hostPath:containerPath`) -> pickable VolumeInfo. `name` is the display
 * value (container destination for a bind); `key` is the restic identity from volume-identity.
 * `taken` threads the key allocator so a caller merging several sources can't hand out a
 * duplicate key.
 */
export function volumeInfoFromBind(bind: { hostPath: string; containerPath: string }, taken: Set<string> = new Set()): VolumeInfo {
	const mountType = mountTypeFromHostPath(bind.hostPath);
	const key = volumeStorageKey(
		mountType === 'bind'
			? { type: 'bind', source: bind.hostPath, destination: bind.containerPath }
			: { type: 'volume', source: bind.hostPath, destination: bind.containerPath, name: bind.hostPath },
		taken
	);
	return {
		key,
		name: mountType === 'bind' ? bind.containerPath : bind.hostPath,
		mountPoint: bind.containerPath,
		mountType,
		source: mountType === 'bind' ? bind.hostPath : undefined,
		unbackupable: mountType === 'bind' ? isUnbackupableBindSource(bind.hostPath) || undefined : undefined
	};
}

/**
 * Normalize a container's raw Docker mounts into the pickable volume list. Keeps only `volume`
 * and `bind` mounts (skips tmpfs/npipe/etc.). `key` is the restic identity (volume-identity),
 * allocated against `taken` so a stack merge across containers can share one allocator; `name`
 * is display only (bind destination). Pass a shared `taken` when merging multiple containers.
 */
export function normalizeMounts(mounts: RawMount[] | null | undefined, taken: Set<string> = new Set()): VolumeInfo[] {
	if (!Array.isArray(mounts)) return [];
	const out: VolumeInfo[] = [];
	for (const m of mounts) {
		const type = m.type || m.Type;
		if (type !== 'volume' && type !== 'bind') continue;
		const destination = m.destination || m.Destination || '';
		const source = m.source || m.Source || '';
		if (type === 'bind') {
			const key = volumeStorageKey({ type: 'bind', source, destination }, taken);
			out.push({ key, name: destination || source, mountPoint: destination, mountType: 'bind', source: source || undefined, unbackupable: isUnbackupableBindSource(source) || undefined });
		} else {
			const name = m.name || m.Name || source || destination || '';
			const key = volumeStorageKey({ type: 'volume', source: name, destination, name }, taken);
			out.push({ key, name, mountPoint: destination, mountType: 'volume' });
		}
	}
	return out;
}

/**
 * Merge the mounts of every container in a compose project into one volume list, deduped by
 * volume IDENTITY (not display name) so two containers binding different host paths to the same
 * container path both survive (#1373). Keys are allocated in ONE pass with a shared `taken` set,
 * mirroring the backend discoverVolumesFromMounts so the two can't hand out divergent keys.
 */
export function normalizeStackMounts(
	containers: Array<{ mounts?: RawMount[]; Mounts?: RawMount[] }>
): VolumeInfo[] {
	const seen = new Set<string>();
	const taken = new Set<string>();
	const out: VolumeInfo[] = [];
	for (const c of containers) {
		for (const m of c.mounts || c.Mounts || []) {
			const type = m.type || m.Type;
			if (type !== 'volume' && type !== 'bind') continue;
			const destination = m.destination || m.Destination || '';
			const source = m.source || m.Source || '';
			const name = type === 'volume' ? (m.name || m.Name || source || destination || '') : (destination || source);
			const dedup = volumeDedupKey(type === 'volume' ? { type, source: name, destination, name } : { type: 'bind', source, destination });
			if (seen.has(dedup)) continue;
			seen.add(dedup);
			const [v] = normalizeMounts([m], taken);
			if (v) out.push(v);
		}
	}
	return out;
}

/**
 * Map a saved config's stored selection to the current volume list's keys, so the picker checks
 * the right boxes. A stored entry may be a key or a name; match by key first, then by unique name.
 * A name matching several volumes (two binds sharing a destination) is ambiguous and dropped - the
 * user re-picks it. (#1373)
 */
export function reconcileSelectedVolumeKeys(volumes: Array<{ key: string; name: string }>, stored: string[]): string[] {
	const byKey = new Set(volumes.map((v) => v.key));
	const out: string[] = [];
	for (const sel of stored) {
		if (byKey.has(sel)) { out.push(sel); continue; }
		const named = volumes.filter((v) => v.name === sel);
		if (named.length === 1) out.push(named[0].key);
	}
	return out;
}

/** The compose-project label that groups containers into a stack. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** A raw container as returned by the /api/containers list endpoint. Tolerates
 *  the Docker-raw fallback keys (`Mounts`, `Names`) the same way the mount
 *  normalizers do, so callers can pass either shape. */
export interface RawContainer {
	name?: string;
	Names?: string[];
	labels?: Record<string, string | undefined>;
	Labels?: Record<string, string | undefined>;
	mounts?: RawMount[];
	Mounts?: RawMount[];
}

/** A pickable backup target: a stack (mounts of all its containers, merged) or
 *  a standalone container. */
export interface BackupItem {
	name: string;
	type: 'stack' | 'container';
	volumes: VolumeInfo[];
}

function containerName(c: RawContainer): string {
	return c.name || c.Names?.[0]?.replace(/^\//, '') || '';
}

function composeProject(c: RawContainer): string | undefined {
	const labels = c.labels || c.Labels;
	return labels?.[COMPOSE_PROJECT_LABEL];
}

/**
 * Partition a /api/containers list into stack items (grouped by compose-project label,
 * mounts merged+deduped) and standalone containers; stacks first, then containers,
 * each alphabetical. Deriving stacks from labels misses stopped stacks — most
 * backup surfaces prefer /api/stacks + {@link standaloneContainers}; this is for
 * callers that only have a container list.
 */
export function groupContainersForBackup(containers: RawContainer[] | null | undefined): BackupItem[] {
	if (!Array.isArray(containers)) return [];
	const stackContainers = new Map<string, RawContainer[]>();
	const standalone: BackupItem[] = [];
	for (const c of containers) {
		const project = composeProject(c);
		if (project) {
			const existing = stackContainers.get(project) || [];
			existing.push(c);
			stackContainers.set(project, existing);
		} else {
			standalone.push({ name: containerName(c), type: 'container', volumes: normalizeMounts(c.mounts || c.Mounts) });
		}
	}
	return [
		...[...stackContainers.entries()].map(([name, cs]): BackupItem => ({
			name,
			type: 'stack',
			volumes: normalizeStackMounts(cs)
		})),
		...standalone
	].sort((a, b) => {
		if (a.type !== b.type) return a.type === 'stack' ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/**
 * Volumes for ONE stack: the stack slice of {@link groupContainersForBackup}.
 * Returns [] if the stack has no containers (stopped / not-yet-deployed) — that
 * is now the ONLY path that can legitimately produce an empty picker.
 */
export function volumesForStack(
	containers: RawContainer[] | null | undefined,
	stackName: string
): VolumeInfo[] {
	if (!Array.isArray(containers)) return [];
	const mine = containers.filter((c) => composeProject(c) === stackName);
	return normalizeStackMounts(mine);
}

/**
 * Standalone containers (no compose-project label) of a /api/containers list, as
 * backup items, sorted alphabetically. Pairs with stacks from /api/stacks (which,
 * unlike label-grouping, sees stopped stacks and their sourceType).
 */
export function standaloneContainers(
	containers: RawContainer[] | null | undefined
): BackupItem[] {
	if (!Array.isArray(containers)) return [];
	return containers
		.filter((c) => !composeProject(c))
		.map((c): BackupItem => ({
			name: containerName(c),
			type: 'container',
			volumes: normalizeMounts(c.mounts || c.Mounts)
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
