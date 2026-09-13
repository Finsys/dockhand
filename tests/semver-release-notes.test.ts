/**
 * matchReleasesToVersions: pair each wanted image tag with the forge release
 * whose tag is the SAME numeric version, ignoring v-prefix / flavor noise.
 */
import { describe, it, expect, mock } from 'bun:test';
import {
	matchReleasesToVersions,
	fetchReleaseNotes,
	resolveAndFetchReleaseNotes
} from '../src/lib/server/semver/release-notes';
import type { ReleaseSource } from '../src/lib/server/semver/release-source';

const rel = (tag: string, body = 'notes') => ({
	tag_name: tag,
	name: tag,
	body,
	published_at: '2024-01-01T00:00:00Z',
	html_url: `https://example/releases/tag/${tag}`
});

describe('matchReleasesToVersions', () => {
	it('matches v-prefixed forge tags to bare wanted versions', () => {
		const notes = matchReleasesToVersions(
			[rel('v3.7.10'), rel('v3.7.9'), rel('v3.6.0')],
			['3.7.9', '3.7.10']
		);
		expect(notes.map((n) => n.version)).toEqual(['3.7.9', '3.7.10']);
		expect(notes.map((n) => n.githubTag)).toEqual(['v3.7.9', 'v3.7.10']);
	});

	it('matches across flavor suffixes (16.4-alpine <-> v16.4)', () => {
		const notes = matchReleasesToVersions([rel('v16.4')], ['16.4-alpine']);
		expect(notes).toHaveLength(1);
		expect(notes[0].version).toBe('16.4-alpine');
		expect(notes[0].githubTag).toBe('v16.4');
	});

	it('drops wanted versions with no matching release', () => {
		const notes = matchReleasesToVersions([rel('v1.0.0')], ['1.0.0', '2.0.0']);
		expect(notes.map((n) => n.version)).toEqual(['1.0.0']);
	});

	it('ignores non-version wanted entries', () => {
		expect(matchReleasesToVersions([rel('v1.0.0')], ['latest'])).toEqual([]);
	});

	it('carries the release body, url and date through', () => {
		const notes = matchReleasesToVersions([rel('v1.2.3', '## Fixed things')], ['1.2.3']);
		expect(notes[0]).toMatchObject({
			version: '1.2.3',
			body: '## Fixed things',
			url: 'https://example/releases/tag/v1.2.3',
			publishedAt: '2024-01-01T00:00:00Z'
		});
	});
});

const giteaSource = (host: string): ReleaseSource => ({
	kind: 'gitea',
	slug: 'x/y',
	apiBase: `https://${host}/api/v1/repos/x/y/releases`,
	releasesUrl: `https://${host}/x/y/releases`
});

describe('fetchReleaseNotes SSRF guard', () => {
	// The gitea apiBase host comes from a container's image.source LABEL. A crafted
	// label must not turn this into a fetch of loopback/metadata.
	it('refuses a metadata / loopback forge host without fetching', async () => {
		for (const host of ['169.254.169.254', '127.0.0.1', 'localhost']) {
			const f = mock(async () => ({ ok: true, json: async () => [] }));
			const { notes } = await fetchReleaseNotes(giteaSource(host), ['1.0.0'], f as unknown as typeof fetch);
			expect(notes).toEqual([]);
			expect(f).not.toHaveBeenCalled();
		}
	});

	it('allows a LAN forge host', async () => {
		const f = mock(async () => ({ ok: true, json: async () => [] }));
		await fetchReleaseNotes(giteaSource('192.168.1.20'), ['1.0.0'], f as unknown as typeof fetch);
		expect(f).toHaveBeenCalled();
	});

	it('refuses to follow a redirect (possible bounce to a private host)', async () => {
		const f = mock(async () => ({ status: 302, ok: false, headers: { get: () => 'http://169.254.169.254/' }, json: async () => [] }));
		const { notes } = await fetchReleaseNotes(giteaSource('codeberg.org'), ['1.0.0'], f as unknown as typeof fetch);
		expect(notes).toEqual([]);
		expect(f).toHaveBeenCalledTimes(1); // one hop, then stop - no follow
	});
});

const githubSource = (): ReleaseSource => ({
	kind: 'github',
	slug: 'o/r',
	apiBase: 'https://api.github.com/repos/o/r/releases',
	releasesUrl: 'https://github.com/o/r/releases'
});

describe('fetchReleaseNotes rate-limit detection', () => {
	const hdr = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });

	it('flags rateLimited on a 403 with X-RateLimit-Remaining: 0', async () => {
		const f = mock(async () => ({ ok: false, status: 403, headers: hdr({ 'x-ratelimit-remaining': '0' }), json: async () => ({}) }));
		const r = await fetchReleaseNotes(githubSource(), ['1.0.0'], f as unknown as typeof fetch);
		expect(r.rateLimited).toBe(true);
		expect(r.notes).toEqual([]);
	});

	it('flags rateLimited on a 429 even without the header', async () => {
		const f = mock(async () => ({ ok: false, status: 429, headers: hdr({}), json: async () => ({}) }));
		const r = await fetchReleaseNotes(githubSource(), ['1.0.0'], f as unknown as typeof fetch);
		expect(r.rateLimited).toBe(true);
	});

	it('does NOT flag a 403 that is not a rate limit (remaining > 0)', async () => {
		const f = mock(async () => ({ ok: false, status: 403, headers: hdr({ 'x-ratelimit-remaining': '42' }), json: async () => ({}) }));
		const r = await fetchReleaseNotes(githubSource(), ['1.0.0'], f as unknown as typeof fetch);
		expect(r.rateLimited).toBe(false);
	});

	it('does NOT flag rateLimited for a non-github (gitea) forge', async () => {
		const f = mock(async () => ({ ok: false, status: 403, headers: hdr({ 'x-ratelimit-remaining': '0' }), json: async () => ({}) }));
		const r = await fetchReleaseNotes(giteaSource('codeberg.org'), ['1.0.0'], f as unknown as typeof fetch);
		expect(r.rateLimited).toBe(false);
	});
});

// A fetch double that returns a fixed release list only for a specific api slug,
// and empty for any other repo (the "wrong same-named repo" case).
const fetchForSlug = (slug: string, tags: string[]) =>
	mock(async (url: string) => ({
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () =>
			url.includes(`/repos/${slug}/`) ? tags.map((t) => rel(t)) : []
	}));

describe('resolveAndFetchReleaseNotes (validated fallback)', () => {
	it('uses a confident source label directly', async () => {
		const f = fetchForSlug('traefik/traefik', ['v3.1']);
		const r = await resolveAndFetchReleaseNotes(
			'traefik:v3.1',
			{ 'org.opencontainers.image.source': 'https://github.com/traefik/traefik' },
			['3.1'],
			f as unknown as typeof fetch
		);
		expect(r.source?.slug).toBe('traefik/traefik');
		expect(r.notes.map((n) => n.version)).toEqual(['3.1']);
	});

	it('accepts a guessed image-name repo when a release matches the wanted version', async () => {
		const f = fetchForSlug('grafana/grafana', ['v11.0.0']);
		const r = await resolveAndFetchReleaseNotes(
			'grafana/grafana:11.0.0',
			{},
			['11.0.0'],
			f as unknown as typeof fetch
		);
		expect(r.source?.slug).toBe('grafana/grafana');
		expect(r.source?.needsValidation).toBe(true);
		expect(r.notes).toHaveLength(1);
	});

	it('REJECTS a guessed repo whose releases do not match the wanted version', async () => {
		// The same-named repo exists and returns releases, but none match 11.0.0.
		const f = fetchForSlug('grafana/grafana', ['v1.2.3', 'v0.9.0']);
		const r = await resolveAndFetchReleaseNotes(
			'grafana/grafana:11.0.0',
			{},
			['11.0.0'],
			f as unknown as typeof fetch
		);
		expect(r.source).toBeNull();
		expect(r.notes).toHaveLength(0);
	});

	it('returns null source for an image with no guessable repo', async () => {
		const f = fetchForSlug('nobody/nothing', ['v1.0.0']);
		const r = await resolveAndFetchReleaseNotes('nginx:1.25', {}, ['1.25'], f as unknown as typeof fetch);
		expect(r.source).toBeNull();
		expect(r.notes).toHaveLength(0);
	});

	it('preserves rateLimited when a guessed repo is discarded due to a 403 rate limit', async () => {
		// grafana/grafana is a correct guess, but GitHub 403s (rate limit) so no notes
		// match. The source is dropped, yet the rateLimited signal must survive so the UI
		// can prompt for a token.
		const f = mock(async () => ({
			ok: false,
			status: 403,
			headers: { get: (k: string) => (k.toLowerCase() === 'x-ratelimit-remaining' ? '0' : null) },
			json: async () => ({})
		}));
		const r = await resolveAndFetchReleaseNotes('grafana/grafana:11.0.0', {}, ['11.0.0'], f as unknown as typeof fetch);
		expect(r.source).toBeNull();
		expect(r.notes).toHaveLength(0);
		expect(r.rateLimited).toBe(true);
	});

	it('caps guessed candidates so many labels do not fan out unboundedly', async () => {
		// 8 distinct github URLs in labels + an image-name guess; only the first few are
		// tried. None match, so we can count fetches via the mock call count staying small.
		const labels: Record<string, string> = {};
		for (let i = 0; i < 8; i++) labels[`org.opencontainers.image.x${i}`] = `https://github.com/o${i}/r${i}`;
		const f = mock(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [] }));
		await resolveAndFetchReleaseNotes('acme/app:1.0.0', labels, ['1.0.0'], f as unknown as typeof fetch);
		// MAX_GUESSES = 5: image-name guess + 4 label URLs at most.
		expect(f.mock.calls.length).toBeLessThanOrEqual(5);
	});

	it('falls through image-name guess to a matching label URL', async () => {
		// image-name repo (acme/app) has no matching release; the url label (acme/real) does.
		const f = mock(async (url: string) => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			json: async () =>
				url.includes('/repos/acme/real/') ? [rel('v2.0.0')] : []
		}));
		const r = await resolveAndFetchReleaseNotes(
			'acme/app:2.0.0',
			{ 'org.opencontainers.image.url': 'https://github.com/acme/real' },
			['2.0.0'],
			f as unknown as typeof fetch
		);
		expect(r.source?.slug).toBe('acme/real');
		expect(r.notes).toHaveLength(1);
	});
});
