// Compute a gutter background that stays visibly distinct from the editor's own
// background on ANY theme (#1309). @uiw themes give the gutter the same colour as the
// code, so line numbers blend in. Rather than guess per theme, the caller reads the
// rendered background and this derives a contrasting tint from it.

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

// Parse "rgb(r, g, b)" / "rgba(r, g, b, a)" (the form getComputedStyle returns).
// Returns null for anything else (e.g. "transparent", named colours, empty).
export function parseRgb(color: string | null | undefined): Rgb | null {
	if (!color) return null;
	const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
	if (!m) return null;
	return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

// Perceived luminance 0..255 (Rec. 601 weights).
export function luminance({ r, g, b }: Rgb): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clamp(n: number): number {
	return Math.max(0, Math.min(255, Math.round(n)));
}

// A gutter background derived from the code background: lighten a dark background,
// darken a light one, by a fixed step so the shift is always visible. Returns an
// rgb() string, or null if the input can't be parsed (caller keeps its fallback).
export function gutterBackgroundFor(codeBg: string | null | undefined, step = 24): string | null {
	const rgb = parseRgb(codeBg);
	if (!rgb) return null;
	const dir = luminance(rgb) < 128 ? 1 : -1; // dark bg -> lighten, light bg -> darken
	const r = clamp(rgb.r + dir * step);
	const g = clamp(rgb.g + dir * step);
	const b = clamp(rgb.b + dir * step);
	return `rgb(${r}, ${g}, ${b})`;
}
