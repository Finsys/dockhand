/**
 * probeCombinedCached: one backend session serves both halves of a probe.
 *
 * The stack editor needs the bulk key names AND the resolved inline refs. A CLI
 * provider pays a full login per backend call, so fetching them separately costs
 * two logins per keystroke. A provider that offers resolveCombined serves both
 * from one session - but only when BOTH halves are cache-cold, because a warm
 * half must still come from cache rather than be re-fetched to share a session.
 */
import { describe, it, expect } from 'bun:test';
import { probeCombinedCached } from '../src/lib/server/secretproviders/probe-cache';

/**
 * A provider that counts sessions. `resolveCombined` counts as ONE; the split
 * methods count as one each, which is what the combined path exists to avoid.
 */
function sessionCountingProvider(opts: { combined?: boolean } = {}) {
	const counts = { combined: 0, bulk: 0, refs: 0 };
	const provider: any = {
		supportsBulk: true,
		supportsReferences: true,
		async resolveBulk() {
			counts.bulk++;
			return { BULK_A: 'va', BULK_B: 'vb' };
		},
		async resolveSecretReferences(_c: unknown, refs: string[]) {
			counts.refs++;
			return new Map(refs.map((r) => [r, 'secret-value']));
		}
	};
	if (opts.combined !== false) {
		provider.resolveCombined = async (_c: unknown, selector: string | undefined, refs: string[]) => {
			counts.combined++;
			return {
				bulk: selector ? { BULK_A: 'va', BULK_B: 'vb' } : {},
				refs: new Map(refs.map((r) => [r, 'secret-value']))
			};
		};
	}
	return { provider, counts };
}

const REF = 'op://vault/item/field';

// The cache is module-scoped and lives for the whole run, so every test needs its
// own provider id or a neighbour's warm entry answers this test's probe.
let nextId = 700000 + Math.floor(Math.random() * 100000);
const freshId = () => nextId++;

describe('probeCombinedCached', () => {
	it('serves both halves from ONE session when the provider can', async () => {
		const { provider, counts } = sessionCountingProvider();
		const out = await probeCombinedCached(freshId(), provider, {} as any, 'sel', [REF]);

		expect(counts.combined).toBe(1);
		expect(counts.bulk).toBe(0);
		expect(counts.refs).toBe(0);
		expect(out.bulkKeys).toEqual(['BULK_A', 'BULK_B']);
		expect(out.resolvedRefs).toEqual([REF]);
	});

	it('keeps the two halves distinct - bulk KEY NAMES and resolved REF strings', async () => {
		const { provider } = sessionCountingProvider();
		const out = await probeCombinedCached(freshId(), provider, {} as any, 'sel', [REF]);

		// Swapping them would light up the wrong editor markers, so pin each side
		// to content only its own half can produce.
		expect(out.bulkKeys).not.toContain(REF);
		expect(out.resolvedRefs).not.toContain('BULK_A');
	});

	it('falls back to the split calls when the provider has no resolveCombined', async () => {
		const { provider, counts } = sessionCountingProvider({ combined: false });
		const out = await probeCombinedCached(freshId(), provider, {} as any, 'sel', [REF]);

		expect(counts.bulk).toBe(1);
		expect(counts.refs).toBe(1);
		expect(out.bulkKeys).toEqual(['BULK_A', 'BULK_B']);
		expect(out.resolvedRefs).toEqual([REF]);
	});

	it('only one half wanted: no combined session, just that half', async () => {
		const bulkOnly = sessionCountingProvider();
		const a = await probeCombinedCached(freshId(), bulkOnly.provider, {} as any, 'sel', []);
		expect(bulkOnly.counts.combined).toBe(0);
		expect(bulkOnly.counts.bulk).toBe(1);
		expect(a.resolvedRefs).toEqual([]);

		const refsOnly = sessionCountingProvider();
		const b = await probeCombinedCached(freshId(), refsOnly.provider, {} as any, undefined, [REF]);
		expect(refsOnly.counts.combined).toBe(0);
		expect(refsOnly.counts.refs).toBe(1);
		expect(b.bulkKeys).toEqual([]);
	});

	it('a second probe inside the TTL hits the cache instead of the provider', async () => {
		const { provider, counts } = sessionCountingProvider();
		const id = freshId();
		await probeCombinedCached(id, provider, {} as any, 'sel', [REF]);
		const again = await probeCombinedCached(id, provider, {} as any, 'sel', [REF]);

		expect(counts.combined).toBe(1); // still one - the second probe was served warm
		expect(again.bulkKeys).toEqual(['BULK_A', 'BULK_B']);
		expect(again.resolvedRefs).toEqual([REF]);
	});

	it('a warm half is served from cache rather than re-fetched to share a session', async () => {
		const { provider, counts } = sessionCountingProvider();
		const id = freshId();
		// Warm ONLY the bulk half.
		await probeCombinedCached(id, provider, {} as any, 'sel', []);
		expect(counts.bulk).toBe(1);

		// Now both are wanted but bulk is warm: the cold half alone goes to the
		// provider; taking the combined path here would re-fetch the warm half.
		const out = await probeCombinedCached(id, provider, {} as any, 'sel', [REF]);
		expect(counts.combined).toBe(0);
		expect(counts.refs).toBe(1);
		expect(counts.bulk).toBe(1);
		expect(out.bulkKeys).toEqual(['BULK_A', 'BULK_B']);
		expect(out.resolvedRefs).toEqual([REF]);
	});

	it('concurrent probes coalesce onto ONE session', async () => {
		const { provider, counts } = sessionCountingProvider();
		const id = freshId();
		const slow = provider.resolveCombined;
		provider.resolveCombined = async (...a: unknown[]) => {
			await new Promise((r) => setTimeout(r, 30));
			return (slow as any)(...a);
		};

		const all = await Promise.all(
			Array.from({ length: 8 }, () => probeCombinedCached(id, provider, {} as any, 'sel', [REF]))
		);

		expect(counts.combined).toBe(1);
		for (const out of all) {
			expect(out.bulkKeys).toEqual(['BULK_A', 'BULK_B']);
			expect(out.resolvedRefs).toEqual([REF]);
		}
	});

	it('a provider error propagates instead of being swallowed as an empty result', async () => {
		const { provider } = sessionCountingProvider();
		provider.resolveCombined = async () => {
			throw new Error('vault unreachable');
		};

		// The endpoint turns a throw into the probe-failed UI line; a silent empty
		// result would read as "no keys in the vault" - a false MISSING.
		await expect(
			probeCombinedCached(freshId(), provider, {} as any, 'sel', [REF])
		).rejects.toThrow('vault unreachable');
	});
});
