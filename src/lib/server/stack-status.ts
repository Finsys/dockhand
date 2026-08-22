/**
 * Derive a compose stack's overall status from its containers' states.
 * Pure and unit-tested. A container in a restart loop reports state 'restarting'
 * and is NOT stopped - it is actively trying to come up, so the stack must offer
 * Stop, not Start (#1438). Init/migration containers that exited 0 are "completed"
 * and don't count against health.
 */

export type StackStatus = 'running' | 'partial' | 'restarting' | 'stopped';

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
