/**
 * Pure decision core for recovering containers/stacks that were stopped for a
 * consistent backup (or an in-place restore) but never restarted — because the
 * process died between the stop and the in-process restart. NO database or
 * docker import, so it is unit-testable under bun test.
 *
 * `reconcileOnStartup` records a durable 'stop' intent BEFORE it stops a target
 * and clears it when the in-process restart succeeds. Anything left in the
 * journal on the next startup is a target that is still down; this core turns
 * each such intent into the concrete restart action the composition layer must
 * run. It carries NO effects — it only decides — so the ordering and mapping can
 * be proven without a live docker daemon.
 */
import type { OperationRecord } from './journal-core';

/** A stable per-target key for the durable 'stop' intent, so re-recording the
 * same target updates in place rather than piling up rows. Mirrors how the
 * 'swap' intent is keyed. */
export function stopIntentKey(envId: number | null | undefined, type: 'container' | 'stack', targetName: string): string {
	return `stop:${envId ?? 'local'}:${type}:${targetName}`;
}

/** One concrete restart to perform for an interrupted 'stop' intent. */
export type RestartAction =
	| { intentId: string; type: 'stack'; targetName: string; envId: number | null | undefined }
	| { intentId: string; type: 'container'; envId: number | null | undefined; containers: Array<{ id: string; name: string }> };

/**
 * Whether an error from inspecting a stop-intent's target means the target is
 * GONE (deleted) rather than temporarily unreachable. Only a Docker 404 is
 * "gone" — the container/stack no longer exists, so a restart can never succeed
 * and the intent must be dropped. Any other failure (env offline, daemon down,
 * 5xx) is transient: the target may still exist, so the intent is kept for a
 * later startup to retry. Pure so the classification is unit-testable.
 */
export function isTargetGoneError(err: unknown): boolean {
	return (err as { statusCode?: number } | null)?.statusCode === 404;
}

/**
 * Map recorded 'stop' intents to restart actions, skipping any malformed row.
 * A stack intent restarts the stack by name; a container intent restarts each
 * recorded container id. A container intent with no recorded containers is
 * skipped (nothing to restart); the caller drops such rows via the
 * target-existence check in reconcileOnStartup.
 */
export function planStopRecovery(intents: OperationRecord[]): RestartAction[] {
	const actions: RestartAction[] = [];
	for (const rec of intents) {
		if (rec.kind !== 'stop') continue;
		if (rec.stopType === 'stack') {
			if (!rec.targetName) continue;
			actions.push({ intentId: rec.id, type: 'stack', targetName: rec.targetName, envId: rec.envId });
			continue;
		}
		// container (default)
		const containers = (rec.containers ?? []).filter((c) => c && c.id);
		if (containers.length === 0) continue;
		actions.push({ intentId: rec.id, type: 'container', envId: rec.envId, containers });
	}
	return actions;
}
