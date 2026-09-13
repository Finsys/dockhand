import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveNanoCpusConflict } from '../src/lib/server/hostconfig-recreate';

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
