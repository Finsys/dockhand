import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import { packTar, unpackTar } from 'modern-tar';

const phase = process.argv[2];
const editing = phase.startsWith('edit');
const stopped = phase.includes('stopped');
const removedLabel = phase.includes('remove-label');
const edge = phase.includes('edge');
const root = new URL('../../src/lib/server/', import.meta.url).pathname;
const noop = async () => {};
mock.module(root + 'db', () => ({
	getSetting: async () => null, setSetting: noop, setEnvSetting: noop, deleteSetting: noop,
	getEnvironment: async () => ({ id: 1, connectionType: edge ? 'hawser-edge' : 'direct', protocol: 'http', host: 'copy-file.test', port: 2375 }),
	getSecretKeysToMask: async () => new Set(), getRegistries: async () => []
}));
mock.module(root + 'minimum-release-age', () => ({
	getMinimumReleaseAgeConfig: async () => ({ hours: 0 }), imageReleaseAgeRemainingMs: async () => 0, imageReleaseAgeStatus: async () => ({ remainingMs: 0 })
}));
mock.module(root + 'hawser', () => ({
	isEdgeConnected: () => true, sendEdgeStreamRequest: noop,
	sendEdgeRequest: async (_env: number, method: string, path: string, body: unknown, headers: HeadersInit, _streaming: boolean, _timeout: number, isBinary: boolean) => {
		if (method === 'PUT') assert.equal(isBinary, true, 'Hawser must send archive bytes as binary');
		const response = await engine(path, { method, headers, body: isBinary ? Buffer.from(body as string, 'base64') : body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
		const binary = path.includes('/archive') && method === 'GET' && response.ok;
		return { statusCode: response.status === 204 ? 200 : response.status, headers: Object.fromEntries(response.headers), body: binary ? Buffer.from(await response.arrayBuffer()).toString('base64') : await response.text(), isBinary: binary };
	}
}));

const secretPath = '/run/secrets/token';
const composeDiscovery = phase.includes('compose');
const composeDir = composeDiscovery ? mkdtempSync(join(tmpdir(), 'copy-file-probe-')) : undefined;
if (composeDir) {
	process.on('exit', () => rmSync(composeDir, { recursive: true, force: true }));
	if (!phase.includes('unreadable')) writeFileSync(join(composeDir, 'compose.yaml'), `
services:
  app:
    secrets: [token]
  other:
    secrets: [other-secret]
secrets:
  token: {environment: TOKEN}
  other-secret: {environment: OTHER_SECRET}
`);
}
const labels: Record<string, string> = composeDir ? {
	'com.docker.compose.project': 'probe',
	'com.docker.compose.service': 'app',
	'com.docker.compose.project.config_files': 'compose.yaml',
	'com.docker.compose.project.working_dir': composeDir,
	...(phase.includes('unreadable') ? { 'dockhand.copy-file': secretPath } : {})
} : { 'dockhand.copy-file': secretPath };
const secret = new Uint8Array([0, 255, 65, 13, 10]);
const calls: string[] = [];
let sequence = 0;
let failureTriggered = false;
const original = {
	Id: 'old', Name: '/app', Image: 'old-image', State: { Running: !stopped },
	Config: { Image: 'app:latest', Env: [], Labels: labels },
	HostConfig: { NetworkMode: 'host', RestartPolicy: { Name: 'no' } },
	NetworkSettings: { Networks: {} }, Mounts: []
};
const containers = new Map<string, any>([['old', structuredClone(original)]]);
if (phase.includes('mounts')) {
	const current = containers.get('old');
	current.HostConfig.Mounts = [
		{ Type: 'bind', Source: '/host/token', Target: '/run/secrets/disk', ReadOnly: true, BindOptions: { NonRecursive: true } },
		{ Type: 'volume', Source: 'data', Target: '/data', VolumeOptions: { NoCopy: true } }
	];
	current.Mounts = [{ Type: 'volume', Name: 'data', Destination: '/data', RW: true }];
}
const files = new Map<string, Uint8Array>([['old', secret]]);

async function engine(input: string, options: RequestInit = {}): Promise<Response> {
	const url = new URL(input, 'http://copy-file.test');
	const path = decodeURIComponent(url.pathname);
	const method = options.method ?? 'GET';
	calls.push(`${method} ${path}`);
	if (path.startsWith('/images/') && path.endsWith('/json')) return Response.json({ Id: 'new-image', Config: { Env: [], Labels: {} } });
	if (path === '/containers/create') {
		if (phase.includes('create-failure') && !failureTriggered) { failureTriggered = true; return Response.json({ message: 'create failed' }, { status: 500 }); }
		const config = JSON.parse(options.body as string);
		if (phase.includes('mounts')) {
			const expected = [
				{ Type: 'bind', Source: '/host/token', Target: '/run/secrets/disk', ReadOnly: true, BindOptions: { NonRecursive: true } },
				{ Type: 'volume', Source: 'data', Target: '/data', VolumeOptions: { NoCopy: true } }
			];
			assert.deepEqual(config.HostConfig.Mounts, phase.includes('override') ? expected.slice(1) : expected,
				'settings edits must preserve structured mount options except explicit target overrides');
			if (phase.includes('override')) assert.deepEqual(config.HostConfig.Binds, ['/new/token:/run/secrets/disk:ro']);
			assert.ok(!config.HostConfig.Binds?.some((bind: string) => bind.includes(':/data')), 'do not duplicate structured volume mounts');
		}
		const Id = 'new' + ++sequence;
		containers.set(Id, { ...structuredClone(original), Id, Name: '/' + url.searchParams.get('name'), Config: config, HostConfig: config.HostConfig, State: { Running: false } });
		return Response.json({ Id });
	}
	const match = /^\/containers\/([^/]+)(?:\/(.*))?$/.exec(path);
	assert.ok(match, 'Unexpected Docker request ' + path);
	const [, id, operation] = match;
	const container = containers.get(id);
	assert.ok(container, 'Unknown container ' + id);
	if (operation === 'json') return Response.json(container);
	if (operation === 'archive') {
		if (method === 'HEAD') return new Response(null, { headers: {
			'X-Docker-Container-Path-Stat': Buffer.from(JSON.stringify({ name: 'token', size: secret.length, mode: 0o400 })).toString('base64')
		} });
		if (method === 'GET') {
			assert.equal(container.State.Running, !stopped, 'snapshot precedes stop');
			assert.equal(url.searchParams.get('path'), secretPath);
			if (phase.includes('missing')) return new Response('not found', { status: 404 });
			return new Response(await packTar([{ header: { name: 'token', type: 'file', mode: 0o400, uid: 123, gid: 456, size: secret.length }, body: files.get(id)! }]));
		}
		assert.equal(method, 'PUT');
		assert.equal(container.State.Running, false, 'must inject before first start');
		assert.equal(url.searchParams.get('copyUIDGID'), 'false');
		assert.equal(url.searchParams.get('path'), '/');
		if (phase.includes('copy-failure') && !failureTriggered) { failureTriggered = true; return new Response('secret must not appear in logs', { status: 500 }); }
		const [file] = await unpackTar(options.body as Uint8Array);
		assert.equal(file.header.name, secretPath.slice(1));
		assert.equal(file.header.mode, 0o400);
		assert.equal(file.header.uid, 123);
		assert.equal(file.header.gid, 456);
		files.set(id, file.data!);
		return new Response(null, { status: 200 });
	}
	if (operation === 'stop') { container.State.Running = false; return new Response(null, { status: 204 }); }
	if (operation === 'rename') { container.Name = '/' + url.searchParams.get('name'); return new Response(null, { status: 204 }); }
	if (operation === 'start') {
		if (!removedLabel) assert.deepEqual(files.get(id), secret, 'file must exist at first instruction');
		if (id !== 'old' && phase.includes('start-failure') && !failureTriggered) { failureTriggered = true; return new Response('{}', { status: 500 }); }
		container.State.Running = true;
		return new Response(null, { status: 204 });
	}
	if (method === 'DELETE') { containers.delete(id); files.delete(id); return new Response(null, { status: 204 }); }
	throw new Error('Unexpected Docker operation ' + method + ' ' + path);
}

globalThis.fetch = ((url: string, options?: RequestInit) => engine(url, options)) as typeof fetch;
const docker = await import(root + 'docker');
const logs: string[] = [];
const update = (id: string) => editing
	? docker.updateContainer(id, removedLabel || phase.includes('edit-labels') ? { labels: {} }
		: phase.includes('override') ? { volumeBinds: ['/new/token:/run/secrets/disk:ro'] } : {}, !stopped, 1)
	: docker.recreateContainerFromInspect(structuredClone(containers.get(id)), 'app:latest', 1, (msg: string) => logs.push(msg));

if (phase.includes('failure') || phase.includes('missing')) {
	await assert.rejects(update('old'));
	assert.equal(containers.size, 1);
	assert.equal(containers.get('old').Name, '/app');
	assert.equal(containers.get('old').State.Running, !stopped, 'original must remain running or be restarted');
	assert.deepEqual(files.get('old'), secret);
	if (phase.includes('missing')) assert.ok(calls.every(call => /^(GET|HEAD) /.test(call)), 'snapshot failure must not mutate containers');
	if (phase.includes('copy-failure')) assert.ok(!calls.includes('POST /containers/new1/start'), 'failed copy must prevent start');
	assert.ok(!logs.join('\n').includes('secret must not appear in logs'));
} else {
	await update('old');
	assert.equal(containers.has('old'), false);
	assert.equal(containers.get('new1').State.Running, !stopped);
	if (removedLabel) {
		assert.ok(calls.every(call => !call.includes('/archive')));
	} else {
		assert.deepEqual(files.get('new1'), secret);
		await update('new1');
		assert.equal(containers.size, 1);
		assert.deepEqual(files.get('new2'), secret, 'must survive subsequent updates too');
	}
}
// docker.ts maintains a cache cleanup interval; don't keep the isolated probe alive.
process.exit(0);
