import { describe, test, expect } from 'bun:test';
import { prunedImageCount } from '../src/lib/utils/pruned-image-count';

describe('prunedImageCount', () => {
	// Docker 29.4.1 prune of all unused images, measured: busybox, d:1 and alpine
	// (also tagged m:x) - one Untagged per tag, several Deleted per image.
	const pruneAll = [
		{ Untagged: 'alpine:3.20' }, { Untagged: 'busybox:1.36' }, { Untagged: 'd:1' },
		{ Deleted: 'sha256:ed11' }, { Deleted: 'sha256:bae4' }, { Deleted: 'sha256:a863' },
		{ Untagged: 'm:x' }, { Deleted: 'sha256:d9e8' }, { Deleted: 'sha256:c64c' }, { Deleted: 'sha256:6243' }
	];

	test('counts tags, not every entry', () => {
		expect(prunedImageCount(pruneAll)).toBe(4);
	});

	test('a prune of untagged images is counted by its digest untags', () => {
		expect(prunedImageCount([{ Untagged: 'busybox@sha256:aa' }, { Deleted: 'sha256:1' }, { Deleted: 'sha256:2' }, { Deleted: 'sha256:3' }, { Untagged: 'alpine@sha256:bb' }])).toBe(2);
	});

	test('an image untagged by both its tag and its digest counts once', () => {
		expect(prunedImageCount([{ Untagged: 'alpine:3.20' }, { Untagged: 'alpine@sha256:bb' }, { Deleted: 'sha256:1' }])).toBe(1);
	});

	test('a prune that only deleted is not reported as nothing', () => {
		expect(prunedImageCount([{ Deleted: 'sha256:1' }, { Deleted: 'sha256:2' }])).toBe(2);
	});

	test('nothing removed is zero', () => {
		expect(prunedImageCount(null)).toBe(0);
		expect(prunedImageCount([])).toBe(0);
	});
});
