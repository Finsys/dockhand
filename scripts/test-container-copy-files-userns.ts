/**
 * Opt-in integration test against a disposable Docker >=29.7 daemon started with
 * --userns-remap=default. Never changes the daemon's configuration.
 * Run: COPY_FILE_TEST_DOCKER_HOST=tcp://127.0.0.1:2375 bun scripts/test-container-copy-files-userns.ts
 * Requires Docker CLI and an unauthenticated loopback TCP test endpoint.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mock } from 'bun:test';

const endpoint = process.env.COPY_FILE_TEST_DOCKER_HOST;
assert.ok(endpoint, 'Set COPY_FILE_TEST_DOCKER_HOST to an isolated remapped test daemon');
const address = new URL(endpoint);
assert.equal(address.protocol, 'tcp:');
assert.equal(address.hostname, '127.0.0.1');
const cli = (...args: string[]) => execFileSync('docker', ['--host', endpoint, ...args], { encoding: 'utf8' }).trim();
const info = JSON.parse(cli('info', '--format', '{{json .}}'));
assert.ok(info.SecurityOptions.includes('name=userns'), 'Test daemon must enable userns-remap');
const root = new URL('../src/lib/server/', import.meta.url).pathname;
const noop = async () => {};
mock.module(root + 'db', () => ({
	getSetting: async () => null, setSetting: noop, setEnvSetting: noop, deleteSetting: noop,
	getEnvironment: async () => ({ id: 1, connectionType: 'direct', protocol: 'http', host: address.hostname, port: Number(address.port) }),
	getSecretKeysToMask: async () => new Set(), getRegistries: async () => []
}));
mock.module(root + 'minimum-release-age', () => ({
	getMinimumReleaseAgeConfig: async () => ({ hours: 0 }), imageReleaseAgeRemainingMs: async () => 0, imageReleaseAgeStatus: async () => ({ remainingMs: 0 })
}));
mock.module(root + 'hawser', () => ({ isEdgeConnected: () => false, sendEdgeRequest: noop, sendEdgeStreamRequest: noop }));
const docker = await import(root + 'docker');
const project = `dockhand-copy-userns-${process.pid}`;
const paths = ['/run/secrets/root-owned', '/run/secrets/app-owned'];
const seed = (id: string) => cli('exec', '-u', '0', id, 'sh', '-c',
	'mkdir -p /run/secrets; printf synthetic-root >/run/secrets/root-owned; printf synthetic-app >/run/secrets/app-owned; ' +
	'chown 0:0 /run/secrets/root-owned; chown 12345:12346 /run/secrets/app-owned; chmod 600 /run/secrets/*');
let sequence = 0;
const create = (...args: string[]) => {
	const id = cli('run', '-d', '--name', `${project}-${++sequence}`, '--label', `copy-userns-test=${project}`,
		'--label', `dockhand.copy-file=${paths.join(',')}`, '--stop-timeout', '1', ...args, 'alpine:latest', 'sleep', '3600');
	seed(id);
	return id;
};
const verify = (id: string, owner: string) => {
	assert.equal(cli('inspect', '--format', '{{.State.Running}}', id), 'true');
	for (const path of paths) {
		assert.equal(cli('exec', id, 'stat', '-c', '%u:%g:%a', path), `${owner}:600`);
		assert.equal(cli('exec', id, 'cat', path), path.endsWith('root-owned') ? 'synthetic-root' : 'synthetic-app');
	}
};
const unchangedAfterFailure = async (id: string, update: () => Promise<unknown>, pattern: RegExp) => {
	const before = cli('inspect', '--format', '{{.State.StartedAt}}', id);
	await assert.rejects(update(), pattern);
	assert.equal(cli('inspect', '--format', '{{.State.StartedAt}}', id), before, 'unsupported operation must not stop the original');
	assert.equal(cli('inspect', '--format', '{{.State.Running}}', id), 'true');
};

try {
	let id = create('--user', '12345:12346');
	for (let cycle = 0; cycle < 2; cycle++) {
		const before = await docker.inspectContainer(id, 1);
		// The first instruction of the replacement must be able to read both files.
		before.Config.Cmd = ['sh', '-c', 'test -r /run/secrets/root-owned && test -r /run/secrets/app-owned && exec sleep 3600'];
		id = (await docker.recreateContainerFromInspect(before, 'alpine:latest', 1)).Id;
		verify(id, '12345:12346');
	}
	id = (await docker.updateContainer(id, { user: '12347:12348' }, true, 1)).id;
	verify(id, '12347:12348');
	await unchangedAfterFailure(id, () => docker.updateContainer(id, { user: '' }, true, 1), /explicit container user/);
	await unchangedAfterFailure(id, () => docker.updateContainer(id, { usernsMode: 'host' }, true, 1), /userns=host/);
	verify(id, '12347:12348');
	for (const [user, owner] of [['0', '0:0'], ['nobody:nobody', '65534:65534']]) {
		const old = create('--user', user);
		const replacement = await docker.recreateContainerFromInspect(await docker.inspectContainer(old, 1), 'alpine:latest', 1);
		verify(replacement.Id, owner);
	}
	for (const args of [[], ['--userns=host', '--user', '12345:12346']]) {
		const old = create(...args);
		await unchangedAfterFailure(old, async () => docker.recreateContainerFromInspect(await docker.inspectContainer(old, 1), 'alpine:latest', 1), /remapped daemon/);
	}
	console.log('PASS: remapped Docker preserved contents/modes across repeated recreations and edits, mapped mixed owners to numeric/named/root users, and rejected empty users and host namespace mode before stopping.');
} finally {
	const ids = cli('ps', '-aq', '--filter', `label=copy-userns-test=${project}`).split(/\s+/).filter(Boolean);
	if (ids.length) cli('rm', '-f', ...ids);
}
process.exit(0);
