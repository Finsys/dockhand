/**
 * runningPlatformChildDigest selects the digest of the image a container is ACTUALLY running
 * from a containerd image store's `GET /images/{id}/json?manifests=true` Manifests[]: the
 * `image` entry that is `Available` AND matches the daemon platform. The shapes below are the
 * real response captured from Docker 29.4 (alpine:3.20, 16 entries) and the old-docker fallback
 * (Docker 20.10/API 1.41, 200 with no Manifests).
 */
import { describe, test, expect } from 'bun:test';
import { runningPlatformChildDigest } from '../src/lib/server/scheduler/tasks/update-utils';

const AMD64_IMG = 'sha256:c64c687cbea9300178b30c900000000000000000000000000000000000000000';
const ARM64_IMG = 'sha256:45e09956dc667c5eff3583c900000000000000000000000000000000000000000';

// A trimmed-but-faithful alpine:3.20 Manifests[] - image + attestation entries, one Available.
const manifests = [
	{ Kind: 'image', Available: false, Descriptor: { digest: AMD64_IMG, platform: { os: 'linux', architecture: 'amd64' } } },
	{ Kind: 'attestation', Available: false, Descriptor: { digest: 'sha256:6243dec900000000000000000000000000000000000000000000000000000000', platform: { os: 'unknown', architecture: 'unknown' } } },
	{ Kind: 'image', Available: true, Descriptor: { digest: ARM64_IMG, platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } } },
	{ Kind: 'attestation', Available: true, Descriptor: { digest: 'sha256:1db32a7900000000000000000000000000000000000000000000000000000000', platform: { os: 'unknown', architecture: 'unknown' } } }
];

describe('runningPlatformChildDigest', () => {
	test('picks the Available image entry for the daemon platform', () => {
		expect(runningPlatformChildDigest(manifests, { os: 'linux', architecture: 'arm64', variant: 'v8' })).toBe(ARM64_IMG);
	});

	test('ignores an entry that matches the platform but is NOT Available (not the running image)', () => {
		// amd64 matches but Available:false (its layers are not pulled on this host) -> null, not AMD64_IMG.
		expect(runningPlatformChildDigest(manifests, { os: 'linux', architecture: 'amd64' })).toBeNull();
	});

	test('ignores attestation entries even when Available', () => {
		// The only Available entries for unknown/unknown are attestations - never returned.
		expect(runningPlatformChildDigest(manifests, { os: 'unknown', architecture: 'unknown' })).toBeNull();
	});

	test('matches a plain arm64 daemon (no variant) against an entry that declares a variant', () => {
		expect(runningPlatformChildDigest(manifests, { os: 'linux', architecture: 'arm64' })).toBe(ARM64_IMG);
	});

	test('a single Available amd64 image is returned for an amd64 daemon', () => {
		const single = [{ Kind: 'image', Available: true, Descriptor: { digest: AMD64_IMG, platform: { os: 'linux', architecture: 'amd64' } } }];
		expect(runningPlatformChildDigest(single, { os: 'linux', architecture: 'amd64' })).toBe(AMD64_IMG);
	});

	test('fallback: no Manifests field (old daemon / classic store) returns null', () => {
		// old-docker (Docker 20.10/API 1.41) answers 200 with no Manifests; the resolver passes
		// data?.Manifests (undefined) here, so the caller falls back to the RepoDigests index.
		expect(runningPlatformChildDigest(undefined, { os: 'linux', architecture: 'amd64' })).toBeNull();
		expect(runningPlatformChildDigest([], { os: 'linux', architecture: 'amd64' })).toBeNull();
	});

	test('null/garbage is null, never a throw', () => {
		expect(runningPlatformChildDigest(null, { os: 'linux', architecture: 'amd64' })).toBeNull();
		expect(runningPlatformChildDigest('nope', { os: 'linux', architecture: 'amd64' })).toBeNull();
		expect(runningPlatformChildDigest([{ Kind: 'image', Available: true }], { os: 'linux', architecture: 'amd64' })).toBeNull();
	});
});
