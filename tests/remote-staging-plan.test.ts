import { describe, test, expect } from 'bun:test';
import { planRemoteStaging, rewriteBindsToHostDir } from '../src/lib/server/remote-staging-plan';

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
