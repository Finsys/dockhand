/**
 * Unit tests for inspectToCompose - the container-inspect -> compose YAML mapper (#489).
 *
 * Uses REAL `docker inspect` payloads captured from running containers
 * (tests/fixtures/inspect/*.json), so the mapper is exercised against the exact shapes
 * Docker actually emits, not hand-written approximations. Assertions run on the re-parsed
 * YAML object so they are independent of formatting.
 *
 * Run with: bun test tests/inspect-to-compose.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { inspectToCompose, inspectToComposeService, type DockerInspect } from '../src/lib/utils/inspect-to-compose';

function loadFixture(name: string): DockerInspect {
	const path = join(import.meta.dir, 'fixtures', 'inspect', name);
	const arr = JSON.parse(readFileSync(path, 'utf8')) as DockerInspect[];
	return arr[0];
}

function parseCompose(inspect: DockerInspect, options = {}) {
	const yamlStr = inspectToCompose(inspect, options);
	return { yamlStr, doc: yaml.load(yamlStr) as any };
}

describe('inspectToCompose - real gitea inspect (compose-managed, named-vol, custom net)', () => {
	const gitea = loadFixture('gitea.json');

	test('service key is the clean container name', () => {
		const { doc } = parseCompose(gitea);
		expect(Object.keys(doc.services)).toEqual(['semver-demo-stack-gitea-1']);
	});

	test('image + container_name + restart carry through', () => {
		const { doc } = parseCompose(gitea);
		const svc = doc.services['semver-demo-stack-gitea-1'];
		expect(svc.image).toBe('gitea/gitea:1.21.0');
		expect(svc.container_name).toBe('semver-demo-stack-gitea-1');
		expect(svc.restart).toBe('unless-stopped');
	});

	test('the com.docker.compose.* labels are stripped', () => {
		const { yamlStr, doc } = parseCompose(gitea);
		expect(yamlStr).not.toContain('com.docker.compose');
		const svc = doc.services['semver-demo-stack-gitea-1'];
		if (svc.labels) {
			for (const key of Object.keys(svc.labels)) {
				expect(key.startsWith('com.docker.compose.')).toBe(false);
			}
		}
	});

	test('the custom stack network is emitted and declared external at top level', () => {
		const { doc } = parseCompose(gitea);
		const svc = doc.services['semver-demo-stack-gitea-1'];
		// The network carries a per-container MAC, so it renders in the map form. Its auto
		// aliases (the container name + the compose service name) are stripped, leaving no
		// user aliases - only the mac_address.
		expect(svc.networks).toEqual({
			'semver-demo-stack_default': { mac_address: 'f6:1f:4a:64:b6:74' }
		});
		expect(doc.networks['semver-demo-stack_default']).toEqual({ external: true });
		// bare bridge/default are never emitted
		expect(svc.network_mode).toBeUndefined();
	});

	test('the anonymous (64-hex) volume becomes a bare anonymous mount, not a named one', () => {
		const { doc } = parseCompose(gitea);
		const svc = doc.services['semver-demo-stack-gitea-1'];
		// gitea's /data rides a 64-hex anonymous volume -> `- /data`, no hash name, no top-level volume
		expect(svc.volumes).toContain('/data');
		for (const v of svc.volumes as string[]) {
			expect(v).not.toMatch(/^[0-9a-f]{64}:/);
		}
		expect(doc.volumes).toBeUndefined();
	});
});

describe('inspectToCompose - real nginx inspect (published ports, bind :ro, named vol, healthcheck, caps, sysctl)', () => {
	const nginx = loadFixture('nginx-rich.json');
	const svcName = 'itc-fixture';

	test('published ports map to host:container, respecting a bound host IP', () => {
		const { doc } = parseCompose(nginx);
		const svc = doc.services[svcName];
		expect(svc.ports).toContain('8099:80');
		expect(svc.ports).toContain('127.0.0.1:8443:443');
	});

	test('bind mount is source:dest with :ro; named volume is name:dest + top-level external', () => {
		const { doc } = parseCompose(nginx);
		const svc = doc.services[svcName];
		expect(svc.volumes).toContain('/tmp/itc-html:/usr/share/nginx/html:ro');
		expect(svc.volumes).toContain('itc-named:/var/cache/nginx');
		expect(doc.volumes['itc-named']).toEqual({ external: true });
	});

	test('restart on-failure keeps its retry count', () => {
		const { doc } = parseCompose(nginx);
		expect(doc.services[svcName].restart).toBe('on-failure:5');
	});

	test('cap_add/cap_drop and sysctls carry through', () => {
		const { doc } = parseCompose(nginx);
		const svc = doc.services[svcName];
		expect(svc.cap_add).toContain('CAP_NET_ADMIN');
		expect(svc.cap_drop).toContain('CAP_MKNOD');
		expect(svc.sysctls['net.core.somaxconn']).toBe('1024');
	});

	test('healthcheck maps Test + interval(ns->s) + retries', () => {
		const { doc } = parseCompose(nginx);
		const hc = doc.services[svcName].healthcheck;
		expect(hc.test).toEqual(['CMD-SHELL', 'curl -f http://localhost/ || exit 1']);
		expect(hc.interval).toBe('30s');
		expect(hc.retries).toBe(3);
	});

	test('custom label survives', () => {
		const { doc } = parseCompose(nginx);
		expect(doc.services[svcName].labels['my.custom.label']).toBe('hello');
	});

	test('image-baked labels (maintainer) are dropped when imageLabels is provided; user label stays', () => {
		// The image sets maintainer; the container adds my.custom.label. With the image labels
		// passed, only the user-added one survives.
		const imageLabels = { maintainer: 'NGINX Docker Maintainers <docker-maint@nginx.com>' };
		const { doc } = parseCompose(nginx, { imageLabels });
		const labels = doc.services[svcName].labels;
		expect(labels.maintainer).toBeUndefined();
		expect(labels['my.custom.label']).toBe('hello');
	});

	test('auto-generated noise (hostname, working_dir /) is not emitted', () => {
		const { doc } = parseCompose(nginx);
		const svc = doc.services[svcName];
		// Hostname is the short container id (12-hex) -> dropped; working_dir is "/" -> dropped.
		expect(svc.hostname).toBeUndefined();
		expect(svc.working_dir).toBeUndefined();
	});

	test('a non-default shm_size is emitted (this fixture set --shm-size)', () => {
		const svc = parseCompose(nginx).doc.services[svcName];
		expect(svc.shm_size).toBe(8399093760);
	});

	test('image-default entrypoint/command are dropped when the image values are provided', () => {
		const imageEntrypoint = nginx.Config?.Entrypoint ?? null;
		const imageCmd = nginx.Config?.Cmd ?? null;
		const { doc } = parseCompose(nginx, { imageEntrypoint, imageCmd });
		const svc = doc.services[svcName];
		// nginx's entrypoint+cmd come from the image, so with the image passed they vanish.
		expect(svc.entrypoint).toBeUndefined();
		expect(svc.command).toBeUndefined();
	});

	test('a user-overridden command is KEPT even when the image command is provided', () => {
		const custom = structuredClone(nginx);
		custom.Config!.Cmd = ['nginx', '-g', 'daemon off; worker_processes 4;'];
		const { doc } = parseCompose(custom, { imageCmd: nginx.Config?.Cmd ?? null });
		expect(doc.services[svcName].command).toEqual(['nginx', '-g', 'daemon off; worker_processes 4;']);
	});
});

describe('inspectToCompose - image-env subtraction', () => {
	const nginx = loadFixture('nginx-rich.json');
	const svcName = 'itc-fixture';

	test('without imageEnv, all env (incl. inherited PATH) is kept', () => {
		const { doc } = parseCompose(nginx);
		const env = (doc.services[svcName].environment as string[]) ?? [];
		expect(env.some((e) => e.startsWith('PATH='))).toBe(true);
		expect(env).toContain('MY_VAR=uservalue');
	});

	test('with imageEnv, inherited vars are dropped and only user-set env remains', () => {
		const imageEnv = (nginx.Config?.Env ?? []).filter((e) => !e.startsWith('MY_VAR='));
		const { doc } = parseCompose(nginx, { imageEnv });
		const env = (doc.services[svcName].environment as string[]) ?? [];
		expect(env).toEqual(['MY_VAR=uservalue']);
	});
});

describe('inspectToCompose - default-noise filtering', () => {
	test('an explicit restart "no" and a bare bridge network produce no restart/network keys', () => {
		const minimal: DockerInspect = {
			Name: '/plain',
			Config: { Image: 'busybox:latest' },
			HostConfig: {
				RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
				NetworkMode: 'bridge',
				LogConfig: { Type: 'json-file', Config: {} }
			},
			NetworkSettings: { Networks: { bridge: {} } }
		};
		const { doc } = parseCompose(minimal);
		const svc = doc.services['plain'];
		expect(svc.restart).toBeUndefined();
		expect(svc.networks).toBeUndefined();
		expect(svc.network_mode).toBeUndefined();
		expect(svc.logging).toBeUndefined();
		expect(svc.image).toBe('busybox:latest');
	});

	test('network_mode: host is emitted (a host-mode container must not fall back to bridge)', () => {
		// #1464: a host-mode container reports NetworkMode "host" AND a `host` entry in
		// NetworkSettings.Networks. The Networks entry is filtered (we never want
		// `networks: [host]`), so the mode must be emitted from the else branch.
		const inspect: DockerInspect = {
			Name: '/hostnet',
			Config: { Image: 'busybox:latest' },
			HostConfig: { NetworkMode: 'host' },
			NetworkSettings: { Networks: { host: {} } }
		};
		const svc = parseCompose(inspect).doc.services['hostnet'];
		expect(svc.network_mode).toBe('host');
		expect(svc.networks).toBeUndefined();
	});

	test('network_mode: none is emitted (disabled networking is a deliberate choice)', () => {
		const inspect: DockerInspect = {
			Name: '/nonet',
			Config: { Image: 'busybox:latest' },
			HostConfig: { NetworkMode: 'none' },
			NetworkSettings: { Networks: { none: {} } }
		};
		const svc = parseCompose(inspect).doc.services['nonet'];
		expect(svc.network_mode).toBe('none');
		expect(svc.networks).toBeUndefined();
	});

	test('network_mode: default produces no network_mode key', () => {
		const inspect: DockerInspect = {
			Name: '/def',
			Config: { Image: 'busybox:latest' },
			HostConfig: { NetworkMode: 'default' },
			NetworkSettings: { Networks: { bridge: {} } }
		};
		const svc = parseCompose(inspect).doc.services['def'];
		expect(svc.network_mode).toBeUndefined();
		expect(svc.networks).toBeUndefined();
	});

	test('serviceName option overrides the container name', () => {
		const { name } = inspectToComposeService({ Name: '/original', Config: { Image: 'x' } }, { serviceName: 'renamed' });
		expect(name).toBe('renamed');
	});
});

describe('inspectToCompose - env value $ escaping (#1507)', () => {
	// docker compose interpolates $ in env values; an inspect value is already a resolved
	// literal, so every $ must be escaped to $$ or compose eats it (a bcrypt hash
	// $2a$12$... becomes $2a$12.<tail>, silently corrupting the password).
	test('a bcrypt hash keeps every $ as $$ so compose interpolation leaves it intact', () => {
		const inspect: DockerInspect = {
			Name: '/wg-easy',
			Config: {
				Image: 'ghcr.io/wg-easy/wg-easy:latest',
				Env: ['PASSWORD_HASH=$2a$12$r68XHj7T7304UoWeYJc1BOSwjmyeBj.gzk7PnLOKv5AED8C5NNj5C']
			},
			HostConfig: {},
			NetworkSettings: { Networks: {} }
		};
		const svc = parseCompose(inspect).doc.services['wg-easy'];
		const entry = svc.environment.find((e: string) => e.startsWith('PASSWORD_HASH='));
		expect(entry).toBe('PASSWORD_HASH=$$2a$$12$$r68XHj7T7304UoWeYJc1BOSwjmyeBj.gzk7PnLOKv5AED8C5NNj5C');
		// After compose collapses $$ -> $, the original hash is recovered verbatim.
		const value = entry.slice('PASSWORD_HASH='.length).replaceAll('$$', '$');
		expect(value).toBe('$2a$12$r68XHj7T7304UoWeYJc1BOSwjmyeBj.gzk7PnLOKv5AED8C5NNj5C');
	});

	test('a value with no $ is left untouched', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'x', Env: ['WG_HOST=example.me', 'PORT=51820'] },
			HostConfig: {},
			NetworkSettings: { Networks: {} }
		};
		const svc = parseCompose(inspect).doc.services['app'];
		expect(svc.environment).toContain('WG_HOST=example.me');
		expect(svc.environment).toContain('PORT=51820');
	});

	test('a literal ${VAR}-looking value is escaped so compose does not expand it', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'x', Env: ['TEMPLATE=${NOT_A_VAR}-literal'] },
			HostConfig: {},
			NetworkSettings: { Networks: {} }
		};
		const svc = parseCompose(inspect).doc.services['app'];
		const entry = svc.environment.find((e: string) => e.startsWith('TEMPLATE='));
		expect(entry).toBe('TEMPLATE=$${NOT_A_VAR}-literal');
	});
});

describe('inspectToCompose - full network model (static IP, aliases, MAC)', () => {
	test('static IPv4/IPv6, user aliases and MAC render as a per-network map', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'nginx:1.27' },
			HostConfig: {},
			NetworkSettings: {
				Networks: {
					backend: {
						Aliases: ['app', 'db.internal', 'a1b2c3d4e5f6'],
						MacAddress: '02:42:ac:11:00:05',
						IPAMConfig: { IPv4Address: '10.5.0.9', IPv6Address: 'fd00::9' }
					}
				}
			}
		};
		const svc = parseCompose(inspect).doc.services['app'];
		// 'app' (service key) and the 12-hex short id are stripped; 'db.internal' survives.
		expect(svc.networks).toEqual({
			backend: {
				ipv4_address: '10.5.0.9',
				ipv6_address: 'fd00::9',
				aliases: ['db.internal'],
				mac_address: '02:42:ac:11:00:05'
			}
		});
		expect(svc.network_mode).toBeUndefined();
	});

	test('a compose service alias (com.docker.compose.service) is stripped as auto', () => {
		const inspect: DockerInspect = {
			Name: '/proj-web-1',
			Config: { Image: 'nginx', Labels: { 'com.docker.compose.service': 'web' } },
			HostConfig: {},
			NetworkSettings: {
				Networks: { proj_default: { Aliases: ['proj-web-1', 'web'], IPAMConfig: { IPv4Address: '10.1.0.2' } } }
			}
		};
		const svc = parseCompose(inspect).doc.services['proj-web-1'];
		// both 'proj-web-1' (name) and 'web' (compose service) are auto; only the static IP is left.
		expect(svc.networks).toEqual({ proj_default: { ipv4_address: '10.1.0.2' } });
	});

	test('bare networks with no detail stay in the short list form (zero noise)', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'nginx' },
			HostConfig: {},
			NetworkSettings: { Networks: { frontend: { Aliases: ['app'] }, backend: {} } }
		};
		const svc = parseCompose(inspect).doc.services['app'];
		expect(svc.networks).toEqual(['frontend', 'backend']);
	});

	test('dns_search and dns_opt are emitted alongside dns', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'nginx' },
			HostConfig: { Dns: ['1.1.1.1'], DnsSearch: ['corp.local'], DnsOptions: ['ndots:2'] }
		};
		const svc = parseCompose(inspect).doc.services['app'];
		expect(svc.dns).toEqual(['1.1.1.1']);
		expect(svc.dns_search).toEqual(['corp.local']);
		expect(svc.dns_opt).toEqual(['ndots:2']);
	});
});

describe('inspectToCompose - resource limits', () => {
	test('memory + cpu + pids limits map to the standalone top-level keys', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'nginx' },
			HostConfig: {
				Memory: 536870912,
				MemoryReservation: 268435456,
				MemorySwap: 1073741824,
				NanoCpus: 1500000000,
				CpusetCpus: '0-1',
				PidsLimit: 200
			}
		};
		const svc = parseCompose(inspect).doc.services['app'];
		expect(svc.mem_limit).toBe(536870912);
		expect(svc.mem_reservation).toBe(268435456);
		expect(svc.memswap_limit).toBe(1073741824);
		expect(svc.cpus).toBe(1.5); // 1.5e9 nanocpus -> 1.5 cores
		expect(svc.cpuset).toBe('0-1');
		expect(svc.pids_limit).toBe(200);
	});

	test('daemon-default resource values are skipped', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'nginx' },
			HostConfig: {
				Memory: 0,
				MemorySwap: 0,
				NanoCpus: 0,
				CpuShares: 1024, // neutral weight - not user intent
				CpusetCpus: '',
				PidsLimit: -1 // unlimited (the default)
			}
		};
		const svc = parseCompose(inspect).doc.services['app'];
		expect(svc.mem_limit).toBeUndefined();
		expect(svc.memswap_limit).toBeUndefined();
		expect(svc.cpus).toBeUndefined();
		expect(svc.cpu_shares).toBeUndefined();
		expect(svc.cpuset).toBeUndefined();
		expect(svc.pids_limit).toBeUndefined();
	});

	test('cpu_shares is emitted for a non-neutral weight', () => {
		const svc = parseCompose({
			Name: '/app',
			Config: { Image: 'nginx' },
			HostConfig: { CpuShares: 512 }
		}).doc.services['app'];
		expect(svc.cpu_shares).toBe(512);
	});

	test('memswap_limit -1 (unlimited swap) is a real user value and is emitted', () => {
		const svc = parseCompose({
			Name: '/app',
			Config: { Image: 'nginx' },
			HostConfig: { Memory: 536870912, MemorySwap: -1 }
		}).doc.services['app'];
		expect(svc.memswap_limit).toBe(-1);
	});
});

describe('inspectToCompose - lifecycle (stop/expose/group_add/init)', () => {
	test('stop_signal + stop_grace_period from a non-default StopSignal/StopTimeout', () => {
		const svc = parseCompose({
			Name: '/app',
			Config: { Image: 'nginx', StopSignal: 'SIGINT', StopTimeout: 30 },
			HostConfig: {}
		}).doc.services['app'];
		expect(svc.stop_signal).toBe('SIGINT');
		expect(svc.stop_grace_period).toBe('30s');
	});

	test('default SIGTERM and null StopTimeout are skipped', () => {
		const svc = parseCompose({
			Name: '/app',
			Config: { Image: 'nginx', StopSignal: 'SIGTERM', StopTimeout: null },
			HostConfig: {}
		}).doc.services['app'];
		expect(svc.stop_signal).toBeUndefined();
		expect(svc.stop_grace_period).toBeUndefined();
	});

	test('expose lists ports that are exposed but neither published nor image-baked', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'nginx', ExposedPorts: { '80/tcp': {}, '9000/tcp': {}, '53/udp': {} } },
			HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '8080' }] } }
		};
		// image itself EXPOSEs 9000; that must not leak into expose.
		const svc = parseCompose(inspect, { imageExposedPorts: { '9000/tcp': {} } }).doc.services['app'];
		// 80 is published (in ports), 9000 is image-baked -> only 53/udp remains.
		expect(svc.expose).toEqual(['53/udp']);
	});

	test('group_add and init: true are emitted', () => {
		const svc = parseCompose({
			Name: '/app',
			Config: { Image: 'nginx' },
			HostConfig: { GroupAdd: ['docker'], Init: true }
		}).doc.services['app'];
		expect(svc.group_add).toEqual(['docker']);
		expect(svc.init).toBe(true);
	});

	test('init: null / false is not emitted', () => {
		const svcNull = parseCompose({ Name: '/a', Config: { Image: 'x' }, HostConfig: { Init: null } }).doc.services['a'];
		const svcFalse = parseCompose({ Name: '/b', Config: { Image: 'x' }, HostConfig: { Init: false } }).doc.services['b'];
		expect(svcNull.init).toBeUndefined();
		expect(svcFalse.init).toBeUndefined();
	});
});

describe('inspectToCompose - runtime/security options', () => {
	test('security_opt, pid, userns, cgroup_parent, runtime, shm_size, volumes_from, oom, domainname', () => {
		const inspect: DockerInspect = {
			Name: '/app',
			Config: { Image: 'nginx', Domainname: 'corp.local' },
			HostConfig: {
				SecurityOpt: ['no-new-privileges'],
				PidMode: 'host',
				UsernsMode: 'host',
				CgroupParent: '/custom.slice',
				Runtime: 'nvidia',
				ShmSize: 134217728, // 128MiB, differs from the 64MiB default
				VolumesFrom: ['data-container'],
				OomKillDisable: true,
				OomScoreAdj: -500
			}
		};
		const svc = parseCompose(inspect).doc.services['app'];
		expect(svc.security_opt).toEqual(['no-new-privileges']);
		expect(svc.pid).toBe('host');
		expect(svc.userns_mode).toBe('host');
		expect(svc.cgroup_parent).toBe('/custom.slice');
		expect(svc.runtime).toBe('nvidia');
		expect(svc.shm_size).toBe(134217728);
		expect(svc.volumes_from).toEqual(['data-container']);
		expect(svc.oom_kill_disable).toBe(true);
		expect(svc.oom_score_adj).toBe(-500);
		expect(svc.domainname).toBe('corp.local');
	});

	test('runc runtime, 64MiB shm_size, and oom defaults are skipped', () => {
		const svc = parseCompose({
			Name: '/app',
			Config: { Image: 'nginx' },
			HostConfig: {
				Runtime: 'runc',
				ShmSize: 67108864, // 64MiB default
				OomKillDisable: false,
				OomScoreAdj: 0
			}
		}).doc.services['app'];
		expect(svc.runtime).toBeUndefined();
		expect(svc.shm_size).toBeUndefined();
		expect(svc.oom_kill_disable).toBeUndefined();
		expect(svc.oom_score_adj).toBeUndefined();
	});
});
