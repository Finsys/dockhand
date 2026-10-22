/**
 * Derive a compose stack's overall status from its containers' states.
 * Pure and unit-tested. A container in a restart loop reports state 'restarting'
 * and is NOT stopped - it is actively trying to come up, so the stack must offer
 * Stop, not Start (#1438). Init/migration containers that exited 0 are "completed"
 * and don't count against health.
 */

export type StackStatus = 'running' | 'partial' | 'restarting' | 'stopped';

/**
 * A stack's health, reported ALONGSIDE its status, never folded into it: a running
 * stack with one unhealthy container is still running, and collapsing the two would
 * change what a status filter means. 'none' is "no container declares a healthcheck",
 * which is not the same as healthy.
 */
export type StackHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface StackStatusCounts {
	/** Total containers in the stack (including completed init containers). */
	total: number;
	/** Containers with state === 'running'. */
	running: number;
	/** Containers with state === 'restarting' (restart loop / coming up). */
	restarting: number;
	/** Containers that exited 0 (init/migration - excluded from health). */
	completed: number;
}

export function deriveStackStatus(counts: StackStatusCounts): StackStatus {
	const { total, running, restarting, completed } = counts;
	const activeTotal = total - completed;
	if (activeTotal <= 0) return 'stopped';
	if (running >= activeTotal) return 'running';
	// Any live container (running or restarting) means the stack is not stopped.
	if (running > 0 || restarting > 0) {
		// All live containers are restarting and none is up -> the stack is thrashing.
		return running === 0 ? 'restarting' : 'partial';
	}
	return 'stopped';
}

/**
 * Derive a stack's health from its containers'. Only containers that DECLARE a
 * healthcheck count; a stack of none is 'none'. Worst-of wins - one unhealthy
 * container makes the stack unhealthy, since that is the one needing attention.
 * A container that exited 0 keeps its last health report, so it is ignored for the
 * same reason it is excluded from the status counts: it was never meant to stay up.
 */
// A paused container keeps its last health report and is still there, so it still
// counts; an exited one is gone and its stale report must not speak for the stack.
const LIVE_STATES = new Set(['running', 'restarting', 'paused']);

export function deriveStackHealth(
	containers: Array<{ state?: string; health?: string; exitCode?: number }>
): StackHealth {
	let healthy = false;
	let starting = false;

	for (const c of containers) {
		if (!c.health) continue;
		if (!LIVE_STATES.has(c.state ?? '')) continue;
		if (c.health === 'unhealthy') return 'unhealthy';
		if (c.health === 'starting') starting = true;
		else if (c.health === 'healthy') healthy = true;
	}

	if (starting) return 'starting';
	return healthy ? 'healthy' : 'none';
}

