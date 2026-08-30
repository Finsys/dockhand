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
