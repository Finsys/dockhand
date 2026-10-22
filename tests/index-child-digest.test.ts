import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	indexChildDigests,
	localDigestIsIndexChild,
	platformChildDigest,
	samePlatformImage
} from '../src/lib/server/scheduler/tasks/update-utils';

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

// Real shape from caddy:2 on linux/amd64: the tag was republished, the index
// digest moved (f2a1290d... -> 685ae3d7...), but both indexes carry the SAME amd64 image
// (173b2630...), so the platform image did not change and there is nothing to update.
const AMD64 = { os: 'linux', architecture: 'amd64' };
const CADDY_AMD64 = 'sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229';
const OLD_CADDY_INDEX = {
	mediaType: 'application/vnd.oci.image.index.v1+json',
	manifests: [
		{ platform: { architecture: 'amd64', os: 'linux' }, digest: CADDY_AMD64 },
		{ platform: { architecture: 'arm64', os: 'linux' }, digest: 'sha256:aaa0000000000000000000000000000000000000000000000000000000000001' },
		{ platform: { architecture: 'unknown', os: 'unknown' }, digest: 'sha256:bbb0000000000000000000000000000000000000000000000000000000000002' }
	]
};
const NEW_CADDY_INDEX = {
	mediaType: 'application/vnd.oci.image.index.v1+json',
	manifests: [
		{ platform: { architecture: 'amd64', os: 'linux' }, digest: CADDY_AMD64 },
		// arm64 rebuilt this republish - the only thing that actually changed
		{ platform: { architecture: 'arm64', os: 'linux' }, digest: 'sha256:ccc0000000000000000000000000000000000000000000000000000000000003' },
		{ platform: { architecture: 'unknown', os: 'unknown' }, digest: 'sha256:ddd0000000000000000000000000000000000000000000000000000000000004' }
	]
};

describe('platformChildDigest', () => {
	test('returns the entry digest for the daemon platform', () => {
		expect(platformChildDigest(NEW_CADDY_INDEX, AMD64)).toBe(CADDY_AMD64);
	});

	test('returns null when the index has no entry for the platform', () => {
		expect(platformChildDigest(NEW_CADDY_INDEX, { os: 'linux', architecture: 's390x' })).toBeNull();
	});

	test('matches on os AND architecture, not architecture alone', () => {
		// A real multi-arch tag carries the same architecture under different operating
		// systems (windows/amd64 beside linux/amd64). Matching arch only would hand back a
		// windows digest for a linux daemon.
		const idx = { manifests: [
			{ platform: { os: 'windows', architecture: 'amd64' }, digest: 'sha256:' + 'w'.repeat(64) },
			{ platform: { os: 'linux', architecture: 'amd64' }, digest: 'sha256:' + 'l'.repeat(64) }
		] };
		expect(platformChildDigest(idx, { os: 'linux', architecture: 'amd64' })).toBe('sha256:' + 'l'.repeat(64));
		expect(platformChildDigest(idx, { os: 'windows', architecture: 'amd64' })).toBe('sha256:' + 'w'.repeat(64));
		expect(platformChildDigest(idx, { os: 'freebsd', architecture: 'amd64' })).toBeNull();
	});

	test('returns null for a non-index body or garbage, without throwing', () => {
		expect(platformChildDigest({ layers: [] }, AMD64)).toBeNull();
		expect(platformChildDigest(null, AMD64)).toBeNull();
		expect(platformChildDigest('nope', AMD64)).toBeNull();
	});

	test('matches a plain arm64 entry when the daemon reports no variant', () => {
		const idx = { manifests: [{ platform: { os: 'linux', architecture: 'arm64' }, digest: 'sha256:'+'e'.repeat(64) }] };
		expect(platformChildDigest(idx, { os: 'linux', architecture: 'arm64' })).toBe('sha256:'+'e'.repeat(64));
	});

	test('respects variant when the entry declares one', () => {
		const idx = { manifests: [
			{ platform: { os: 'linux', architecture: 'arm', variant: 'v7' }, digest: 'sha256:'+'7'.repeat(64) },
			{ platform: { os: 'linux', architecture: 'arm', variant: 'v6' }, digest: 'sha256:'+'6'.repeat(64) }
		] };
		expect(platformChildDigest(idx, { os: 'linux', architecture: 'arm', variant: 'v6' })).toBe('sha256:'+'6'.repeat(64));
	});
});

describe('samePlatformImage (#1756 phantom update)', () => {
	test('true when both indexes carry the same image for the platform', () => {
		// The report's exact case: index digests differ, amd64 image identical.
		expect(samePlatformImage(OLD_CADDY_INDEX, NEW_CADDY_INDEX, AMD64)).toBe(true);
	});

	test('false when the platform image actually changed (a real update)', () => {
		const changed = { manifests: [{ platform: { os: 'linux', architecture: 'amd64' }, digest: 'sha256:'+'f'.repeat(64) }] };
		expect(samePlatformImage(OLD_CADDY_INDEX, changed, AMD64)).toBe(false);
	});

	test('false when either side is not an index (cannot prove same image)', () => {
		expect(samePlatformImage({ layers: [] }, NEW_CADDY_INDEX, AMD64)).toBe(false);
		expect(samePlatformImage(OLD_CADDY_INDEX, { layers: [] }, AMD64)).toBe(false);
	});

	test('false when the platform is absent from one side', () => {
		const noAmd = { manifests: [{ platform: { os: 'linux', architecture: 'arm64' }, digest: 'sha256:'+'a'.repeat(64) }] };
		expect(samePlatformImage(OLD_CADDY_INDEX, noAmd, AMD64)).toBe(false);
	});

	test('false when NEITHER side has the platform entry (not "both null are equal")', () => {
		// Both indexes lack the queried platform, so platformChildDigest returns null on
		// both sides. Without the explicit not-null guard, null === null would read as
		// "same image" and wrongly suppress a real update. The daemon platform here is
		// present in neither index.
		const onlyArm = { manifests: [{ platform: { os: 'linux', architecture: 'arm64' }, digest: 'sha256:'+'a'.repeat(64) }] };
		const onlyArmToo = { manifests: [{ platform: { os: 'linux', architecture: 'arm64' }, digest: 'sha256:'+'b'.repeat(64) }] };
		expect(samePlatformImage(onlyArm, onlyArmToo, { os: 'linux', architecture: 's390x' })).toBe(false);
	});
});

/**
 * The wiring in docker.ts, pinned at SOURCE level because that module cannot be imported
 * under bun (better-sqlite3). These assert the branch is SPELLED, not that it runs; the
 * behaviour is pinned by the samePlatformImage/platformChildDigest tests above. They are a
 * tripwire against the phantom-update branch being dropped or rewired to compare the wrong bodies.
 */
describe('localImageMatchesRegistry wires the phantom-update check', () => {
	const src = readFileSync(new URL('../src/lib/server/docker.ts', import.meta.url), 'utf8');
	const fn = src.slice(src.indexOf('async function localImageMatchesRegistry'),
		src.indexOf('export interface ImageUpdateCheckResult'));

	test('it still rules out the #1367 per-arch child case', () => {
		expect(fn).toContain('localDigestIsIndexChild(localDigests, registryIndex)');
	});

	test('it compares the daemon-platform entry of the local and registry indexes', () => {
		expect(fn).toContain('imagePlatform(info?.OSType, info?.Architecture)');
		expect(fn).toContain('samePlatformImage(localIndex, registryIndex, platform)');
	});

	test('the check runs on the already-flagged path before declaring an update', () => {
		expect(src).toContain('if (await localImageMatchesRegistry(imageName, localDigests, envId)) {');
	});
});
