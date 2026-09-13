// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import {
	imageBasename,
	matchSelfhstRef,
	createSelfhstMatcher,
	containerNameBase,
	matchSelfhstByName
} from '../src/lib/utils/selfhst-match';

describe('imageBasename', () => {
	test('strips registry, namespace, tag and digest', () => {
		expect(imageBasename('lscr.io/linuxserver/sonarr:latest')).toBe('sonarr');
		expect(imageBasename('plexinc/pms-docker')).toBe('pms-docker');
		expect(imageBasename('grafana/grafana:10.2.0')).toBe('grafana');
		expect(imageBasename('redis@sha256:abcd')).toBe('redis');
		expect(imageBasename('registry.example.com:5000/team/app:v1')).toBe('app');
		expect(imageBasename('nginx')).toBe('nginx');
		expect(imageBasename('')).toBe('');
	});
});

describe('matchSelfhstRef', () => {
	const refs = new Set(['plex', 'sonarr', 'grafana', 'home-assistant', 'pi-hole', 'redis', 'postgresql']);

	test('alias table resolves known mismatches', () => {
		expect(matchSelfhstRef('plexinc/pms-docker:latest', refs)).toBe('plex');
		expect(matchSelfhstRef('homeassistant/home-assistant', refs)).toBe('home-assistant');
		expect(matchSelfhstRef('pihole/pihole', refs)).toBe('pi-hole');
		expect(matchSelfhstRef('postgres:16', refs)).toBe('postgresql');
	});

	test('exact basename matches a reference', () => {
		expect(matchSelfhstRef('lscr.io/linuxserver/sonarr', refs)).toBe('sonarr');
		expect(matchSelfhstRef('grafana/grafana', refs)).toBe('grafana');
	});

	test('NO fuzzy false positives (the whole point)', () => {
		// 'redis-exporter' must NOT become 'redis'
		expect(matchSelfhstRef('oliver006/redis-exporter', refs)).toBeNull();
		// unknown app -> null, never a wrong logo
		expect(matchSelfhstRef('mycompany/secret-internal-app', refs)).toBeNull();
		expect(matchSelfhstRef('', refs)).toBeNull();
	});

	test('alias only wins when the aliased ref is actually in the manifest', () => {
		const tiny = new Set(['sonarr']);
		// pms-docker aliases to plex, but plex is not in this manifest -> null
		expect(matchSelfhstRef('plexinc/pms-docker', tiny)).toBeNull();
	});
});

describe('containerNameBase', () => {
	test('strips leading slash and compose replica suffix, lowercases', () => {
		expect(containerNameBase('/traefik')).toBe('traefik');
		expect(containerNameBase('/traefik-1')).toBe('traefik');
		expect(containerNameBase('immich_server_1')).toBe('immich_server');
		expect(containerNameBase('Sonarr')).toBe('sonarr');
		expect(containerNameBase('/web-2')).toBe('web');
		expect(containerNameBase('')).toBe('');
	});

	test('does not strip a non-replica trailing number word', () => {
		// only a -N / _N SUFFIX is a replica index; an embedded digit stays
		expect(containerNameBase('mc-atm9')).toBe('mc-atm9');
	});
});

describe('matchSelfhstByName (fallback)', () => {
	const refs = new Set(['syncthing', 'traefik', 'grafana', 'pi-hole']);

	test('exact container name matches a reference', () => {
		expect(matchSelfhstByName('/syncthing', refs)).toBe('syncthing');
		expect(matchSelfhstByName('traefik-1', refs)).toBe('traefik');
	});

	test('alias table applies to names too', () => {
		expect(matchSelfhstByName('pihole', refs)).toBe('pi-hole');
	});

	test('generic names never false-match', () => {
		expect(matchSelfhstByName('web', refs)).toBeNull();
		expect(matchSelfhstByName('app-1', refs)).toBeNull();
		expect(matchSelfhstByName('', refs)).toBeNull();
	});
});

describe('createSelfhstMatcher (memoized, image-first with name fallback)', () => {
	test('returns the same result and caches per (image, name) pair', () => {
		const m = createSelfhstMatcher(new Set(['grafana']));
		expect(m('grafana/grafana:1')).toBe('grafana');
		expect(m('grafana/grafana:1')).toBe('grafana'); // cached
		expect(m('unknown/thing')).toBeNull();
	});

	test('falls back to the container name when the image does not resolve', () => {
		const m = createSelfhstMatcher(new Set(['syncthing', 'traefik']));
		// image pinned by digest -> no readable basename match; name saves it
		expect(m('sha256:3de5a32e11c1cc', '/syncthing')).toBe('syncthing');
		expect(m('some/private-mirror@sha256:abcd', 'traefik-1')).toBe('traefik');
	});

	test('image wins over name when both could match', () => {
		const m = createSelfhstMatcher(new Set(['grafana', 'traefik']));
		// image resolves to grafana even though the name says traefik
		expect(m('grafana/grafana', 'traefik')).toBe('grafana');
	});

	test('a matched image is not overridden by an unmatchable name, and vice versa', () => {
		const m = createSelfhstMatcher(new Set(['traefik']));
		expect(m('unknown/thing', 'traefik')).toBe('traefik'); // name saves it
		expect(m('unknown/thing', 'web')).toBeNull(); // neither matches
	});
});
