/**
 * Whether and when the stack modal should close itself after a save/deploy settles.
 *
 * Superseded design note: an earlier version of this function only distinguished
 * "deployed or not" and kept the modal open for every deploy, on the reasoning that
 * closing would throw away the compose output now rendered below the editor. The
 * operator saw that in practice (30.08.2026) and did not want it: a *successful*
 * deploy leaving the modal open forever, needing a manual close every time, was as
 * wrong as the previous behaviour of always closing regardless of outcome. Both
 * pre-existed this file; this is the fix for both, decided by the operator, not
 * inferred from the code.
 */
export type SaveCloseTiming = 'close' | 'close-delayed' | 'stay-open';

/**
 * - A plain save (`deployed` false) has nothing new to show, so it closes -- same as
 *   before this file existed. The caller keeps its own short flash-then-close delay
 *   (500ms) for this case; this function only says "close", not how soon.
 * - A deploy that succeeded (`deployed` true, `ok` true) closes too, but only after a
 *   longer delay, so the success and the compose output are still glimpsed before the
 *   modal goes away. Trade-off accepted knowingly, not an oversight: that output is
 *   then gone until the deploy-history view (Milestone 3) exists to show it again.
 * - A deploy that failed (`deployed` true, `ok` false) stays open, full stop -- the
 *   output and the error dialog on top of it are exactly what the operator needs to
 *   read and act on.
 *
 * `ok` is meaningless when `deployed` is false (a plain save has no deploy result to
 * be ok or not) -- callers may pass anything there, it is never read for that case.
 */
export function saveCloseTiming(deployed: boolean, ok: boolean): SaveCloseTiming {
	if (!deployed) return 'close';
	return ok ? 'close-delayed' : 'stay-open';
}
