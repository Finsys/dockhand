import { writable } from 'svelte/store';
import { createSelfhstMatcher } from '$lib/utils/selfhst-match';

/**
 * A single shared matcher ((image, name?) -> selfh.st reference) built from the manifest.
 * Resolves by image first, then container name, then image namespace. The manifest is fetched at most once
 * per session, only after something first needs it (i.e. the selfh.st-icons toggle is on).
 * Until it loads, the matcher returns null for everything, so containers keep the generic
 * icon.
 */
const matcher = writable<(image: string, name?: string) => string | null>(() => null);
let loading = false;
let loaded = false;

export const selfhstMatcher = matcher;

/** Ensure the manifest is loaded and the matcher is ready. Idempotent. */
export async function ensureSelfhstMatcher(): Promise<void> {
	if (loaded || loading) return;
	loading = true;
	try {
		const res = await fetch('/api/icons/selfhst-manifest');
		if (!res.ok) return;
		const entries = (await res.json()) as { Reference?: string; SVG?: string; WebP?: string; PNG?: string }[];
		const refs = new Set<string>();
		// Keep any icon available in a format we can serve (SVG, else WebP, else PNG).
		for (const e of entries) if (e.Reference && (e.SVG === 'Yes' || e.WebP === 'Yes' || e.PNG === 'Yes')) refs.add(e.Reference.toLowerCase());
		matcher.set(createSelfhstMatcher(refs));
		loaded = true;
	} catch {
		// leave the null matcher in place; containers keep generic icons
	} finally {
		loading = false;
	}
}
