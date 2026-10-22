import { describe, expect, test } from 'bun:test';
import { diskSegmentPath } from '../src/lib/utils/disk-segment-path';

describe('diskSegmentPath', () => {
	test('maps each segment with its own view to that view', () => {
		expect(diskSegmentPath('images')).toBe('/images');
		expect(diskSegmentPath('containers')).toBe('/containers');
		expect(diskSegmentPath('volumes')).toBe('/volumes');
	});

	test('build cache has no view, so it is not linked', () => {
		expect(diskSegmentPath('buildCache')).toBeNull();
	});
});
