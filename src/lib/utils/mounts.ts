/**
 * Canonical "Docker mounts -> pickable volume list" for the backup UI — the single
 * source of truth, so the surfaces that use it can't drift. Dependency-free so it's
 * unit-testable under `bun test`.
 */

export interface VolumeInfo {
	name: string;
	mountPoint: string;
	mountType: 'volume' | 'bind';
	/** Bind mounts only: the host source path, for display (name is the container
	 *  destination so it matches the backup engine's filter). */
	source?: string;
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
 * A parsed bind entry (`hostPath:containerPath`) -> pickable VolumeInfo. `name` MUST
 * match what the backup engine discovers (named volume -> its name/hostPath, bind ->
 * its container destination), else the selectedVolumes filter drops it silently.
 */
export function volumeInfoFromBind(bind: { hostPath: string; containerPath: string }): VolumeInfo {
	const mountType = mountTypeFromHostPath(bind.hostPath);
	return {
		name: mountType === 'bind' ? bind.containerPath : bind.hostPath,
		mountPoint: bind.containerPath,
		mountType
	};
}

/**
 * Normalize a container's raw Docker mounts into the pickable volume list.
 * Keeps only `volume` and `bind` mounts (skips tmpfs/npipe/etc.). `name` MUST
 * equal what the backup engine discovers (named volume -> its name, bind -> its
 * container destination), else the selectedVolumes filter drops it silently; the
 * host source is kept separately in `source` for display only.
 */
export function normalizeMounts(mounts: RawMount[] | null | undefined): VolumeInfo[] {
	if (!Array.isArray(mounts)) return [];
	const out: VolumeInfo[] = [];
	for (const m of mounts) {
		const type = m.type || m.Type;
		if (type !== 'volume' && type !== 'bind') continue;
		const destination = m.destination || m.Destination || '';
		const source = m.source || m.Source || '';
		if (type === 'bind') {
			out.push({ name: destination || source, mountPoint: destination, mountType: 'bind', source: source || undefined });
		} else {
			const name = m.name || m.Name || source || destination || '';
			out.push({ name, mountPoint: destination, mountType: 'volume' });
		}
	}
	return out;
}

/**
 * Merge the mounts of every container in a compose project into one deduped
 * volume list (by display name). Used for stack-level backup pickers.
 */
export function normalizeStackMounts(
	containers: Array<{ mounts?: RawMount[]; Mounts?: RawMount[] }>
): VolumeInfo[] {
	const seen = new Set<string>();
	const out: VolumeInfo[] = [];
	for (const c of containers) {
		for (const v of normalizeMounts(c.mounts || c.Mounts)) {
			if (v.name && !seen.has(v.name)) {
				seen.add(v.name);
				out.push(v);
			}
		}
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
