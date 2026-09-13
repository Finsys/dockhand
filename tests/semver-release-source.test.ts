/**
 * resolveReleaseSource: where to fetch release notes for an image, across the
 * forge families semver supports (GitHub, Gitea/Forgejo, GHCR).
 */
import { describe, it, expect } from 'bun:test';
import {
	resolveReleaseSource,
	resolveReleaseSourceCandidates
} from '../src/lib/server/semver/release-source';

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

describe('resolveReleaseSourceCandidates', () => {
	it('returns the single confident source (no guesses) when a source label exists', () => {
		const cands = resolveReleaseSourceCandidates('whatever:1', {
			'org.opencontainers.image.source': 'https://github.com/traefik/traefik'
		});
		expect(cands).toHaveLength(1);
		expect(cands[0].slug).toBe('traefik/traefik');
		expect(cands[0].needsValidation).toBeUndefined();
	});

	it('guesses a GitHub repo from a Docker Hub image name (grafana/grafana)', () => {
		const cands = resolveReleaseSourceCandidates('grafana/grafana:11.0.0');
		expect(cands).toHaveLength(1);
		expect(cands[0].kind).toBe('github');
		expect(cands[0].slug).toBe('grafana/grafana');
		expect(cands[0].needsValidation).toBe(true);
		expect(cands[0].apiBase).toBe('https://api.github.com/repos/grafana/grafana/releases');
	});

	it('drops a registry host segment before guessing (registry.io/org/app -> org/app)', () => {
		const cands = resolveReleaseSourceCandidates('registry.example.com/acme/app:2.1');
		expect(cands[0].slug).toBe('acme/app');
		expect(cands[0].needsValidation).toBe(true);
	});

	it('does NOT guess a slug for a single-name official image (nginx)', () => {
		expect(resolveReleaseSourceCandidates('nginx:1.25')).toHaveLength(0);
	});

	it('harvests a github URL from a non-source label', () => {
		const cands = resolveReleaseSourceCandidates('nginx:1.25', {
			'org.opencontainers.image.url': 'https://github.com/acme/proxy'
		});
		expect(cands.some((c) => c.slug === 'acme/proxy' && c.needsValidation)).toBe(true);
	});

	it('dedupes the image-name guess and a matching label URL', () => {
		const cands = resolveReleaseSourceCandidates('grafana/grafana:11', {
			'org.opencontainers.image.documentation': 'https://github.com/grafana/grafana/blob/main/README.md'
		});
		expect(cands.filter((c) => c.slug === 'grafana/grafana')).toHaveLength(1);
	});

	it('ignores the source label key when harvesting other labels', () => {
		// A source label host that is not github/ghcr yields a confident gitea source,
		// so candidates is just that one - no guessing happens.
		const cands = resolveReleaseSourceCandidates('x:1', {
			'org.opencontainers.image.source': 'https://git.example.com/team/app'
		});
		expect(cands).toHaveLength(1);
		expect(cands[0].kind).toBe('gitea');
		expect(cands[0].needsValidation).toBeUndefined();
	});
});
