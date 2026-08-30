/**
 * Clamps a proposed number into `[min, max]`.
 *
 * A naive `Math.max(min, Math.min(max, value))` looks like it clamps any input, but
 * it does not: if `value` is `NaN`, both `Math.min` and `Math.max` propagate the NaN
 * -- any NaN operand makes them return NaN, regardless of the other operand -- so the
 * "clamped" result is still NaN. That NaN then ends up as a CSS `height: NaN%` (or
 * `width: NaNpx`), which the browser treats as invalid and the panel collapses.
 *
 * This is not a theoretical edge case for a drag-resize handler: the proposed value is
 * usually computed from `(cursorPosition - containerEdge) / containerSize` (as a
 * percentage) or `containerEdge - cursorPosition` (as a pixel distance), and a
 * container's measured size is briefly `0` while a panel is transitioning (e.g. a
 * panel appearing/disappearing) -- dividing by that zero produces NaN either way.
 * `min`/`max` may be a percentage range (e.g. 15-70 for a split ratio) or a pixel
 * range (e.g. 320-560 for a panel width) -- the clamp itself does not care about the
 * unit, only about ordering `value` against two bounds, so both use it unchanged.
 *
 * `Infinity`/`-Infinity` do not need the same special-casing: they are well-ordered
 * numbers, so `Math.min`/`Math.max` clamp them to `max`/`min` correctly on their own.
 * Only `NaN` breaks the ordinary clamp.
 */
export function clampNumber(value: number, min: number, max: number): number {
	if (Number.isNaN(value)) {
		return min;
	}
	return Math.max(min, Math.min(max, value));
}
