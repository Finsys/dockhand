/**
 * Unit tests for the "skip bind mounts" batch-backup helpers (#1570):
 * namedVolumeKeys (named-only selection) and batchSkipDecision (the type-dependent
 * per-item decision, incl. the down-stack "unknown volumes" case).
 */
import { describe, test, expect } from 'bun:test';
import { namedVolumeKeys, batchSkipDecision, type VolumeInfo } from '../src/lib/utils/mounts';

const vol = (over: Partial<VolumeInfo>): VolumeInfo => ({
	key: 'k',
	name: 'n',
	mountPoint: '/data',
	mountType: 'volume',
	...over
});

describe('namedVolumeKeys', () => {
	test('keeps only named volumes, drops bind mounts', () => {
		const item = {
			volumes: [
				vol({ key: 'app-data', mountType: 'volume' }),
				vol({ key: 'media-bind', mountType: 'bind' }),
				vol({ key: 'config-data', mountType: 'volume' })
			]
		};
		expect(namedVolumeKeys(item)).toEqual(['app-data', 'config-data']);
	});

	test('drops unbackupable named entries', () => {
		const item = {
			volumes: [
				vol({ key: 'good', mountType: 'volume' }),
				vol({ key: 'x', mountType: 'volume', unbackupable: true })
			]
		};
		expect(namedVolumeKeys(item)).toEqual(['good']);
	});

	test('drops an unbackupable BIND (the real-world docker.sock / host-path shape)', () => {
		const item = {
			volumes: [
				vol({ key: 'app-data', mountType: 'volume' }),
				vol({ key: 'sock', mountType: 'bind', unbackupable: true, source: '/var/run/docker.sock' })
			]
		};
		expect(namedVolumeKeys(item)).toEqual(['app-data']);
	});

	test('only bind mounts / no volumes yields an empty list', () => {
		expect(namedVolumeKeys({ volumes: [vol({ mountType: 'bind' })] })).toEqual([]);
		expect(namedVolumeKeys({ volumes: [] })).toEqual([]);
	});
});

describe('batchSkipDecision', () => {
	test('mixed volumes -> narrow to named keys', () => {
		const item = {
			type: 'stack' as const,
			volumes: [vol({ key: 'db', mountType: 'volume' }), vol({ key: 'media', mountType: 'bind' })]
		};
		expect(batchSkipDecision(item)).toEqual({ action: 'named', selectedVolumes: ['db'] });
	});

	test('bind-only CONTAINER -> skip (nothing to back up)', () => {
		const item = { type: 'container' as const, volumes: [vol({ key: 'media', mountType: 'bind' })] };
		expect(batchSkipDecision(item)).toEqual({ action: 'skip' });
	});

	test('bind-only STACK -> empty named selection (compose/.env still captured)', () => {
		const item = { type: 'stack' as const, volumes: [vol({ key: 'media', mountType: 'bind' })] };
		expect(batchSkipDecision(item)).toEqual({ action: 'named', selectedVolumes: [] });
	});

	test('DOWN stack (no mounts listed) -> "all", NOT a frozen empty selection', () => {
		// A stopped stack lists no containers, so its volumes are unknown - we must not
		// bake in an empty selection that would permanently miss its real named volumes.
		const item = { type: 'stack' as const, volumes: [] };
		expect(batchSkipDecision(item)).toEqual({ action: 'all' });
	});

	test('container with no mounts listed -> "all" (leave allVolumes true)', () => {
		const item = { type: 'container' as const, volumes: [] };
		expect(batchSkipDecision(item)).toEqual({ action: 'all' });
	});
});
