// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import { getImageDiskUsageTotalSize } from '../src/lib/server/docker-disk-usage-core';

describe('getImageDiskUsageTotalSize', () => {
	test('uses Docker aggregate size instead of summing virtual image sizes', () => {
		const diskUsage = {
			LayersSize: 70_326_328_267,
			Images: [
				{ Size: 189_295_958_800 },
				{ Size: 82_498_083_216 }
			]
		};

		expect(getImageDiskUsageTotalSize(diskUsage)).toBe(70_326_328_267);
	});

	test('prefers the current ImageUsage.TotalSize response field', () => {
		expect(getImageDiskUsageTotalSize({
			ImageUsage: { TotalSize: 42 },
			LayersSize: 99
		})).toBe(42);
	});

	test('supports the legacy LayersSize response field', () => {
		expect(getImageDiskUsageTotalSize({ LayersSize: 42 })).toBe(42);
	});

	test('preserves zero as a valid aggregate size', () => {
		expect(getImageDiskUsageTotalSize({
			ImageUsage: { TotalSize: 0 },
			LayersSize: 99
		})).toBe(0);
		expect(getImageDiskUsageTotalSize({ LayersSize: 0 })).toBe(0);
	});

	test('falls back from an invalid current value to a valid legacy value', () => {
		expect(getImageDiskUsageTotalSize({
			ImageUsage: { TotalSize: Number.NaN },
			LayersSize: 42
		})).toBe(42);
	});

	test('returns null when no trustworthy aggregate is available', () => {
		expect(getImageDiskUsageTotalSize(undefined)).toBeNull();
		expect(getImageDiskUsageTotalSize({})).toBeNull();
		expect(getImageDiskUsageTotalSize({ LayersSize: -1 })).toBeNull();
		expect(getImageDiskUsageTotalSize({
			ImageUsage: { TotalSize: '42' },
			LayersSize: null
		})).toBeNull();
	});
});
