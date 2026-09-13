/**
 * Resolve selfh.st app icons through the BATCH endpoint instead of one
 * `<img src="/api/icons/selfhst/<ref>">` request per icon. A list with dozens of
 * stacks/containers otherwise fires dozens of separate icon requests (which a WAF
 * flags as crawling, #1467, and which is just slow). Components call `requestSelfhst(ref)`
 * to register the refs they need and read the resolved `data:` URI from `selfhstIcons`;
 * this store collects refs within a microtask window and resolves them in ONE POST.
 */
import { writable, get } from 'svelte/store';

/** ref -> resolved `data:image/svg+xml;base64,...` URI (or '' if it could not resolve). */
export const selfhstIcons = writable<Record<string, string>>({});

const pending = new Set<string>();
const requested = new Set<string>(); // refs already resolved or in flight (don't re-fetch)
let flushScheduled = false;

const BATCH_MAX = 200; // matches the endpoint cap

async function flush() {
	flushScheduled = false;
	const refs = [...pending].slice(0, BATCH_MAX);
	if (refs.length === 0) return;
	for (const r of refs) {
		pending.delete(r);
		requested.add(r);
	}
	// More than BATCH_MAX refs registered this tick: drain the rest in another batch.
	if (pending.size > 0 && !flushScheduled) {
		flushScheduled = true;
		queueMicrotask(flush);
	}
	try {
		const res = await fetch('/api/icons/selfhst/batch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refs })
		});
		const data: { icons?: Record<string, string> } = res.ok ? await res.json() : {};
		const icons = data.icons ?? {};
		// Store resolved icons; mark unresolved refs as '' so we don't re-request them.
		selfhstIcons.update((cur) => {
			const next = { ...cur };
			for (const r of refs) next[r] = icons[r] ?? '';
			return next;
		});
	} catch {
		// leave refs unresolved; a component can fall back to a placeholder
		selfhstIcons.update((cur) => {
			const next = { ...cur };
			for (const r of refs) if (!(r in next)) next[r] = '';
			return next;
		});
	}
}

/**
 * Register a selfh.st ref for resolution. Returns immediately; the resolved data URI
 * appears in the `selfhstIcons` store once the next batch completes. Already-resolved or
 * in-flight refs are skipped.
 */
export function requestSelfhst(ref: string | null | undefined): void {
	if (!ref) return;
	if (requested.has(ref) || pending.has(ref)) return;
	if (ref in get(selfhstIcons)) return;
	pending.add(ref);
	if (!flushScheduled) {
		flushScheduled = true;
		// Coalesce all refs registered in this tick into one request.
		queueMicrotask(flush);
	}
}
