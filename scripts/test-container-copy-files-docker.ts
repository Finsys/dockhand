/**
 * Opt-in real Docker smoke test. Uses an isolated Compose project and synthetic
 * secrets; removes only its own containers and temporary directory on exit.
 * Run: bun scripts/test-container-copy-files-docker.ts
 * Requires Docker Compose and a local Unix-socket Docker context.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';

const root = new URL('../src/lib/server/', import.meta.url).pathname;
const project = `dockhand-copy-file-test-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'dockhand-copy-file-'));
const file = join(dir, 'compose.yaml');
const env = { ...process.env, COPY_FILE_TEST_TOKEN: 'synthetic-token-123', COPY_FILE_TEST_CONFIG: 'synthetic-config-456' };
const cli = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const compose = (...args: string[]) => cli('compose', '-p', project, '-f', file, ...args);
const endpoint = cli('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
assert.ok(endpoint.startsWith('unix://'), 'Use a local Unix-socket Docker context');
const noop = async () => {};
mock.module(root + 'db', () => ({
	getSetting: async () => null, setSetting: noop, setEnvSetting: noop, deleteSetting: noop,
	getEnvironment: async () => ({ id: 1, connectionType: 'socket', socketPath: endpoint.slice(7) }),
	getSecretKeysToMask: async () => new Set(), getRegistries: async () => []
}));
mock.module(root + 'minimum-release-age', () => ({
	getMinimumReleaseAgeConfig: async () => ({ hours: 0 }), imageReleaseAgeRemainingMs: async () => 0, imageReleaseAgeStatus: async () => ({ remainingMs: 0 })
}));
mock.module(root + 'hawser', () => ({ isEdgeConnected: () => false, sendEdgeRequest: noop, sendEdgeStreamRequest: noop }));

writeFileSync(file, `services:
  probe:
    image: alpine:latest
    user: "12345:12345"
    stop_grace_period: 1s
    command: ["sh", "-c", "test -r /run/secrets/token && test -r /new-parent/config/token && exec sleep 3600"]
    secrets:
      - root-owned
      - source: token
        target: token
        uid: "12345"
        gid: "12345"
        mode: 0400
      - source: config
        target: /new-parent/config/token
        uid: "12345"
        gid: "12345"
        mode: 0400
secrets:
  root-owned:
    environment: COPY_FILE_TEST_TOKEN
  token:
    environment: COPY_FILE_TEST_TOKEN
  config:
    environment: COPY_FILE_TEST_CONFIG
`);

try {
	compose('up', '-d');
	const docker = await import(root + 'docker');
	let id = compose('ps', '-q', 'probe');
	assert.ok(id, 'Compose probe must be running');
	function verify(id: string) {
		assert.equal(cli('inspect', '--format', '{{.State.Running}}', id), 'true');
		assert.equal(cli('exec', id, 'cat', '/run/secrets/token'), env.COPY_FILE_TEST_TOKEN);
		assert.equal(cli('exec', id, 'cat', '/new-parent/config/token'), env.COPY_FILE_TEST_CONFIG);
		assert.equal(cli('exec', id, 'stat', '-c', '%u:%g:%a', '/run/secrets/token'), '12345:12345:400');
		assert.equal(cli('exec', id, 'stat', '-c', '%u:%g:%a', '/run/secrets/root-owned'), '0:0:444');
	}
	verify(id);
	const initial = await docker.inspectContainer(id, 1);
	assert.equal(initial.Config.Labels['dockhand.copy-file'], undefined, 'probe must exercise automatic discovery');
	assert.equal(initial.Config.Labels['com.docker.compose.project'], project);
	// Exercise the real daemon's HEAD route and header format explicitly. The
	// recreation cycles below then run the same preflight before each bounded GET.
	const head = await docker.dockerFetch(`/containers/${id}/archive?path=%2Frun%2Fsecrets%2Ftoken`, { method: 'HEAD' }, 1);
	assert.equal(head.status, 200);
	const encodedStat = head.headers.get('X-Docker-Container-Path-Stat');
	assert.ok(encodedStat, 'real Docker must return the HEAD path-stat header');
	const stat = JSON.parse(Buffer.from(encodedStat, 'base64').toString('utf8'));
	assert.equal(stat.name, 'token');
	assert.equal(stat.size, Buffer.byteLength(env.COPY_FILE_TEST_TOKEN));
	assert.equal(stat.mode, 0o400);
	assert.equal(stat.linkTarget, '');
	assert.equal((await head.arrayBuffer()).byteLength, 0, 'HEAD must not download the secret');
	for (let cycle = 0; cycle < 2; cycle++) {
		const before = await docker.inspectContainer(id, 1);
		const replacement = await docker.recreateContainerFromInspect(before, 'alpine:latest', 1);
		assert.notEqual(replacement.Id, id);
		id = replacement.Id;
		verify(id);
	}
	// A duplicate explicit target must coexist with discovered targets; editing
	// labels must still discover from the current container's Compose metadata.
	const edited = await docker.updateContainer(id, { labels: { 'dockhand.copy-file': '/run/secrets/token' } }, true, 1);
	verify(edited.id);
	await assert.rejects(docker.updateContainer(edited.id, { readonlyRootfs: true }, true, 1), /dockhand.copy-file/);
	verify(edited.id);
	assert.equal(cli('inspect', '--format', '{{.Name}}', edited.id), `/${project}-probe-1`);
	console.log('PASS: Real Docker HEAD returned valid path-stat metadata; automatically discovered Compose secrets survived two image recreations, an explicit-label edit, and read-only failure rollback, including custom targets and non-root ownership.');
} finally {
	// Include any -old rollback container carrying our project label.
	const ids = cli('ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`).split(/\s+/).filter(Boolean);
	if (ids.length) cli('rm', '-f', ...ids);
	compose('down', '--remove-orphans');
	rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
