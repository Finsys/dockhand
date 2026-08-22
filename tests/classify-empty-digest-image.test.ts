/**
 * Unit tests for classifyEmptyDigestImage (#1288).
 *
 * A container's RUNNING image can have an empty RepoDigests set for two very
 * different reasons, and the old code conflated them — always classifying "local"
 * and skipping the update check forever, which stranded registry containers running
 * an old, tag-moved image (exactly the ones that DO need updating).
 *
 * The tie-breaker is whether the registry could resolve Config.Image's tag:
 *   registry answered  → registry image, update available
 *   registry silent    → genuinely local (or unreachable) → stay classified local
 */

import { describe, test, expect } from 'bun:test';
import { classifyEmptyDigestImage } from '../src/lib/server/scheduler/tasks/update-utils';

describe('classifyEmptyDigestImage', () => {
	test('registry resolved a digest → registry image with an update available (#1288)', () => {
		// The stranded-rotki case: Config.Image is rotki/rotki:latest, the running
		// image is untagged/digest-less, but the registry answers for the tag.
		expect(classifyEmptyDigestImage('sha256:def456')).toEqual({
			hasUpdate: true,
			isLocalImage: false,
			registryDigest: 'sha256:def456'
		});
	});

	test('registry returned null → treat as local (truly local or unreachable)', () => {
		// A genuinely local/built image: no registry can resolve it.
		expect(classifyEmptyDigestImage(null)).toEqual({
			hasUpdate: false,
			isLocalImage: true
		});
	});

	test('registry returned undefined → treat as local', () => {
		expect(classifyEmptyDigestImage(undefined)).toEqual({
			hasUpdate: false,
			isLocalImage: true
		});
	});

	test('registry returned empty string → treat as local (falsy guard)', () => {
		// A blank digest is not a real answer; must not flip to "update available".
		expect(classifyEmptyDigestImage('')).toEqual({
			hasUpdate: false,
			isLocalImage: true
		});
	});

	test('local classification never carries a registryDigest', () => {
		const res = classifyEmptyDigestImage(null);
		expect(res.registryDigest).toBeUndefined();
	});
});
