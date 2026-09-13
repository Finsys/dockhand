/**
 * Unit tests for backups/identity-core.ts — the pure instance-id resolver,
 * driven by an injected store + id generator (no DB, no randomUUID).
 */
import { describe, it, expect } from 'bun:test';
import { resolveInstanceId, type InstanceIdStore } from '../../src/lib/server/backups/identity-core';

/** In-memory store that records how many times set() was called. */
function memStore(seed?: string): InstanceIdStore & { raw: Map<string, string>; setCount: number } {
	const raw = new Map<string, string>();
	if (seed !== undefined) raw.set('backup_instance_id', seed);
	const box = {
		raw,
		setCount: 0,
		async get(key: string) { return raw.has(key) ? raw.get(key) : null; },
		async set(key: string, value: string) { box.setCount++; raw.set(key, value); },
	};
	return box;
}

describe('resolveInstanceId', () => {
	it('returns the existing id when one is stored, without generating or writing', async () => {
		const store = memStore('existing-uuid');
		let generated = false;
		const id = await resolveInstanceId(store, () => { generated = true; return 'fresh'; });
		expect(id).toBe('existing-uuid');
		expect(generated).toBe(false);
		expect(store.setCount).toBe(0);
	});

	it('generates, persists, and returns a fresh id when none is stored', async () => {
		const store = memStore();
		const id = await resolveInstanceId(store, () => 'fresh-uuid');
		expect(id).toBe('fresh-uuid');
		expect(store.raw.get('backup_instance_id')).toBe('fresh-uuid');
		expect(store.setCount).toBe(1);
	});

	it('treats an empty stored value as absent and generates', async () => {
		const store = memStore('');
		const id = await resolveInstanceId(store, () => 'fresh-uuid');
		expect(id).toBe('fresh-uuid');
	});
});

describe('resolveInstanceId — single-flight (shared by the wrapper)', () => {
	it('two concurrent first-callers through ONE promise generate + persist once', async () => {
		// The wrapper (identity.ts) memoises the in-flight promise, so both callers
		// await the SAME resolveInstanceId call. That means one generate + one set,
		// and both see the same id — never two conflicting UUIDs.
		const store = memStore();
		let generateCount = 0;
		const gen = () => { generateCount++; return `uuid-${generateCount}`; };

		let shared: Promise<string> | null = null;
		const run = () => (shared ??= resolveInstanceId(store, gen));
		const [a, b] = await Promise.all([run(), run()]);

		expect(a).toBe(b);
		expect(generateCount).toBe(1);
		expect(store.setCount).toBe(1);
	});
});
