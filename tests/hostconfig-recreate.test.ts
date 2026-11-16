import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveNanoCpusConflict, stripDefaultMemorySwappiness } from '../src/lib/server/hostconfig-recreate';

describe('stripDefaultMemorySwappiness', () => {
	// Podman reports MemorySwappiness=0 for a container with no memory limits, and crun
	// rejects setting swappiness on cgroup v2 at START even for 0 - this is the self-update
	// start failure. The three unset-default forms must all be dropped.
	for (const def of [0, -1, null, undefined]) {
		it(`drops the default MemorySwappiness ${String(def)}`, () => {
			const hc: any = { MemorySwappiness: def, Memory: 42 };
			assert.equal(stripDefaultMemorySwappiness(hc), true);
			assert.equal('MemorySwappiness' in hc, false);
			assert.equal(hc.Memory, 42); // unrelated field untouched (non-zero sentinel)
		});
	}

	it('keeps a real user-set MemorySwappiness (60) - not a default', () => {
		const hc: any = { MemorySwappiness: 60 };
		assert.equal(stripDefaultMemorySwappiness(hc), false);
		assert.equal(hc.MemorySwappiness, 60);
	});

	it('keeps a positive near-default like 1', () => {
		const hc: any = { MemorySwappiness: 1 };
		assert.equal(stripDefaultMemorySwappiness(hc), false);
		assert.equal(hc.MemorySwappiness, 1);
	});

	it('no-op when MemorySwappiness is absent', () => {
		const hc: any = { Memory: 123 };
		assert.equal(stripDefaultMemorySwappiness(hc), false);
		assert.equal(hc.Memory, 123);
	});

	it('safe on null/undefined hostConfig', () => {
		assert.equal(stripDefaultMemorySwappiness(null), false);
		assert.equal(stripDefaultMemorySwappiness(undefined), false);
	});
});

describe('resolveNanoCpusConflict (#1381)', () => {
	it('drops CpuPeriod/CpuQuota when NanoCpus is also set (Podman inspect reports both)', () => {
		const hc: any = { NanoCpus: 500000000, CpuPeriod: 100000, CpuQuota: 50000, Memory: 123 };
		assert.equal(resolveNanoCpusConflict(hc), true);
		assert.equal(hc.NanoCpus, 500000000); // kept — the direct `cpus:` equivalent
		assert.equal('CpuPeriod' in hc, false);
		assert.equal('CpuQuota' in hc, false);
		assert.equal(hc.Memory, 123); // unrelated fields untouched
	});

	it('drops the pair when only CpuQuota accompanies NanoCpus', () => {
		const hc: any = { NanoCpus: 250000000, CpuQuota: 25000 };
		assert.equal(resolveNanoCpusConflict(hc), true);
		assert.equal('CpuQuota' in hc, false);
	});

	it('is a no-op on Docker where a --cpus container reports period/quota as 0', () => {
		const hc: any = { NanoCpus: 500000000, CpuPeriod: 0, CpuQuota: 0 };
		assert.equal(resolveNanoCpusConflict(hc), false);
		assert.equal(hc.NanoCpus, 500000000);
	});

	it('is a no-op when only CpuPeriod/CpuQuota are set (no NanoCpus)', () => {
		const hc: any = { CpuPeriod: 100000, CpuQuota: 50000 };
		assert.equal(resolveNanoCpusConflict(hc), false);
		assert.equal(hc.CpuPeriod, 100000);
		assert.equal(hc.CpuQuota, 50000);
	});

	it('is a no-op when no CPU limits are set at all', () => {
		const hc: any = { Memory: 0 };
		assert.equal(resolveNanoCpusConflict(hc), false);
	});

	it('tolerates null/undefined', () => {
		assert.equal(resolveNanoCpusConflict(null), false);
		assert.equal(resolveNanoCpusConflict(undefined), false);
	});
});
