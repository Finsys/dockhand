/**
 * Which restore targets already hold data, and whether the overwrite acknowledgement can be
 * reached. The two must agree: a target counted into the gate but never rendered leaves the
 * restore button disabled with nothing on screen to tick.
 */

export type ProbeKind = 'has-data' | 'empty' | 'missing' | 'helper-failed' | 'unreadable';

/** How many targets a restore would overwrite. The stack dir counts on its own. */
export function countTargetsWithData(
	volumes: Array<{ hasData?: ProbeKind }>,
	stackFiles: { hasData?: ProbeKind } | null | undefined
): number {
	return volumes.filter((v) => v.hasData === 'has-data').length + (stackFiles?.hasData === 'has-data' ? 1 : 0);
}

/**
 * Is the acknowledgement reachable for this count? It is rendered whenever something holds data,
 * independent of how many volume rows are selected - a stack with no volumes still replaces its
 * stack dir, and gating the checkbox on the volume list made that restore impossible to confirm.
 */
export function overwriteAckReachable(targetsWithData: number): boolean {
	return targetsWithData > 0;
}
