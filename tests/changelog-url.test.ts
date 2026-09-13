import { describe, expect, test } from 'bun:test';
import { resolveChangelogUrl, interpolateChangelogUrl } from '../src/lib/utils/changelog-url';

describe('resolveChangelogUrl', () => {
	test('dockhand.changelog.url override wins over everything', () => {
		expect(
			resolveChangelogUrl('ghcr.io/owner/repo:latest', {
				'dockhand.changelog.url': 'https://example.com/notes',
				'org.opencontainers.image.source': 'https://github.com/somebody/else'
			})
		).toBe('https://example.com/notes');
	});

	test('OCI source label → /releases', () => {
		expect(
			resolveChangelogUrl('docker.io/foo/bar:1.0', {
				'org.opencontainers.image.source': 'https://github.com/foo/bar'
			})
		).toBe('https://github.com/foo/bar/releases');
	});

	test('OCI source label with trailing slash is normalized', () => {
		expect(
			resolveChangelogUrl('foo:1.0', {
				'org.opencontainers.image.source': 'https://github.com/foo/bar/'
			})
		).toBe('https://github.com/foo/bar/releases');
	});

	test('OCI source label that does not point at GitHub is ignored', () => {
		expect(
			resolveChangelogUrl('gitlab.com/foo/bar', {
				'org.opencontainers.image.source': 'https://gitlab.com/foo/bar'
			})
		).toBeNull();
	});

	test('GHCR heuristic with tag', () => {
		expect(resolveChangelogUrl('ghcr.io/linuxserver/sabnzbd:latest', null)).toBe(
			'https://github.com/linuxserver/sabnzbd/releases'
		);
	});

	test('GHCR heuristic with digest', () => {
		expect(
			resolveChangelogUrl('ghcr.io/linuxserver/sabnzbd@sha256:abc123', null)
		).toBe('https://github.com/linuxserver/sabnzbd/releases');
	});

	test('GHCR heuristic with nested path', () => {
		expect(resolveChangelogUrl('ghcr.io/org/team/svc:1.2.3', null)).toBe(
			'https://github.com/org/team/svc/releases'
		);
	});

	test('malformed GHCR (single segment) returns null', () => {
		expect(resolveChangelogUrl('ghcr.io/alone:latest', null)).toBeNull();
	});

	test('Docker Hub image with no labels returns null', () => {
		expect(resolveChangelogUrl('nginx:latest', {})).toBeNull();
	});

	test('null inputs are handled', () => {
		expect(resolveChangelogUrl(null)).toBeNull();
		expect(resolveChangelogUrl(undefined)).toBeNull();
		expect(resolveChangelogUrl('', {})).toBeNull();
	});

	test('empty override label is ignored, falls through to next tier', () => {
		expect(
			resolveChangelogUrl('ghcr.io/owner/repo', {
				'dockhand.changelog.url': '   '
			})
		).toBe('https://github.com/owner/repo/releases');
	});

	// Backward compat: a plain (no-placeholder) override is returned verbatim,
	// whether or not a version is passed - unchanged from before templating.
	test('plain override URL is unchanged with or without a version', () => {
		const labels = { 'dockhand.changelog.url': 'https://nginx.org/en/CHANGES' };
		expect(resolveChangelogUrl('nginx:1.27', labels)).toBe('https://nginx.org/en/CHANGES');
		expect(resolveChangelogUrl('nginx:1.27', labels, '1.27')).toBe('https://nginx.org/en/CHANGES');
	});

	test('{{version}} / {{tag}} override is interpolated when a version is given', () => {
		const labels = { 'dockhand.changelog.url': 'https://github.com/maximhq/bifrost/releases/tag/transports/{{version}}' };
		expect(resolveChangelogUrl('maximhq/bifrost:1.6.11', labels, '1.6.11')).toBe(
			'https://github.com/maximhq/bifrost/releases/tag/transports/1.6.11'
		);
		const tagLabel = { 'dockhand.changelog.url': 'https://ex.com/r/{{ tag }}/notes' };
		expect(resolveChangelogUrl('x:2.0', tagLabel, '2.0')).toBe('https://ex.com/r/2.0/notes');
	});

	test('templated override with NO version passed is left as-is (generic list link)', () => {
		const labels = { 'dockhand.changelog.url': 'https://ex.com/tag/{{version}}' };
		// The container/stack list calls resolveChangelogUrl without a target version.
		expect(resolveChangelogUrl('x:1.0', labels)).toBe('https://ex.com/tag/{{version}}');
	});
});

describe('interpolateChangelogUrl', () => {
	test('no placeholder -> unchanged', () => {
		expect(interpolateChangelogUrl('https://a/b', '1.2.3')).toBe('https://a/b');
	});
	test('no version -> unchanged (even with a placeholder)', () => {
		expect(interpolateChangelogUrl('https://a/{{version}}', null)).toBe('https://a/{{version}}');
		expect(interpolateChangelogUrl('https://a/{{version}}')).toBe('https://a/{{version}}');
	});
	test('replaces every {{version}} and {{tag}}, case/space tolerant', () => {
		expect(interpolateChangelogUrl('https://a/{{version}}/{{ TAG }}/{{version}}', 'v9')).toBe('https://a/v9/v9/v9');
	});
});
