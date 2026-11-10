/**
 * Which stored registry entry's credentials apply to an image. A URL with an org path
 * (ghcr.io/team) must cover images under that path, not only a lookup for the exact
 * string, or pulls and update checks silently fall back to anonymous access.
 */

import { describe, expect, test } from 'bun:test';
import { matchRegistryEntry, pickRegistryCredentials, type StoredRegistryEntry } from '../src/lib/server/registry/credential-match';

const entry = (host: string, path: string, name: string, creds = true) =>
	({ host, path, name, username: creds ? 'u' : null, password: creds ? 'p' : null }) as StoredRegistryEntry & { name: string };

describe('matchRegistryEntry', () => {
	test('a host-only entry covers every image on that host', () => {
		expect(matchRegistryEntry([entry('ghcr.io', '', 'host')], 'ghcr.io', 'linuxserver/sonarr')?.name).toBe('host');
	});

	test('an org-path entry covers images under that org', () => {
		const e = [entry('ghcr.io', '/linuxserver', 'org')];
		expect(matchRegistryEntry(e, 'ghcr.io', 'linuxserver/sonarr')?.name).toBe('org');
		expect(matchRegistryEntry(e, 'ghcr.io', 'linuxserver/nested/app')?.name).toBe('org');
	});

	test('an org-path entry does not cover another org or a name that only shares a prefix', () => {
		const e = [entry('ghcr.io', '/team', 'org')];
		expect(matchRegistryEntry(e, 'ghcr.io', 'other/app')).toBeNull();
		expect(matchRegistryEntry(e, 'ghcr.io', 'teamx/app')).toBeNull();
		expect(matchRegistryEntry(e, 'ghcr.io', 'my-team/app')).toBeNull();
	});

	test('the longest matching path wins, whatever the entry order', () => {
		const host = entry('ghcr.io', '', 'host');
		const org = entry('ghcr.io', '/team', 'org');
		const sub = entry('ghcr.io', '/team/sub', 'sub');
		for (const e of [[host, org, sub], [sub, org, host], [org, host, sub]]) {
			expect(matchRegistryEntry(e, 'ghcr.io', 'team/sub/app')?.name).toBe('sub');
			expect(matchRegistryEntry(e, 'ghcr.io', 'team/app')?.name).toBe('org');
			expect(matchRegistryEntry(e, 'ghcr.io', 'else/app')?.name).toBe('host');
		}
	});

	test('a different host never matches, including one that shares a prefix', () => {
		const e = [entry('ghcr.io', '', 'host')];
		expect(matchRegistryEntry(e, 'lscr.io', 'linuxserver/sonarr')).toBeNull();
		expect(matchRegistryEntry(e, 'ghcr.io.evil.com', 'team/app')).toBeNull();
		expect(matchRegistryEntry([entry('reg.example.com:5000', '', 'port')], 'reg.example.com', 'app')).toBeNull();
	});

	test('entries without both a username and a password are skipped', () => {
		const bare = entry('ghcr.io', '/team', 'bare', false);
		const host = entry('ghcr.io', '', 'host');
		expect(matchRegistryEntry([bare, host], 'ghcr.io', 'team/app')?.name).toBe('host');
		expect(matchRegistryEntry([{ ...host, password: '' }], 'ghcr.io', 'team/app')).toBeNull();
		const noUser = { ...entry('ghcr.io', '/team', 'nouser'), username: null };
		expect(matchRegistryEntry([noUser, host], 'ghcr.io', 'team/app')?.name).toBe('host');
	});

	test('two entries with the same path: the first one wins', () => {
		const e = [entry('ghcr.io', '/team', 'first'), entry('ghcr.io', '/team', 'second')];
		expect(matchRegistryEntry(e, 'ghcr.io', 'team/app')?.name).toBe('first');
	});

	test('a trailing slash and upper case in the stored path are tolerated', () => {
		expect(matchRegistryEntry([entry('ghcr.io', '/Team/', 'org')], 'ghcr.io', 'team/app')?.name).toBe('org');
	});

	test('the exact repo path itself is covered', () => {
		expect(matchRegistryEntry([entry('ghcr.io', '/team/app', 'exact')], 'ghcr.io', 'team/app')?.name).toBe('exact');
	});
});

const HUB = new Set(['docker.io', 'hub.docker.com', 'registry.hub.docker.com', 'index.docker.io', 'registry-1.docker.io']);
const reg = (url: string, creds = true) => ({ url, username: creds ? 'u' : null, password: creds ? 'p' : null });
const pick = (regs: { url: string }[], host: string, repo: string) => {
	const r = pickRegistryCredentials(regs, host, repo, HUB);
	return r && `${r.registry.url} ${r.via}`;
};

describe('pickRegistryCredentials', () => {
	test('URLs as people type them reach the matcher: scheme, trailing slashes, org path', () => {
		expect(pick([reg('https://ghcr.io/')], 'ghcr.io', 'team/app')).toBe('https://ghcr.io/ host-only');
		expect(pick([reg('ghcr.io//')], 'ghcr.io', 'team/app')).toBe('ghcr.io// host-only');
		expect(pick([reg('https://ghcr.io/team/')], 'ghcr.io', 'team/app')).toBe('https://ghcr.io/team/ path');
		expect(pick([reg('ghcr.io/team')], 'ghcr.io', 'other/app')).toBeNull();
	});

	test('the repo is what lets an org-path entry match', () => {
		const regs = [reg('ghcr.io'), reg('ghcr.io/team')];
		expect(pick(regs, 'ghcr.io', 'team/app')).toBe('ghcr.io/team path');
		expect(pick(regs, 'ghcr.io', 'other/app')).toBe('ghcr.io host-only');
	});

	test('a requested registry that carries a path joins it with the repo', () => {
		expect(pick([reg('reg.example.com/team')], 'reg.example.com/team', 'app')).toBe('reg.example.com/team path');
		expect(pick([reg('reg.example.com/team')], 'reg.example.com/other', 'app')).toBeNull();
	});

	test('Docker Hub org entries in any spelling pick by path', () => {
		const regs = [reg('docker.io/orga'), reg('https://registry.hub.docker.com/orgb')];
		expect(pick(regs, 'index.docker.io', 'orgb/app')).toBe('https://registry.hub.docker.com/orgb path');
		expect(pick(regs, 'index.docker.io', 'orga/app')).toBe('docker.io/orga path');
		expect(pick([reg('docker.io'), reg('docker.io/orga')], 'index.docker.io', 'orga/app')).toBe('docker.io/orga path');
		// The requested host is canonicalised too, whatever Hub spelling the image used.
		expect(pick([reg('docker.io/orga'), reg('docker.io/orgb')], 'registry-1.docker.io', 'orgb/app')).toBe('docker.io/orgb path');
		expect(pick([reg('docker.io/orga')], 'registry-1.docker.io', 'library/alpine')).toBe('docker.io/orga hub-fallback');
	});

	test('on a tie between Hub spellings, the entry spelled with the requested host wins', () => {
		const regs = [{ ...reg('registry-1.docker.io'), username: 'x' }, { ...reg('docker.io'), username: 'y' }];
		expect(pickRegistryCredentials(regs, 'docker.io', 'library/nginx', HUB)?.registry.username).toBe('y');
		expect(pickRegistryCredentials(regs, 'registry-1.docker.io', 'library/nginx', HUB)?.registry.username).toBe('x');
	});

	test('the Hub fallback takes the first Hub entry with credentials', () => {
		expect(pick([reg('docker.io/orga'), reg('docker.io/orgb')], 'index.docker.io', 'library/alpine')).toBe('docker.io/orga hub-fallback');
	});

	test('a single Docker Hub login still covers every Hub image', () => {
		expect(pick([reg('docker.io/myuser')], 'index.docker.io', 'library/alpine')).toBe('docker.io/myuser hub-fallback');
		expect(pick([reg('https://registry.hub.docker.com')], 'index.docker.io', 'library/alpine')).toBe('https://registry.hub.docker.com host-only');
	});

	test('a Docker Hub entry without credentials is anonymous, and Hub entries never apply elsewhere', () => {
		expect(pick([reg('https://registry.hub.docker.com', false)], 'index.docker.io', 'library/alpine')).toBeNull();
		expect(pick([reg('docker.io/myuser')], 'ghcr.io', 'myuser/app')).toBeNull();
	});
});
