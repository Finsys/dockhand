/**
 * persistStackIcon: the shared DELETE/upload/set contract for the name-based stack icon
 * endpoint (used by StackModal and GitStackModal, #1473). null after a clear, the new
 * icon on success, undefined when a POST failed (so callers keep the current icon).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { persistStackIcon } from '../src/lib/utils/stack-icon';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(impl: (url: string, init?: any) => { ok: boolean; json?: () => any }) {
	globalThis.fetch = (async (url: any, init?: any) => {
		const r = impl(String(url), init);
		return { ok: r.ok, json: async () => (r.json ? r.json() : {}) } as any;
	}) as any;
}

describe('persistStackIcon', () => {
	it('clears with DELETE and returns null for an empty value', async () => {
		let method = '';
		stubFetch((_u, init) => { method = init?.method; return { ok: true }; });
		expect(await persistStackIcon('/api/stacks/x/icon', '')).toBeNull();
		expect(method).toBe('DELETE');
	});

	it('POSTs {image} for an upload: value and returns the stored icon', async () => {
		let body: any = null;
		stubFetch((_u, init) => { body = JSON.parse(init.body); return { ok: true, json: () => ({ icon: 'custom:stack' }) }; });
		expect(await persistStackIcon('/api/stacks/x/icon', 'upload:data:image/png;base64,AAAA')).toBe('custom:stack');
		expect(body.image).toBe('data:image/png;base64,AAAA');
	});

	it('POSTs {icon} for a lucide/selfhst value and returns it', async () => {
		let body: any = null;
		stubFetch((_u, init) => { body = JSON.parse(init.body); return { ok: true, json: () => ({ icon: 'database' }) }; });
		expect(await persistStackIcon('/api/stacks/x/icon', 'database')).toBe('database');
		expect(body.icon).toBe('database');
	});

	it('returns undefined when the POST fails (caller keeps the current icon)', async () => {
		stubFetch(() => ({ ok: false }));
		expect(await persistStackIcon('/api/stacks/x/icon', 'database')).toBeUndefined();
	});
});
