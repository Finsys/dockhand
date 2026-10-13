// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import {
	imageBasename,
	matchSelfhstRef,
	createSelfhstMatcher,
	containerNameBase,
	matchSelfhstByName,
	imageNamespace,
	matchSelfhstByNamespace
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

describe('separator-insensitive match (image basename drops the reference hyphens)', () => {
	const refs = new Set(['the-lounge', 'home-assistant', 'uptime-kuma', 'paperless-ngx', 'redis']);

	test('an unhyphenated image basename matches a hyphenated reference', () => {
		// The Lounge ships as thelounge/thelounge but selfh.st calls it the-lounge.
		expect(matchSelfhstRef('thelounge/thelounge:latest', refs)).toBe('the-lounge');
		expect(matchSelfhstRef('ghcr.io/thelounge/thelounge', refs)).toBe('the-lounge');
		expect(matchSelfhstRef('uptimekuma/uptime-kuma', refs)).toBe('uptime-kuma');
	});

	test('resolves via the container name too', () => {
		expect(matchSelfhstByName('/thelounge', refs)).toBe('the-lounge');
		expect(matchSelfhstByName('paperlessngx-1', refs)).toBe('paperless-ngx');
	});

	test('it is equality-after-normalization, never a substring/fuzzy match', () => {
		// no reference collapses to redisexporter, so it stays unmatched (not redis)
		expect(matchSelfhstRef('oliver006/redis-exporter', refs)).toBeNull();
		expect(matchSelfhstRef('prom/node-exporter', refs)).toBeNull();
	});

	test('an all-separator base does not match (empty stripped key)', () => {
		// `---` strips to "" and must never resolve, even against a degenerate manifest
		expect(matchSelfhstByName('---', new Set(['the-lounge']))).toBeNull();
		expect(matchSelfhstByName('___', new Set(['the-lounge']))).toBeNull();
	});

	test('createSelfhstMatcher picks up the separator-insensitive match', () => {
		const m = createSelfhstMatcher(new Set(['the-lounge']));
		expect(m('thelounge/thelounge')).toBe('the-lounge');
		expect(m('thelounge/thelounge')).toBe('the-lounge'); // cached
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

describe('imageNamespace', () => {
	test('returns the vendor segment, skipping the registry host', () => {
		expect(imageNamespace('victoriametrics/vmalert:v1.100.0')).toBe('victoriametrics');
		expect(imageNamespace('docker.io/victoriametrics/vmagent')).toBe('victoriametrics');
		expect(imageNamespace('localhost/org/app')).toBe('org');
		expect(imageNamespace('registry.example.com:5000/team/app@sha256:abcd')).toBe('team');
	});

	test('deeper paths are ambiguous and get no namespace', () => {
		expect(imageNamespace('ghcr.io/org/team/app:v1')).toBe('');
		// a proxy project named like a selfh.st ref must not badge the image
		expect(imageNamespace('harbor.corp/docker/grafana/promtail:3.0')).toBe('');
	});

	test('no namespace for bare images or registry/app', () => {
		expect(imageNamespace('nginx:latest')).toBe('');
		expect(imageNamespace('sha256:3de5a32e11c1cc')).toBe('');
		expect(imageNamespace('localhost:5000/app')).toBe('');
		expect(imageNamespace('ghcr.io/app')).toBe('');
		expect(imageNamespace('')).toBe('');
	});

	test('distributor namespaces are ignored', () => {
		expect(imageNamespace('lscr.io/linuxserver/sonarr')).toBe('');
		expect(imageNamespace('docker.io/library/nginx')).toBe('');
		expect(imageNamespace('bitnami/redis')).toBe('');
		expect(imageNamespace('ghcr.io/hotio/radarr')).toBe('');
		expect(imageNamespace('ubuntu/squid:5.2-22.04_beta')).toBe('');
		expect(imageNamespace('centos/postgresql-96-centos7')).toBe('');
		// ECR mirror of Docker Official Images: `docker` must not badge busybox
		expect(imageNamespace('public.ecr.aws/docker/library/busybox')).toBe('');
	});
});

describe('namespace fallback (#1624)', () => {
	const refs = new Set(['victoriametrics', 'traefik', 'linuxserver', 'plex']);

	test('matchSelfhstByNamespace resolves the vendor for its own product', () => {
		expect(matchSelfhstByNamespace('victoriametrics/victoria-logs', refs)).toBe(
			'victoriametrics'
		);
		expect(matchSelfhstByNamespace('unknown/thing', refs)).toBeNull();
		// a distributor never matches, even if it were a reference
		expect(matchSelfhstByNamespace('lscr.io/linuxserver/foo', refs)).toBeNull();
	});

	test('createSelfhstMatcher: image, then name, then namespace', () => {
		const m = createSelfhstMatcher(new Set(['victoriametrics', 'traefik', 'grafana']));
		expect(m('victoriametrics/vmalert:latest', 'vmalert')).toBe('victoriametrics');
		expect(m('victoriametrics/vmagent', '')).toBe('victoriametrics');
		expect(m('victoriametrics/victoria-logs', '')).toBe('victoriametrics');
		// the image basename still wins over its namespace
		expect(m('grafana/traefik', '')).toBe('traefik');
		// the container name wins over the namespace
		expect(m('traefik/whoami', 'grafana')).toBe('grafana');
		// whoami is a diagnostic tool, not Traefik: its vendor's logo would be wrong.
		expect(m('traefik/whoami', 'whoami')).toBeNull();
	});
});

describe('the namespace fallback and wrong logos', () => {
	// The module promises never a wrong logo. A vendor that publishes many products
	// would otherwise paint all of them with its own, so the whole Grafana stack
	// would look identical.
	const refs = new Set([
		'grafana',
		'grafana-tempo',
		'loki',
		'apache',
		'apache-superset',
		'hashicorp',
		'hashicorp-vault',
		'elastic',
		'mailu',
		'victoriametrics',
		'home-assistant',
		'sonarr',
		'rocky-linux'
	]);
	const m = createSelfhstMatcher(refs);

	test('the app own icon wins over its vendor', () => {
		expect(m('apache/superset', '')).toBe('apache-superset');
		expect(m('hashicorp/vault', '')).toBe('hashicorp-vault');
		expect(m('grafana/tempo', '')).toBe('grafana-tempo');
	});

	test('a product with no icon of its own gets none, not its vendor', () => {
		expect(m('grafana/promtail', '')).toBeNull();
		expect(m('elastic/filebeat', '')).toBeNull();
		expect(m('mailu/postfix', '')).toBeNull();
	});

	test('the vendor icon is kept where the image IS the vendor', () => {
		expect(m('victoriametrics/victoria-logs', '')).toBe('victoriametrics');
		expect(m('ghcr.io/home-assistant/home-assistant', '')).toBe('home-assistant');
	});

	test('a vendor shorthand still counts as the vendor', () => {
		// vmalert and vmagent are VictoriaMetrics' own, by an explicit alias.
		expect(m('victoriametrics/vmalert', '')).toBe('victoriametrics');
		expect(m('victoriametrics/vmagent', '')).toBe('victoriametrics');
	});

	test('a distro namespace never badges the app it carries', () => {
		expect(m('rockylinux/rocky-toolbox', '')).toBeNull();
		expect(m('opensuse/busybox', '')).toBeNull();
		expect(m('alpine/socat', '')).toBeNull();
	});

	test('a republisher still resolves to the app it republishes', () => {
		expect(m('linuxserver/sonarr', '')).toBe('sonarr');
		expect(m('grafana/loki', '')).toBe('loki');
	});
});
