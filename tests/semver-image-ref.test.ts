/**
 * Image reference parsing across the registries semver has to handle.
 */
import { describe, it, expect } from 'bun:test';
import { parseImageReference, isDockerHub, isGhcr } from '../src/lib/server/registry/image-ref';

describe('parseImageReference', () => {
	it('defaults a bare official image to Docker Hub library/', () => {
		expect(parseImageReference('nginx:1.25')).toEqual({
			registry: 'index.docker.io',
			repo: 'library/nginx',
			tag: '1.25'
		});
	});

	it('keeps a Hub user/repo', () => {
		expect(parseImageReference('grafana/grafana:11.0.0')).toEqual({
			registry: 'index.docker.io',
			repo: 'grafana/grafana',
			tag: '11.0.0'
		});
	});

	it('parses ghcr', () => {
		expect(parseImageReference('ghcr.io/user/app:v1.2')).toEqual({
			registry: 'ghcr.io',
			repo: 'user/app',
			tag: 'v1.2'
		});
	});

	it('parses codeberg (the forgejo case)', () => {
		expect(parseImageReference('codeberg.org/forgejo/forgejo:15.0.2')).toEqual({
			registry: 'codeberg.org',
			repo: 'forgejo/forgejo',
			tag: '15.0.2'
		});
	});

	it('parses a registry with a port', () => {
		expect(parseImageReference('registry.example.com:5000/repo:tag')).toEqual({
			registry: 'registry.example.com:5000',
			repo: 'repo',
			tag: 'tag'
		});
	});

	it('defaults the tag to latest and strips a digest', () => {
		expect(parseImageReference('nginx')).toMatchObject({ tag: 'latest' });
		expect(parseImageReference('nginx@sha256:abc')).toMatchObject({ repo: 'library/nginx', tag: 'latest' });
	});
});

describe('registry host predicates', () => {
	it('recognises every Docker Hub alias', () => {
		for (const h of ['index.docker.io', 'docker.io', 'registry-1.docker.io', 'hub.docker.com']) {
			expect(isDockerHub(h)).toBe(true);
		}
		expect(isDockerHub('ghcr.io')).toBe(false);
	});
	it('recognises ghcr', () => {
		expect(isGhcr('ghcr.io')).toBe(true);
		expect(isGhcr('codeberg.org')).toBe(false);
	});
});
