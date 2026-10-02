/**
 * createIdOrderStore: a saved list order, per user.
 *
 * The behaviour that matters is when it talks to the server. A screen that only
 * displays the order must still see the saved one (or it renders a default order
 * and a drag there saves that default over the real thing), and a save must not
 * race ahead of a load still in flight.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { get } from 'svelte/store';
import { createIdOrderStore } from '../src/lib/stores/id-order-store';

const realFetch = globalThis.fetch;

// The store mirrors into localStorage and guards on `window`; bun has neither,
// so give it just enough of both to exercise the real paths.
const backing = new Map<string, string>();
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).localStorage = {
	getItem: (k: string) => backing.get(k) ?? null,
	setItem: (k: string, v: string) => void backing.set(k, v),
	removeItem: (k: string) => void backing.delete(k),
	clear: () => backing.clear()
};

/** A fetch stand-in that records calls and answers GET with `order`. */
function stubFetch(order: number[], opts: { delayMs?: number; failGet?: boolean } = {}) {
	const calls: { url: string; method: string; body?: unknown }[] = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		calls.push({
			url: String(url),
			method,
			body: init?.body ? JSON.parse(String(init.body)) : undefined
		});
		if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
		if (method === 'GET' && opts.failGet) return new Response('nope', { status: 500 });
		return new Response(JSON.stringify({ order }), { status: 200 });
	}) as typeof fetch;
	return calls;
}

const mk = () =>
	createIdOrderStore({ storageKey: `k-${Math.random()}`, endpoint: '/api/preferences/x-order' });

beforeEach(() => localStorage.clear());
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('createIdOrderStore', () => {
	test('reading it fetches the saved order, without anyone calling init', async () => {
		// The bug this guards: a screen that only displays the order showed the
		// default one, and a drag there saved that default over the real order.
		const calls = stubFetch([3, 1, 2]);
		const store = mk();
		get(store);
		await new Promise((r) => setTimeout(r, 5));
		expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
		expect(get(store)).toEqual([3, 1, 2]);
	});

	test('the server copy is fetched once, however many readers there are', async () => {
		const calls = stubFetch([1]);
		const store = mk();
		get(store);
		get(store);
		get(store);
		await new Promise((r) => setTimeout(r, 5));
		expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
	});

	test('a save waits for a load still in flight', async () => {
		// Otherwise a drag made before the saved order arrived would be overwritten
		// by the arriving load, or would itself save from a default baseline.
		const calls = stubFetch([9, 8], { delayMs: 20 });
		const store = mk();
		get(store);
		await store.save([1, 2]);
		const order = calls.map((c) => c.method);
		expect(order.indexOf('POST')).toBeGreaterThan(order.indexOf('GET'));
		expect(get(store)).toEqual([1, 2]);
	});

	test('save sends the order and keeps it locally', async () => {
		const calls = stubFetch([]);
		const store = mk();
		await store.save([5, 4]);
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.body).toEqual({ order: [5, 4] });
		expect(get(store)).toEqual([5, 4]);
	});

	test('reset clears the order and tells the server', async () => {
		const calls = stubFetch([7]);
		const store = mk();
		await store.save([7]);
		await store.reset();
		expect(get(store)).toEqual([]);
		expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
	});

	test('init re-reads the server copy - after a sign-in it is someone else', async () => {
		const calls = stubFetch([4, 5]);
		const store = mk();
		get(store);
		await new Promise((r) => setTimeout(r, 5));
		await store.init();
		expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2);
	});

	test('clearLocal empties the order without asking the server', async () => {
		// Used on logout: the next user on this browser must not inherit the layout.
		const calls = stubFetch([1, 2]);
		const key = `k-${Math.random()}`;
		const store = createIdOrderStore({ storageKey: key, endpoint: '/api/preferences/x-order' });
		await store.save([1, 2]);
		await new Promise((r) => setTimeout(r, 5));
		store.clearLocal();
		// Local only: unlike reset(), it must not tell the server to forget anything.
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
		expect(localStorage.getItem(key)).toBeNull();
	});

	test('after clearLocal the next read fetches again, for the next user', async () => {
		const calls = stubFetch([4, 5]);
		const store = mk();
		get(store);
		await new Promise((r) => setTimeout(r, 5));
		store.clearLocal();
		get(store);
		await new Promise((r) => setTimeout(r, 5));
		expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2);
	});

	test('a save is not overwritten by a load that starts after it', async () => {
		// The server still holds the old order; a first read arriving late must not
		// put it back over what the user just arranged.
		stubFetch([9, 9, 9]);
		const store = mk();
		await store.save([1, 2, 3]);
		get(store);
		await new Promise((r) => setTimeout(r, 10));
		expect(get(store)).toEqual([1, 2, 3]);
	});

	test('a failed load leaves the local copy standing', async () => {
		stubFetch([], { failGet: true });
		const store = mk();
		await store.save([6, 7]);
		await store.init();
		expect(get(store)).toEqual([6, 7]);
	});
});
