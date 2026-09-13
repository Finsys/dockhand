/**
 * buildPinnedRef: turn a repo:tag + RepoDigests into a supply-chain-hardened
 * `repo:tag@sha256:...` reference for the "copy pinned reference" button.
 */
import { describe, it, expect } from 'bun:test';
import { buildPinnedRef, shortDigest, repoBaseOf } from '../src/lib/utils/pinned-ref';

describe('repoBaseOf (#1437: digest-pinned running image)', () => {
	it('strips both tag and digest from a digest-pinned running image', () => {
		// The bug: the running image is repo:tag@sha256:..., and cutting at the last
		// colon lands inside @sha256:, leaving repo:tag@sha256 and duplicating the tag.
		expect(
			repoBaseOf(
				'ghcr.io/github/github-mcp-server:v1.10.0@sha256:1817b57d43916532dc002bdc5f344d639bd9fb54a9148d42168458f7c3280567'
			)
		).toBe('ghcr.io/github/github-mcp-server');
		expect(
			repoBaseOf(
				'ghcr.io/searxng/searxng:2026.8.19-5ffd32ca2@sha256:3cb8eba87bb347613fab9dfe87d448c21300b8f0648295c93b85f4246e93ae73'
			)
		).toBe('ghcr.io/searxng/searxng');
	});

	it('handles a plain repo:tag, a bare repo, and a host:port registry', () => {
		expect(repoBaseOf('ghcr.io/owner/app:1.2')).toBe('ghcr.io/owner/app');
		expect(repoBaseOf('nginx:1.25')).toBe('nginx');
		expect(repoBaseOf('nginx')).toBe('nginx');
		expect(repoBaseOf('registry.local:5000/app:1.2')).toBe('registry.local:5000/app');
		expect(repoBaseOf('registry.local:5000/app:1.2@sha256:abc')).toBe('registry.local:5000/app');
	});
});

describe('buildPinnedRef', () => {
	it('keeps the tag and pins the matching digest', () => {
		expect(buildPinnedRef('nginx:1.25', ['nginx@sha256:abc'])).toBe('nginx:1.25@sha256:abc');
	});

	it('matches the digest by repo when several are present', () => {
		const digests = ['other/app@sha256:zzz', 'nginx@sha256:abc'];
		expect(buildPinnedRef('nginx:1.25', digests)).toBe('nginx:1.25@sha256:abc');
	});

	it('handles a registry host:port in the repo', () => {
		expect(buildPinnedRef('registry.example.com:5000/app:v2', ['registry.example.com:5000/app@sha256:def']))
			.toBe('registry.example.com:5000/app:v2@sha256:def');
	});

	it('falls back to the sole digest when the repo does not string-match', () => {
		// Docker normalizes library images; the tag may read `nginx` while the digest
		// reads `docker.io/library/nginx`. With a single digest, use it.
		expect(buildPinnedRef('nginx:latest', ['docker.io/library/nginx@sha256:abc']))
			.toBe('nginx:latest@sha256:abc');
	});

	it('produces repo@digest when there is no tag', () => {
		expect(buildPinnedRef('nginx', ['nginx@sha256:abc'])).toBe('nginx@sha256:abc');
	});

	it('returns null when the image has no RepoDigests (local-only image)', () => {
		expect(buildPinnedRef('myapp:dev', [])).toBeNull();
		expect(buildPinnedRef('myapp:dev', undefined)).toBeNull();
	});

	it('returns null when multiple digests exist and none match the repo', () => {
		expect(buildPinnedRef('nginx:1.25', ['a/b@sha256:1', 'c/d@sha256:2'])).toBeNull();
	});
});

describe('shortDigest', () => {
	it('keeps the sha256: prefix and shortens the hex', () => {
		expect(shortDigest('nginx:1.25', ['nginx@sha256:abcdef0123456789abcdef'], 12)).toBe('sha256:abcdef012345');
	});

	it('returns null when there is no usable digest', () => {
		expect(shortDigest('myapp:dev', [])).toBeNull();
	});
});
