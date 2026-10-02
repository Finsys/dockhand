import { describe, expect, test } from 'bun:test';
import { DEFAULT_GRYPE_IMAGE, DEFAULT_TRIVY_IMAGE, imageRepo, imageTag, scannerToolInventory } from '../src/lib/utils/scanner-images';

/**
 * The scanner image defaults, and the rule that a configured image always wins.
 * A bump here must never start overriding what an install chose for itself.
 */

// How the server resolves the image it will actually run.
const resolve = (stored: string | null | undefined, fallback: string) => stored ?? fallback;

describe('default scanner images', () => {
	test('both are pinned to an exact version, never a floating tag', () => {
		// A moving tag makes a scan unreproducible and re-opens the supply-chain
		// hole the pinning exists to close.
		for (const img of [DEFAULT_GRYPE_IMAGE, DEFAULT_TRIVY_IMAGE]) {
			const tag = img.split(':')[1];
			expect(tag).toBeTruthy();
			expect(tag).not.toBe('latest');
			expect(tag).toMatch(/^v?\d+\.\d+\.\d+$/);
		}
	});

	test('each carries the tag style its upstream actually publishes', () => {
		// grype tags are v-prefixed, trivy tags are not - a mismatch pulls nothing.
		expect(DEFAULT_GRYPE_IMAGE).toMatch(/^anchore\/grype:v\d/);
		expect(DEFAULT_TRIVY_IMAGE).toMatch(/^aquasec\/trivy:\d/);
	});
});

describe('a configured image wins over the default', () => {
	test('a stored image is used as-is', () => {
		expect(resolve('anchore/grype:v0.100.0', DEFAULT_GRYPE_IMAGE)).toBe('anchore/grype:v0.100.0');
	});

	test('an install pinned to an OLDER version keeps it after a bump', () => {
		// The point of the setting: bumping the default must not drag an install
		// onto a version it deliberately did not choose.
		const pinned = 'aquasec/trivy:0.60.0';
		expect(resolve(pinned, DEFAULT_TRIVY_IMAGE)).toBe(pinned);
		expect(resolve(pinned, DEFAULT_TRIVY_IMAGE)).not.toBe(DEFAULT_TRIVY_IMAGE);
	});

	test('a different registry or repository is kept too', () => {
		const mirrored = 'ghcr.io/anchore/grype:v0.119.0';
		expect(resolve(mirrored, DEFAULT_GRYPE_IMAGE)).toBe(mirrored);
	});

	test('nothing stored falls back to the default', () => {
		expect(resolve(null, DEFAULT_GRYPE_IMAGE)).toBe(DEFAULT_GRYPE_IMAGE);
		expect(resolve(undefined, DEFAULT_TRIVY_IMAGE)).toBe(DEFAULT_TRIVY_IMAGE);
	});
});

describe('splitting an image reference', () => {
	test('repo and tag', () => {
		expect(imageRepo('anchore/grype:v0.119.0')).toBe('anchore/grype');
		expect(imageTag('anchore/grype:v0.119.0')).toBe('v0.119.0');
	});

	test('a registry PORT is not mistaken for a tag', () => {
		// The naive split(':') reads 5000/grype as the tag and loses the repo.
		expect(imageRepo('registry.local:5000/anchore/grype:v0.119.0')).toBe('registry.local:5000/anchore/grype');
		expect(imageTag('registry.local:5000/anchore/grype:v0.119.0')).toBe('v0.119.0');
		expect(imageRepo('registry.local:5000/anchore/grype')).toBe('registry.local:5000/anchore/grype');
		expect(imageTag('registry.local:5000/anchore/grype')).toBe('latest');
	});

	test('no tag means latest', () => {
		expect(imageTag('anchore/grype')).toBe('latest');
		expect(imageRepo('anchore/grype')).toBe('anchore/grype');
	});
});

describe('scannerToolInventory', () => {
	test('describes the images it is given, not a hardcoded pair', () => {
		const [grype, trivy] = scannerToolInventory(DEFAULT_GRYPE_IMAGE, DEFAULT_TRIVY_IMAGE);
		expect(grype.name).toBe('anchore/grype');
		expect(grype.version).toBe(imageTag(DEFAULT_GRYPE_IMAGE));
		expect(trivy.name).toBe('aquasec/trivy');
		expect(trivy.version).toBe(imageTag(DEFAULT_TRIVY_IMAGE));
	});

	test('a mirrored image is reported under the name it actually has', () => {
		// A hardcoded name would claim docker.io here and misreport the inventory.
		const [grype] = scannerToolInventory('ghcr.io/anchore/grype:v0.119.0', DEFAULT_TRIVY_IMAGE);
		expect(grype.name).toBe('ghcr.io/anchore/grype');
		expect(grype.version).toBe('v0.119.0');
	});
});

describe('retagging an image to a new version', () => {
	// What the UI does when a newer release is applied. The naive split(':')[0]
	// turns registry.local:5000/anchore/grype into registry.local, so the saved
	// image points at nothing and the user's registry is lost.
	const retag = (current: string, version: string) => `${imageRepo(current)}:${version}`;

	test('a plain docker hub image', () => {
		expect(retag('anchore/grype:v0.115.0', 'v0.119.0')).toBe('anchore/grype:v0.119.0');
	});

	test('a private registry WITH a port survives', () => {
		expect(retag('registry.local:5000/anchore/grype:v0.115.0', 'v0.119.0'))
			.toBe('registry.local:5000/anchore/grype:v0.119.0');
	});

	test('a mirrored registry without a port', () => {
		expect(retag('ghcr.io/anchore/grype:v0.115.0', 'v0.119.0')).toBe('ghcr.io/anchore/grype:v0.119.0');
	});

	test('an image with no tag at all', () => {
		expect(retag('anchore/grype', 'v0.119.0')).toBe('anchore/grype:v0.119.0');
	});
});
