import { describe, test, expect } from 'bun:test';
import { planRemoteStaging, rewriteBindsToHostDir, stagingLandsOnItself, stagingDecision, stagedPathSent, withoutBindSources } from '../src/lib/server/remote-staging-plan';

const REL = `services:
  app:
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf`;
const NAMED = `services:
  app:
    volumes:
      - mydata:/data
volumes:
  mydata:`;
const ABS = `services:
  app:
    volumes:
      - /etc/localtime:/etc/localtime`;
const NONE = `services:
  app:
    image: nginx
    ports:
      - "80:80"`;

describe('planRemoteStaging', () => {
	const base = { operation: 'up', remoteStacksDir: '/opt/dockhand/stacks', stackName: 'web', composeContent: REL, hasStackFiles: true };

	test('stages when up + remoteDir set + relative binds + files present', () => {
		const p = planRemoteStaging(base);
		expect(p.stage).toBe(true);
		expect(p.hostDir).toBe('/opt/dockhand/stacks/web');
	});

	test('trailing slash on remoteDir is normalized', () => {
		const p = planRemoteStaging({ ...base, remoteStacksDir: '/opt/x/' });
		expect(p.hostDir).toBe('/opt/x/web');
	});

	test('NO stage when remote_stacks_dir is empty/null (the zero-regression guard)', () => {
		expect(planRemoteStaging({ ...base, remoteStacksDir: null }).stage).toBe(false);
		expect(planRemoteStaging({ ...base, remoteStacksDir: '' }).stage).toBe(false);
		expect(planRemoteStaging({ ...base, remoteStacksDir: '   ' }).stage).toBe(false);
	});

	test('stages even without relative binds - a bind-less stack still needs its compose on the host to be backupable', () => {
		// Setting remote_stacks_dir means "keep my stacks here on the host", so the whole
		// stack dir is staged regardless of binds (compose+.env+sibling config), not just when
		// a relative bind needs resolving.
		for (const composeContent of [NAMED, ABS, NONE]) {
			const p = planRemoteStaging({ ...base, composeContent });
			expect(p.stage).toBe(true);
			expect(p.hostDir).toBe('/opt/dockhand/stacks/web');
		}
	});

	test('NO stage for non-up operations', () => {
		for (const op of ['down', 'stop', 'start', 'restart', 'pull']) {
			expect(planRemoteStaging({ ...base, operation: op }).stage).toBe(false);
		}
	});

	test('NO stage when there are no stack files', () => {
		expect(planRemoteStaging({ ...base, hasStackFiles: false }).stage).toBe(false);
	});
});

describe('rewriteBindsToHostDir', () => {
	const HOST = '/tmp/stacks/web';

	test('rewrites a same-dir relative bind to <hostDir>/x', () => {
		const r = rewriteBindsToHostDir(REL, HOST);
		expect(r.modified).toBe(true);
		expect(r.content).toContain('- /tmp/stacks/web/nginx.conf:/etc/nginx/nginx.conf');
		expect(r.content).not.toContain('./nginx.conf');
		expect(r.changes).toEqual(['  ./nginx.conf -> /tmp/stacks/web/nginx.conf']);
	});

	test('rewrites a directory bind (./data) and preserves the dest', () => {
		const compose = `services:\n  app:\n    volumes:\n      - ./data:/data`;
		const r = rewriteBindsToHostDir(compose, HOST);
		expect(r.content).toContain('- /tmp/stacks/web/data:/data');
	});

	test('rewrites multiple binds independently', () => {
		const compose = `services:\n  app:\n    volumes:\n      - ./data:/data\n      - ./config:/config`;
		const r = rewriteBindsToHostDir(compose, HOST);
		expect(r.content).toContain('- /tmp/stacks/web/data:/data');
		expect(r.content).toContain('- /tmp/stacks/web/config:/config');
		expect(r.changes).toHaveLength(2);
	});

	test('preserves quotes around the mapping', () => {
		const compose = `services:\n  app:\n    volumes:\n      - "./data:/data"`;
		const r = rewriteBindsToHostDir(compose, HOST);
		expect(r.content).toContain('- "/tmp/stacks/web/data:/data"');
	});

	test('trailing slash on hostDir is normalized', () => {
		const r = rewriteBindsToHostDir(`services:\n  app:\n    volumes:\n      - ./data:/data`, '/tmp/stacks/web/');
		expect(r.content).toContain('- /tmp/stacks/web/data:/data');
		expect(r.content).not.toContain('web//data');
	});

	test('leaves named volumes, absolute binds, and non-bind lines untouched', () => {
		for (const compose of [NAMED, ABS, NONE]) {
			const r = rewriteBindsToHostDir(compose, HOST);
			expect(r.modified).toBe(false);
			expect(r.content).toBe(compose);
		}
	});

	test('does NOT rewrite ../ escapes (never staged - must fail loudly, not point at a bogus path)', () => {
		const compose = `services:\n  app:\n    volumes:\n      - ../secrets:/secrets`;
		const r = rewriteBindsToHostDir(compose, HOST);
		expect(r.modified).toBe(false);
		expect(r.content).toBe(compose);
	});

	test('does NOT touch a long-syntax source that is not a - ./x:/y line', () => {
		// Long syntax (type: bind / source:) is not the `- ./x:/y` shorthand this targets.
		const compose = `services:\n  app:\n    volumes:\n      - type: bind\n        source: ./data\n        target: /data`;
		const r = rewriteBindsToHostDir(compose, HOST);
		expect(r.modified).toBe(false);
	});
});

describe('stagingLandsOnItself', () => {
	// Socket-proxy shape: Dockhand reaches its own daemon through a socket proxy, /app/data is a bind
	// from /srv/dockhand, and remote_stacks_dir is the host path of Dockhand's stacks for this env.
	const same = {
		envDockerHost: 'tcp://dockhand-socket-proxy:2375',
		ownDockerHost: 'tcp://dockhand-socket-proxy:2375',
		workingDir: '/app/data/stacks/local/plex',
		hostDir: '/srv/dockhand/stacks/local/plex',
		mounts: [{ source: '/srv/dockhand', destination: '/app/data', type: 'bind' }]
	};

	test('the copy would land on Dockhand\'s own folder on the same daemon', () => {
		expect(stagingLandsOnItself(same)).toBe(true);
		expect(stagingLandsOnItself({ ...same, hostDir: '/srv/dockhand/stacks/local/plex/' })).toBe(true);
		expect(stagingLandsOnItself({ ...same, mounts: [{ source: '/var/lib/docker/volumes/dh/_data', destination: '/app/data', type: 'volume' }], hostDir: '/var/lib/docker/volumes/dh/_data/stacks/local/plex' })).toBe(true);
	});

	test('another daemon, or no DOCKER_HOST of our own: copy as before', () => {
		expect(stagingLandsOnItself({ ...same, envDockerHost: 'tcp://10.0.0.5:2375' })).toBe(false);
		expect(stagingLandsOnItself({ ...same, envDockerHost: 'tcp://dockhand-socket-proxy:2376' })).toBe(false);
		expect(stagingLandsOnItself({ ...same, ownDockerHost: null })).toBe(false);
	});

	test('a different folder on the same daemon: copy as before', () => {
		// remote_stacks_dir without the environment segment, as the UI example suggests.
		expect(stagingLandsOnItself({ ...same, hostDir: '/srv/dockhand/stacks/plex' })).toBe(false);
		expect(stagingLandsOnItself({ ...same, hostDir: '/srv/dockhand/stacks/local/plex2' })).toBe(false);
	});

	test('a mount inside the stack folder: copy as before', () => {
		const mounts = [...same.mounts, { source: '/mnt/media', destination: '/app/data/stacks/local/plex/library', type: 'bind' }];
		expect(stagingLandsOnItself({ ...same, mounts })).toBe(false);
		const tmp = [...same.mounts, { source: '', destination: '/app/data/stacks/local/plex/cache', type: 'tmpfs' }];
		expect(stagingLandsOnItself({ ...same, mounts: tmp })).toBe(false);
	});

	test('a mount inside the stack folder is caught however the paths are spelled', () => {
		const media = { source: '/mnt/media', destination: '/app/data/stacks/local/plex/library', type: 'bind' };
		expect(stagingLandsOnItself({ ...same, workingDir: '/app/data/stacks/local/plex/', mounts: [...same.mounts, media] })).toBe(false);
		expect(stagingLandsOnItself({ ...same, workingDir: '/app/data/stacks/local/plex/' })).toBe(true);
		// Reported through a symlinked folder (alias -> local): only the resolved path shows it.
		const viaAlias = { ...media, destination: '/app/data/stacks/alias/plex/library' };
		const realpath = (p: string) => p.replace('/stacks/alias/', '/stacks/local/');
		expect(stagingLandsOnItself({ ...same, mounts: [...same.mounts, viaAlias], realpath })).toBe(false);
		expect(stagingLandsOnItself({ ...same, mounts: [...same.mounts], realpath })).toBe(true);
	});

	test('a mount exactly at the stack dir counts as the stack dir', () => {
		const mounts = [{ source: '/srv/plex', destination: '/app/data/stacks/local/plex', type: 'bind' }];
		expect(stagingLandsOnItself({ ...same, mounts, hostDir: '/srv/plex' })).toBe(true);
	});

	test('HOST_DATA_DIR never proves it', () => {
		const prev = process.env.HOST_DATA_DIR;
		process.env.HOST_DATA_DIR = '/srv/dockhand';
		try {
			expect(stagingLandsOnItself({ ...same, mounts: [] })).toBe(false);
		} finally {
			if (prev === undefined) delete process.env.HOST_DATA_DIR;
			else process.env.HOST_DATA_DIR = prev;
		}
	});

	test('no mount table, or a stack dir no mount covers: copy as before', () => {
		expect(stagingLandsOnItself({ ...same, mounts: [] })).toBe(false);
		expect(stagingLandsOnItself({ ...same, workingDir: '/opt/stacks/plex', hostDir: '/opt/stacks/plex' })).toBe(false);
		expect(stagingLandsOnItself({ ...same, mounts: [{ source: '', destination: '/app/data', type: 'tmpfs' }] })).toBe(false);
	});
});

describe('stagingDecision', () => {
	const plan = { stage: true, hostDir: '/srv/dockhand/stacks/local/plex', reason: 'x' };
	const self = {
		envDockerHost: 'tcp://dockhand-socket-proxy:2375', ownDockerHost: 'tcp://dockhand-socket-proxy:2375',
		workingDir: '/app/data/stacks/local/plex', hostDir: plan.hostDir,
		mounts: [{ source: '/srv/dockhand', destination: '/app/data', type: 'bind' }]
	};

	test('the bind rewrite applies whether or not the copy runs', () => {
		expect(stagingDecision(plan, self)).toEqual({ copy: false, rewriteHostDir: plan.hostDir });
		expect(stagingDecision(plan, { ...self, envDockerHost: 'tcp://10.0.0.5:2375' })).toEqual({ copy: true, rewriteHostDir: plan.hostDir });
	});

	test('self-check inputs that could not be read keep the copy', () => {
		expect(stagingDecision(plan, null)).toEqual({ copy: true, rewriteHostDir: plan.hostDir });
	});

	test('no staging plan: no copy and no rewrite', () => {
		expect(stagingDecision({ stage: false, reason: 'x' }, self)).toEqual({ copy: false, rewriteHostDir: undefined });
	});
});

describe('bind sources a restore wrote are left on the host', () => {
	test('a path under a kept bind source is not sent; neighbours with a shared prefix are', () => {
		expect(stagedPathSent('config', ['config'])).toBe(false);
		expect(stagedPathSent('config/app.conf', ['config'])).toBe(false);
		expect(stagedPathSent('nginx.conf', ['nginx.conf'])).toBe(false);
		expect(stagedPathSent('config2/app.conf', ['config'])).toBe(true);
		expect(stagedPathSent('configuration.conf', ['config'])).toBe(true);
		expect(stagedPathSent('config/app.conf', [])).toBe(true);
	});

	test("the stack's own .env is always sent, even when it is a restored bind", () => {
		// Held back, Dockhand would generate a .env from its stored variables in its place.
		expect(stagedPathSent('.env', ['.env'])).toBe(true);
		expect(stagedPathSent('.env.prod', ['.env.prod'])).toBe(true);
		expect(stagedPathSent('.envrc', ['.envrc'])).toBe(false);
		expect(stagedPathSent('config/.env', ['config'])).toBe(false);
		// A restored bind dir named like an env file is a dir, not the stack's .env.
		expect(stagedPathSent('.env.d/x', ['.env.d'])).toBe(false);
	});

	test('the file map drops only what is kept', () => {
		const files = { 'compose.yaml': 'c', '.env': 'A=1', 'config/app.conf': 'x', 'scripts/run.sh': 's' };
		expect(withoutBindSources(files, ['config', '.env'])).toEqual({ 'compose.yaml': 'c', '.env': 'A=1', 'scripts/run.sh': 's' });
		expect(withoutBindSources(files, [])).toEqual(files);
	});
});

