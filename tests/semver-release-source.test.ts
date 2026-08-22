/**
 * resolveReleaseSource: where to fetch release notes for an image, across the
 * forge families semver supports (GitHub, Gitea/Forgejo, GHCR).
 */
import { describe, it, expect } from 'bun:test';
import { resolveReleaseSource } from '../src/lib/server/semver/release-source';

describe('resolveReleaseSource', () => {
	it('resolves a GitHub source label to the GitHub releases API', () => {
		const src = resolveReleaseSource('traefik:v3.0', {
			'org.opencontainers.image.source': 'https://github.com/traefik/traefik'
		});
		expect(src).toEqual({
			kind: 'github',
			slug: 'traefik/traefik',
			apiBase: 'https://api.github.com/repos/traefik/traefik/releases',
			releasesUrl: 'https://github.com/traefik/traefik/releases'
		});
	});

	it('resolves a Codeberg (Forgejo) source label to that host\'s Gitea API', () => {
		const src = resolveReleaseSource('codeberg.org/forgejo/forgejo:9.0.0', {
			'org.opencontainers.image.source': 'https://codeberg.org/forgejo/forgejo'
		});
		expect(src).toEqual({
			kind: 'gitea',
			slug: 'forgejo/forgejo',
			apiBase: 'https://codeberg.org/api/v1/repos/forgejo/forgejo/releases',
			releasesUrl: 'https://codeberg.org/forgejo/forgejo/releases'
		});
	});

	it('treats any self-hosted Gitea host the same way', () => {
		const src = resolveReleaseSource('git.example.com/team/app:1.0', {
			'org.opencontainers.image.source': 'https://git.example.com/team/app'
		});
		expect(src?.kind).toBe('gitea');
		expect(src?.apiBase).toBe('https://git.example.com/api/v1/repos/team/app/releases');
	});

	it('resolves a ghcr.io image name to GitHub without any label', () => {
		const src = resolveReleaseSource('ghcr.io/immich-app/immich-server:v1.100.0');
		expect(src?.kind).toBe('github');
		expect(src?.slug).toBe('immich-app/immich-server');
	});

	it('tolerates a trailing .git and slash in the source URL', () => {
		const src = resolveReleaseSource('x:1', {
			'org.opencontainers.image.source': 'https://github.com/owner/repo.git/'
		});
		expect(src?.slug).toBe('owner/repo');
	});

	it('returns null for a plain Docker Hub image with no source', () => {
		expect(resolveReleaseSource('nginx:1.25')).toBeNull();
		expect(resolveReleaseSource('postgres:16.2-alpine', {})).toBeNull();
	});

	it('returns null for a single-segment ghcr path (malformed)', () => {
		expect(resolveReleaseSource('ghcr.io/something:1')).toBeNull();
	});
});
