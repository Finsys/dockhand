// Run in a child process: module mocks must never replace the suite's shared DB/engine.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { trackedImageLabels, trackedImageReference } from '../../src/lib/utils/tracked-image';
import { releaseAgeAdvisory } from '../../src/lib/server/release-age-advisory';

const boundedAdvisory = releaseAgeAdvisory;
const phase = process.argv[2];
const scanning = phase.includes('scan');
const systemd = phase.includes('systemd');
const root = new URL('../../src/lib/server/', import.meta.url).pathname;
const image = 'registry.example.com/team/app:latest';
const digest = 'sha256:' + 'a'.repeat(64);
const approved = 'sha256:' + 'b'.repeat(64);
const young = 'sha256:' + 'c'.repeat(64);
const old = 'sha256:' + 'd'.repeat(64);
const originalId = '1'.repeat(64);
const createdId = '2'.repeat(64);
let localTag = old;
let createBody: any;
let pullReferences: string[] = [];
let scans: string[] = [];
let executions: any[] = [];
let current = {
	Id: originalId, Name: '/app', Image: old,
	// Begin with a container previously created from an immutable ID, to check the next update.
	Config: { Image: old, Env: ['VERSION=old'], Labels: trackedImageLabels(systemd ? { PODMAN_SYSTEMD_UNIT: 'app.service' } : {}, image, old) },
	HostConfig: { NetworkMode: 'host' }, State: { Running: false }, NetworkSettings: { Networks: {} }
};
const noop = async () => {};
const environment = { id: 1, name: 'test', connectionType: 'direct', protocol: 'http', host: 'daemon.test', port: 2375 };
const db = {
	getSetting: async () => null, setSetting: noop, getEnvironment: async () => environment,
	getRegistries: async () => [], getAutoUpdateSettingById: async () => ({ vulnerabilityCriteria: 'never' }),
	updateAutoUpdateLastChecked: noop, updateAutoUpdateLastUpdated: noop,
	createScheduleExecution: async () => ({ id: 1 }), updateScheduleExecution: async (_id: number, data: any) => { executions.push(data); },
	appendScheduleExecutionLog: noop, saveVulnerabilityScan: noop, getCombinedScanForImage: async () => null,
	getEnvUpdateCheckSettings: async () => ({ enabled: true, autoUpdate: true, vulnerabilityCriteria: 'never' }),
	getGlobalSemverConfig: async () => ({ enabled: false }), clearPendingContainerUpdates: noop,
	addPendingContainerUpdate: noop, removePendingContainerUpdate: noop, getPendingContainerUpdates: async () => []
};
mock.module(root + 'db', () => db);
mock.module(root + 'hawser', () => ({ sendEdgeRequest: noop, sendEdgeStreamRequest: noop, isEdgeConnected: () => false }));
mock.module(root + 'minimum-release-age', () => ({
	getMinimumReleaseAgeConfig: async () => ({ hours: phase.includes('disabled') ? 0 : 24 }),
	imageReleaseAgeRemainingMs: async () => phase === 'young' ? 3600000 : 0,
	imageReleaseAgeStatus: async () => ({ source: 'first-observed', observedAt: new Date().toISOString(), remainingMs: 86400000 })
}));
mock.module(root + 'release-age-advisory', () => ({ releaseAgeAdvisory: (lookup: any) => boundedAdvisory(lookup, 30) }));
mock.module(root + 'scanner', () => ({
	getScannerSettings: async () => ({ scanner: scanning ? 'trivy' : 'none' }),
	scanImage: async (id: string) => { scans.push(id); return []; }
}));
mock.module(root + 'notifications', () => ({ sendEventNotification: noop }));
mock.module(root + 'semver/check', () => ({ checkNewerVersion: async () => null }));
mock.module(root + 'authorize', () => ({ authorize: async () => ({ authEnabled: false }) }));
mock.module(root + 'audit', () => ({ auditContainer: noop }));

const calls: string[] = [];
let stalledSignal: AbortSignal | undefined;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
	const url = new URL(String(input));
	const path = decodeURIComponent(url.pathname);
	const method = init.method ?? 'GET';
	calls.push(method + ' ' + path);
	if (url.hostname !== 'daemon.test') {
		assert.equal(url.hostname, 'registry.example.com', 'Unexpected network access');
		if ((phase === 'timeout-auth' && path === '/v2/') || (phase === 'timeout-head' && method === 'HEAD')) { stalledSignal = init.signal!; return new Promise(() => {}); }
		if (path === '/v2/') return new Response('{}');
		if (path.includes('/manifests/')) return Response.json({ schemaVersion: 2 });
		throw new Error('Unexpected registry request ' + path);
	}
	if (path.startsWith('/distribution/')) {
		assert.ok(path.includes(image), 'Update checks must follow the original tag');
		if (phase === 'timeout-daemon') { stalledSignal = init.signal!; return new Promise(() => {}); }
		if (phase.startsWith('timeout-')) return new Response(null, { status: 404 });
		return Response.json({ Descriptor: { digest } });
	}
	if (path === '/containers/json') {
		if (url.searchParams.has('filters')) return Response.json([]);
		return Response.json([{ Id: current.Id, Names: ['/app'], Image: current.Config.Image, ImageID: current.Image, Labels: current.Config.Labels, State: 'exited', Status: 'Exited (0)' }]);
	}
	if (path.startsWith('/containers/') && path.endsWith('/json')) return Response.json(current);
	if (path.startsWith('/images/') && path.endsWith('/json')) {
		const ref = path.slice('/images/'.length, -'/json'.length);
		const id = ref === image ? localTag : ref.includes('@') ? approved : ref;
		return Response.json({ Id: id, RepoDigests: ['registry.example.com/team/app@' + (id === approved ? digest : old)], Config: { Env: [id === approved ? 'VERSION=approved' : id === old ? 'VERSION=old' : 'VERSION=other'], Labels: {} } });
	}
	if (path === '/images/create') {
		pullReferences.push(url.searchParams.get('fromImage')!);
		localTag = approved;
		return new Response('{"status":"Downloaded"}\n');
	}
	if (path.startsWith('/images/') && path.endsWith('/tag')) {
		if (url.searchParams.get('tag') === 'latest') localTag = path.slice('/images/'.length, -'/tag'.length);
		if (localTag === approved) localTag = young; // Also race the scheduler's scan-ID handoff.
		return new Response(null, { status: 201 });
	}
	if (path.endsWith('/rename')) {
		// A competing manual pull repoints latest immediately before recreation.
		localTag = young;
		return new Response(null, { status: 204 });
	}
	if (path === '/containers/create') {
		createBody = JSON.parse(init.body as string);
		current = { ...current, Id: createdId, Config: createBody, Image: createBody.Image };
		return Response.json({ Id: createdId });
	}
	if (method === 'DELETE') return new Response(null, { status: 204 });
	throw new Error('Unexpected Docker request ' + method + ' ' + path);
}) as typeof fetch;

const docker = await import(root + 'docker');
if (phase.startsWith('timeout-')) {
	const progress: any[] = [];
	await docker.pullImage(image, (data: any) => progress.push(data), 1);
	assert.equal(stalledSignal?.aborted, true);
	assert.ok(progress.some(p => p.status === 'warning' && p.message.includes('could not be determined')));
	assert.equal(pullReferences.length, 1, 'An advisory timeout must still pull');
} else if (phase === 'young') {
	await assert.rejects(docker.pullImage(image, undefined, 1, true), /cooldown/);
	assert.equal(pullReferences.length, 0, 'Ineligible images must not be pulled');
} else if (phase === 'warning-json') {
	const { POST } = await import('../../src/routes/api/containers/batch-update/+server');
	const response = await POST({ url: new URL('http://dockhand/api/containers/batch-update?env=1'), cookies: {}, request: new Request('http://dockhand', { method: 'POST', body: JSON.stringify({ containerIds: [originalId] }) }) } as any);
	const body = await response.json();
	assert.equal(body.results[0].success, true, JSON.stringify(body));
	assert.equal(body.results[0].warnings[0].status, 'warning');
	assert.match(body.results[0].warnings[0].message, /Pulling it anyway/);
} else if (phase === 'warning-stream') {
	const { POST } = await import('../../src/routes/api/containers/batch-update-stream/+server');
	const { getJob } = await import(root + 'jobs');
	const response = await POST({ url: new URL('http://dockhand/api/containers/batch-update-stream?env=1'), cookies: {}, request: new Request('http://dockhand', { method: 'POST', body: JSON.stringify({ containerIds: [originalId] }) }) } as any);
	const { jobId } = await response.json();
	const job = getJob(jobId);
	for (let i = 0; i < 100 && job.status === 'running'; i++) await new Promise(r => setTimeout(r, 5));
	assert.equal(job.status, 'done', JSON.stringify(job));
	const warning = job.lines.find((l: any) => l.data.pullStatus === 'warning');
	assert.match(warning?.data.pullMessage, /Pulling it anyway/);
} else {
	if (phase.startsWith('env')) {
		const { runEnvUpdateCheckJob } = await import(root + 'scheduler/tasks/env-update-check');
		await runEnvUpdateCheckJob(1, 'cron');
	} else {
		const { runContainerUpdate } = await import(root + 'scheduler/tasks/container-update');
		await runContainerUpdate(1, 'app', 1, 'cron');
	}
	if (systemd) {
		assert.equal(pullReferences.length, 0, 'Do not move a systemd unit tag before deferring');
		assert.equal(createBody, undefined);
	} else {
		assert.ok(createBody, JSON.stringify(executions));
		assert.equal(createBody.Image, phase.includes('disabled') ? image : approved, 'Recreation must use the verified image despite tag movement');
		assert.equal(createBody.Env[0], phase.includes('disabled') ? 'VERSION=other' : 'VERSION=approved', 'Rebase must use the verified image too');
		assert.equal(trackedImageReference(createBody.Image, createBody.Labels), image, 'Future update checks retain the source tag');
		assert.equal(pullReferences[0], phase.includes('disabled') ? image.split(':')[0] : image.split(':')[0] + '@' + digest);
		if (scanning) assert.deepEqual(scans, [approved], 'Scan the same image that will be created');
		assert.ok(executions.some(e => e.status === 'success'), JSON.stringify(executions));
	}
}
process.exit(0);
