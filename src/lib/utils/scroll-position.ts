/**
 * Whether a scrollable element counts as "at the bottom" for auto-scroll purposes.
 *
 * Used both to decide whether to pause auto-scroll (the user scrolled up to read
 * earlier output) and to decide when to resume it (the user scrolled back down).
 * A small threshold rather than an exact match: sub-pixel scroll positions and
 * fractional zoom levels mean scrollHeight - scrollTop - clientHeight is rarely
 * ever exactly 0 even when the element visually is at the end.
 */
export function isScrolledToBottom(
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number,
	threshold = 50
): boolean {
	return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * Whether a scroll-up pause should be lifted because a fresh run is starting.
 *
 * autoScroll going from false to true is that signal (a stack redeploy sets
 * `running = true`, which is what LogViewer's autoScroll prop is bound to, at
 * the exact moment its output is cleared and a new run begins) -- so a viewer
 * who scrolled up to read one run's output gets auto-scroll back for the next
 * one, rather than it staying paused for the rest of the page session.
 *
 * Deliberately an edge (false -> true), not a level (autoScroll is true): a
 * naive "reset whenever autoScroll is true" reads as similar but re-lifts the
 * pause on every single update while a run is in progress, which defeats the
 * pause entirely.
 */
export function shouldResetScrollPause(previousAutoScroll: boolean, autoScroll: boolean): boolean {
	return autoScroll && !previousAutoScroll;
}
