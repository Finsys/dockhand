import { describe, test, expect } from 'bun:test';
import { indexChildDigests, localDigestIsIndexChild } from '../src/lib/server/scheduler/tasks/update-utils';

// Real shape from ghcr.io/mastodon/mastodon:v4.6.5 (the #1367 repro): an OCI index
// whose per-arch child digests differ from the index digest a HEAD returns.
const MASTODON_INDEX = {
	mediaType: 'application/vnd.oci.image.index.v1+json',
	manifests: [
		{ platform: { architecture: 'arm64', os: 'linux' }, digest: 'sha256:2cd8bcf2e903dab42a759956008e17da16a1268e842e738c2c640f6f7b54bae8' },
		{ platform: { architecture: 'amd64', os: 'linux' }, digest: 'sha256:696439e1ada71d0cf3d51d4d6a4744d6e40b57aafa64980b18f4d3b78230d0cf' }
	]
};
const INDEX_DIGEST = 'sha256:77f11d1a6c674664217372d94ccdb9203524c60447827fe74ab6e11466825815';
const AMD64_CHILD = 'sha256:696439e1ada71d0cf3d51d4d6a4744d6e40b57aafa64980b18f4d3b78230d0cf';

describe('indexChildDigests', () => {
	test('extracts every per-arch child digest from an image index', () => {
		expect(indexChildDigests(MASTODON_INDEX)).toEqual([
			'sha256:2cd8bcf2e903dab42a759956008e17da16a1268e842e738c2c640f6f7b54bae8',
			AMD64_CHILD
		]);
	});

	test('returns [] for a single-arch manifest (no manifests array)', () => {
		expect(indexChildDigests({ mediaType: 'application/vnd.oci.image.manifest.v1+json', layers: [] })).toEqual([]);
	});

	test('returns [] for null / garbage / error bodies without throwing', () => {
		expect(indexChildDigests(null)).toEqual([]);
		expect(indexChildDigests(undefined)).toEqual([]);
		expect(indexChildDigests('not json')).toEqual([]);
		expect(indexChildDigests({ errors: [{ code: 'MANIFEST_UNKNOWN' }] })).toEqual([]);
	});

	test('skips malformed manifest entries (missing/empty/non-string digest)', () => {
		const body = { manifests: [{ digest: AMD64_CHILD }, { digest: '' }, { digest: 42 }, {}, null] };
		expect(indexChildDigests(body)).toEqual([AMD64_CHILD]);
	});
});

describe('localDigestIsIndexChild', () => {
	test('true when local per-arch digest is a child of the index (the #1367 fix)', () => {
		// local image recorded its amd64 per-arch digest, HEAD returned the index digest
		expect(localDigestIsIndexChild([AMD64_CHILD], MASTODON_INDEX)).toBe(true);
	});

	test('false when the local digest is the index digest itself (already handled upstream)', () => {
		// upstream matches this against the HEAD digest first; here it is NOT a child
		expect(localDigestIsIndexChild([INDEX_DIGEST], MASTODON_INDEX)).toBe(false);
	});

	test('false when local digest is genuinely unrelated (a real update)', () => {
		expect(localDigestIsIndexChild(['sha256:deadbeef'], MASTODON_INDEX)).toBe(false);
	});

	test('false for a non-index body (single-arch / error) - degrades to "keep update"', () => {
		expect(localDigestIsIndexChild([AMD64_CHILD], { layers: [] })).toBe(false);
		expect(localDigestIsIndexChild([AMD64_CHILD], null)).toBe(false);
	});

	test('matches if ANY of several local digests is a child', () => {
		expect(localDigestIsIndexChild(['sha256:unrelated', AMD64_CHILD], MASTODON_INDEX)).toBe(true);
	});
});
