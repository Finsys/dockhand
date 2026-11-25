import { describe, expect, test } from 'bun:test';
import { diskSegmentPath } from '../src/lib/utils/disk-segment-path';

describe('diskSegmentPath', () => {
	test('maps each segment with its own view to that view', () => {
		expect(diskSegmentPath('images')).toBe('/images');
		expect(diskSegmentPath('containers')).toBe('/containers');
		expect(diskSegmentPath('volumes')).toBe('/volumes');
	});

	test('build cache links to the images page, where its prune action lives', () => {
		expect(diskSegmentPath('buildCache')).toBe('/images');
	});
});
