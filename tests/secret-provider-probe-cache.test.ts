/**
 * probeBulkKeysCached: result cache (~30s, names only) + single-flight coalescing.
 * The single-flight guard stops overlapping stack-editor probes from each hitting the
 * provider (wasted 1Password/Vault API calls; a burst of keepassxc-cli/bws spawns).
 */
import { describe, it, expect } from 'bun:test';
import { probeBulkKeysCached, probeRefsCached } from '../src/lib/server/secretproviders/probe-cache';

// A provider whose resolveBulk is slow and counts its own calls. Cast to the
// SecretProvider shape (only resolveBulk is exercised here).
function countingProvider(delayMs = 30) {
	let calls = 0;
	const provider: any = {
		supportsBulk: true,
		async resolveBulk() {
			calls++;
			await new Promise((r) => setTimeout(r, delayMs));
			return { KEY_A: 'a', KEY_B: 'b' };
		}
	};
	return { provider, calls: () => calls };
}

describe('probeBulkKeysCached', () => {
	it('coalesces concurrent probes for the same (provider, selector) into ONE call', async () => {
		const { provider, calls } = countingProvider();
		const id = 1001; // unique id so cache/inflight don't collide with other tests
		const results = await Promise.all(
			Array.from({ length: 10 }, () => probeBulkKeysCached(id, provider, {} as any, 'grp'))
		);
		expect(calls()).toBe(1); // single-flight: 10 concurrent -> 1 provider call
		// every caller still gets the same key names
		for (const r of results) expect(r.sort()).toEqual(['KEY_A', 'KEY_B']);
	});

	it('serves the cached result on a later call without re-calling the provider', async () => {
		const { provider, calls } = countingProvider();
		const id = 1002;
		await probeBulkKeysCached(id, provider, {} as any, 'grp');
		await probeBulkKeysCached(id, provider, {} as any, 'grp');
		expect(calls()).toBe(1); // second call hit the ~30s cache
	});

	it('does NOT coalesce different selectors', async () => {
		const { provider, calls } = countingProvider();
		const id = 1003;
		await Promise.all([
			probeBulkKeysCached(id, provider, {} as any, 'grp-a'),
			probeBulkKeysCached(id, provider, {} as any, 'grp-b')
		]);
		expect(calls()).toBe(2); // distinct keys -> distinct calls
	});

	it('re-probes (does not serve a stale entry) once the TTL has elapsed', async () => {
		// The cache TTL is 30s; we can't wait that long, so drive it by advancing the
		// clock via a stubbed Date.now. A stale hit must be dropped and re-fetched.
		const { provider, calls } = countingProvider();
		const id = 1005;
		const realNow = Date.now;
		try {
			let t = 1_000_000;
			(Date as any).now = () => t;
			await probeBulkKeysCached(id, provider, {} as any, 'grp'); // call 1, cached at t
			t += 31_000; // jump past the 30s TTL
			await probeBulkKeysCached(id, provider, {} as any, 'grp'); // stale -> call 2
			expect(calls()).toBe(2);
		} finally {
			(Date as any).now = realNow;
		}
	});

	it('does not cache a failure, and a later probe retries', async () => {
		let calls = 0;
		const provider: any = {
			supportsBulk: true,
			async resolveBulk() {
				calls++;
				if (calls === 1) throw new Error('transient');
				return { OK: 'v' };
			}
		};
		const id = 1004;
		await expect(probeBulkKeysCached(id, provider, {} as any, 'grp')).rejects.toThrow('transient');
		// the in-flight entry must have been cleared, so this retries rather than
		// returning a stale/failed promise
		const keys = await probeBulkKeysCached(id, provider, {} as any, 'grp');
		expect(keys).toEqual(['OK']);
		expect(calls).toBe(2);
	});
});

// The inline-reference probe (op:// etc.) is the path that drained the 1Password
// limit "just by opening the editor" (#1436): runProbe fires on open and on every
// debounced edit, and each fire resolved every reference again with no cache.
function countingRefsProvider(delayMs = 30) {
	let calls = 0;
	const provider: any = {
		supportsReferences: true,
		async resolveSecretReferences(_config: any, refs: string[]) {
			calls++;
			await new Promise((r) => setTimeout(r, delayMs));
			// echo back a resolution for every ref (value discarded by the cache)
			return new Map(refs.map((r) => [r, 'secret-value']));
		}
	};
	return { provider, calls: () => calls };
}

describe('probeRefsCached', () => {
	const REFS = ['op://vault/db/password', 'op://vault/api/token'];

	it('returns [] without calling the provider when there are no refs', async () => {
		const { provider, calls } = countingRefsProvider();
		expect(await probeRefsCached(2001, provider, {} as any, [])).toEqual([]);
		expect(calls()).toBe(0);
	});

	it('coalesces concurrent probes for the same (provider, refs) into ONE call', async () => {
		const { provider, calls } = countingRefsProvider();
		const id = 2002;
		const results = await Promise.all(
			Array.from({ length: 10 }, () => probeRefsCached(id, provider, {} as any, REFS))
		);
		expect(calls()).toBe(1); // 10 concurrent editor probes -> 1 provider call
		for (const r of results) expect(r.sort()).toEqual([...REFS].sort());
	});

	it('serves the cached result on a later call without re-billing the provider', async () => {
		const { provider, calls } = countingRefsProvider();
		const id = 2003;
		await probeRefsCached(id, provider, {} as any, REFS);
		await probeRefsCached(id, provider, {} as any, REFS); // reopen / next keystroke
		expect(calls()).toBe(1); // second call hit the ~30s cache
	});

	it('is order-independent: the same refs in a different order share one cache entry', async () => {
		const { provider, calls } = countingRefsProvider();
		const id = 2004;
		await probeRefsCached(id, provider, {} as any, REFS);
		await probeRefsCached(id, provider, {} as any, [...REFS].reverse());
		expect(calls()).toBe(1);
	});

	it('does NOT coalesce different ref sets', async () => {
		const { provider, calls } = countingRefsProvider();
		const id = 2005;
		await Promise.all([
			probeRefsCached(id, provider, {} as any, ['op://v/a/x']),
			probeRefsCached(id, provider, {} as any, ['op://v/b/y'])
		]);
		expect(calls()).toBe(2);
	});

	it('returns (and caches) ONLY the refs that resolved, not the full input set', async () => {
		// The real resolveSecretReferences returns just the refs that resolved; the
		// missing ones drive the editor's MISSING marker. The cache must store that
		// resolved SUBSET (never the input refs), or a missing secret would show a
		// false "IN VAULT". Provider resolves only the first ref.
		let calls = 0;
		const provider: any = {
			supportsReferences: true,
			async resolveSecretReferences(_c: any, r: string[]) {
				calls++;
				return new Map([[r[0], 'v']]); // second ref does NOT resolve
			}
		};
		const id = 2008;
		const first = await probeRefsCached(id, provider, {} as any, REFS);
		expect(first).toEqual([REFS[0]]); // only the resolved ref, not both
		const second = await probeRefsCached(id, provider, {} as any, REFS);
		expect(second).toEqual([REFS[0]]); // cached subset, still not the full input
		expect(calls).toBe(1);
	});

	it('re-probes once the TTL has elapsed', async () => {
		const { provider, calls } = countingRefsProvider();
		const id = 2006;
		const realNow = Date.now;
		try {
			let t = 2_000_000;
			(Date as any).now = () => t;
			await probeRefsCached(id, provider, {} as any, REFS);
			t += 31_000; // past the 30s TTL
			await probeRefsCached(id, provider, {} as any, REFS);
			expect(calls()).toBe(2);
		} finally {
			(Date as any).now = realNow;
		}
	});

	it('does not cache a failure, and a later probe retries', async () => {
		let calls = 0;
		const provider: any = {
			supportsReferences: true,
			async resolveSecretReferences(_c: any, refs: string[]) {
				calls++;
				if (calls === 1) throw new Error('rate limit exceeded');
				return new Map(refs.map((r) => [r, 'v']));
			}
		};
		const id = 2007;
		await expect(probeRefsCached(id, provider, {} as any, REFS)).rejects.toThrow('rate limit');
		const names = await probeRefsCached(id, provider, {} as any, REFS);
		expect(names.sort()).toEqual([...REFS].sort());
		expect(calls).toBe(2);
	});
});
