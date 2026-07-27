/**
 * backups/docker.ts — the Docker-facing side of backup/restore: find the target
 * container(s), discover the volumes to capture, and stop/restart the target
 * around a backup safely. The pure mount→bind mapping lives in ./discovery-core;
 * this module makes the docker calls and composes it.
 */
import { listContainers, inspectContainer } from '../docker';
import { stopContainer, startContainer } from '../docker';
import { stopStack, startStack } from '../stacks';
import { BackupError, type BackupTargetType } from './models';
import {
	discoverVolumes as discoverVolumesCore,
	DiscoveryInspectError,
	type Mount,
	type DiscoveredVolume,
	type SkippedMount,
} from './discovery-core';

/** The containers a config targets, resolved from docker. */
export interface TargetContainers {
	/** Running + stopped members. Empty ⇒ nothing to back up (caller fails). */
	containers: Array<{ id: string; name: string; state: string }>;
}

/**
 * Resolve the container(s) a config targets. A `container` config matches by
 * name; a `stack` config matches every container carrying the compose-project
 * label. Returns whatever exists (may be empty — the caller decides that a
 * missing target is a failure, since an empty backup could let retention prune
 * good snapshots).
 */
export async function resolveTargets(
	type: BackupTargetType,
	targetName: string,
	envId: number | null | undefined
): Promise<TargetContainers> {
	const all = await listContainers(true, envId ?? undefined);
	let matched: typeof all;
	if (type === 'container') {
		matched = all.filter((c) => c.name === targetName);
	} else {
		matched = all.filter((c) => c.labels?.['com.docker.compose.project'] === targetName);
	}
	return { containers: matched.map((c) => ({ id: c.id, name: c.name, state: c.state })) };
}

export interface Discovered {
	volumes: DiscoveredVolume[];
	skipped: SkippedMount[];
}

/** The production mount inspector: a real container inspect. */
const realInspectMounts = async (id: string, envId: number | null | undefined): Promise<Mount[]> => {
	const data = await inspectContainer(id, envId ?? undefined);
	return (data.Mounts ?? []) as Mount[];
};

/**
 * Inspect every target container and discover the volumes to back up. Fail
 * closed on any inspect failure (see discovery-core.discoverVolumes). Wraps the
 * discovery error as a DOCKER BackupError for uniform handling by the service.
 */
export async function discoverVolumes(
	containers: Array<{ id: string; name: string }>,
	envId: number | null | undefined,
	selectedVolumes: string[] | null,
): Promise<Discovered> {
	try {
		return await discoverVolumesCore(containers, envId, selectedVolumes, realInspectMounts);
	} catch (err) {
		if (err instanceof DiscoveryInspectError) {
			throw new BackupError('DOCKER', err.message, { container: err.container });
		}
		throw err;
	}
}

/**
 * A closure that restarts whatever this stop actually stopped. Returned by
 * `stopForBackup` so the caller can register the restart in a `finally` the
 * instant it stops the target — the restart is bound to the same scope as the
 * stop, so no error path can skip it. Returns the list of members that failed to
 * restart (empty = all good) rather than throwing, so the caller can surface a
 * "service still down" warning without losing the rest of the flow.
 */
export type RestartFn = () => Promise<{ failed: Array<{ name: string; error: string }> }>;

/**
 * Stop the target for a consistent backup (only if it is running) and return a
 * closure that restarts exactly what was stopped. A no-op (empty restart) if the
 * target isn't running. Never throws for a restart concern — the restart closure
 * reports failures as data.
 */
export async function stopForBackup(
	type: BackupTargetType,
	targetName: string,
	containers: Array<{ id: string; name: string; state: string }>,
	envId: number | null | undefined,
): Promise<{ restart: RestartFn }> {
	const noop: RestartFn = async () => ({ failed: [] });

	if (type === 'stack') {
		const anyRunning = containers.some((c) => c.state === 'running');
		if (!anyRunning) return { restart: noop };
		await stopStack(targetName, envId ?? undefined);
		return {
			restart: async () => {
				try {
					await startStack(targetName, envId ?? undefined);
					return { failed: [] };
				} catch (err) {
					return { failed: [{ name: targetName, error: err instanceof Error ? err.message : String(err) }] };
				}
			},
		};
	}

	// container
	const running = containers.filter((c) => c.state === 'running');
	if (running.length === 0) return { restart: noop };
	for (const c of running) await stopContainer(c.id, envId ?? undefined);
	return {
		restart: async () => {
			const failed: Array<{ name: string; error: string }> = [];
			for (const c of running) {
				try {
					await startContainer(c.id, envId ?? undefined);
				} catch (err) {
					failed.push({ name: c.name, error: err instanceof Error ? err.message : String(err) });
				}
			}
			return { failed };
		},
	};
}
