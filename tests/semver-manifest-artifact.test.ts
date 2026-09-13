/**
 * classifyManifest / isRunnableImage: tell a real container image apart from a
 * Helm chart or other OCI artifact published into the same repo, using only the
 * manifest media types (the values seen on a real monorepo like maximhq/bifrost).
 */
import { describe, it, expect } from 'bun:test';
import { classifyManifest, isRunnableImage } from '../src/lib/server/semver/manifest-artifact';

describe('classifyManifest', () => {
	it('multi-arch OCI image index -> image', () => {
		expect(classifyManifest({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{}, {}] })).toBe('image');
	});

	it('docker manifest list -> image', () => {
		expect(classifyManifest({ manifests: [{}] }, 'application/vnd.docker.distribution.manifest.list.v2+json')).toBe('image');
	});

	it('single OCI image manifest -> image', () => {
		expect(classifyManifest({ config: { mediaType: 'application/vnd.oci.image.config.v1+json' } })).toBe('image');
	});

	it('docker v2 image config -> image', () => {
		expect(classifyManifest({ config: { mediaType: 'application/vnd.docker.container.image.v1+json' } })).toBe('image');
	});

	it('Helm chart config -> chart (the bifrost 2.1.29 case)', () => {
		expect(classifyManifest({ config: { mediaType: 'application/vnd.cncf.helm.config.v1+json' } })).toBe('chart');
	});

	it('unknown non-image config on a single manifest -> other', () => {
		expect(classifyManifest({ config: { mediaType: 'application/vnd.example.sbom.v1+json' } })).toBe('other');
	});

	it('recognized image manifest type with no config -> image', () => {
		expect(classifyManifest({}, 'application/vnd.docker.distribution.manifest.v2+json')).toBe('image');
	});

	// Fail-open: never hide a real update because a registry omitted a field.
	it('null / empty manifest -> image (fail-open)', () => {
		expect(classifyManifest(null)).toBe('image');
		expect(classifyManifest({})).toBe('image');
	});

	it('isRunnableImage mirrors the image verdict', () => {
		expect(isRunnableImage({ config: { mediaType: 'application/vnd.oci.image.config.v1+json' } })).toBe(true);
		expect(isRunnableImage({ config: { mediaType: 'application/vnd.cncf.helm.config.v1+json' } })).toBe(false);
	});
});
