// Run in a child process: module mocks must never replace the suite's shared DB/engine.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { portableImageReference, trackedImageLabels, trackedImageReference } from '../../src/lib/utils/tracked-image';
import { releaseAgeAdvisory } from '../../src/lib/server/release-age-advisory';
import { buildSnapshotLayout, parseSnapshotLayout, serializeLayout } from '../../src/lib/server/backups/snapshot-layout';
import { inspectToComposeService } from '../../src/lib/utils/inspect-to-compose';

const boundedAdvisory = releaseAgeAdvisory;
const phase = process.argv[2];
const scanning = phase.includes('scan');
const systemd = phase.includes('systemd');
const systemdFailure = systemd && (phase.includes('race') || phase.includes('inspect-failure') || phase.includes('preflight'));
const deferred = phase.includes('young');
let remainingMs = deferred ? 3600001 : 0;
let ageChecks = 0;
const pendingUpdates: any[] = [];
const logs: string[] = [];
const root = new URL('../../src/lib/server/', import.meta.url).pathname;
const image = phase === 'portable-hub' ? 'nginx:latest' : 'registry.example.com/team/app:latest';
const digest = 'sha256:' + 'a'.repeat(64);
const approved = 'sha256:' + 'b'.repeat(64);
const young = 'sha256:' + 'c'.repeat(64);
const old = 'sha256:' + 'd'.repeat(64);
const originalId = '1'.repeat(64);
const createdId = '2'.repeat(64);
const rollbackId = '3'.repeat(64);
const destinationImageId = 'sha256:' + 'e'.repeat(64);
let destinationHasImage = false;
let destinationConfig: any;
let restoreReference = '';
let localTag = old;
let createBody: any;
let pullReferences: string[] = [];
let scans: string[] = [];
let executions: any[] = [];
let replacementInspections = 0;
let lastUpdated = 0;
let removedPending = 0;
let current = {
	Id: originalId, Name: '/app', Image: old,
	// Begin with a container previously created from an immutable ID, to check the next update.
	Config: { Image: old, Env: ['VERSION=old'], Labels: trackedImageLabels(systemd ? { PODMAN_SYSTEMD_UNIT: 'app.service' } : {}, image, old) },
	HostConfig: { NetworkMode: 'host' }, State: { Running: systemd }, NetworkSettings: { Networks: {} }
};
const noop = async () => {};
const environment = { id: 1, name: 'test', connectionType: 'direct', protocol: 'http', host: 'daemon.test', port: 2375 };
const db = {
	setEnvSetting: noop, deleteSetting: noop,
	getSetting: async () => phase === 'metadata-info-failure' ? 72 : null, setSetting: noop, getEnvironment: async (id: number) => id === 2 && phase !== 'metadata-info-failure' ? { ...environment, id: 2, host: 'destination.test' } : environment,
	getSecretKeysToMask: async () => new Set(),
	getRegistries: async () => [], getAutoUpdateSettingById: async () => ({ vulnerabilityCriteria: 'never' }),
	updateAutoUpdateLastChecked: noop, updateAutoUpdateLastUpdated: async () => { lastUpdated++; },
	createScheduleExecution: async () => ({ id: 1 }), updateScheduleExecution: async (_id: number, data: any) => { executions.push(data); },
	appendScheduleExecutionLog: async (_id: number, line: string) => { logs.push(line); }, saveVulnerabilityScan: noop, getCombinedScanForImage: async () => null,
	getEnvUpdateCheckSettings: async () => ({ enabled: true, autoUpdate: true, vulnerabilityCriteria: 'never' }),
	getGlobalSemverConfig: async () => ({ enabled: false }), clearPendingContainerUpdates: noop,
	addPendingContainerUpdate: async (...args: any[]) => { pendingUpdates.push(args); }, removePendingContainerUpdate: async () => { removedPending++; }, removePendingContainerUpdateByName: async () => { removedPending++; }, getPendingContainerUpdates: async () => []
};
mock.module(root + 'db', () => db);
mock.module(root + 'hawser', () => ({ sendEdgeRequest: noop, sendEdgeStreamRequest: noop, isEdgeConnected: () => false }));
const metadataDatabase = phase === 'metadata-info-failure' ? new Database(':memory:') : null;
if (metadataDatabase) {
	metadataDatabase.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
	const { settings } = await import(root + 'db/schema/index.ts');
	mock.module(root + 'db/drizzle', () => ({ db: drizzle(metadataDatabase), settings }));
} else {
	mock.module(root + 'minimum-release-age', () => ({
		getMinimumReleaseAgeConfig: async (id: number) => ({ hours: id === 2 || phase.includes('disabled') ? 0 : 24 }),
		imageReleaseAgeRemainingMs: async () => { ageChecks++; return remainingMs; },
		imageReleaseAgeStatus: async () => ({ source: 'first-observed', observedAt: new Date().toISOString(), remainingMs: 86400000 })
	}));
}
mock.module(root + 'release-age-advisory', () => ({ releaseAgeAdvisory: (lookup: any) => boundedAdvisory(lookup, 30) }));
mock.module(root + 'scanner', () => ({
	getScannerSettings: async () => ({ scanner: scanning ? 'trivy' : 'none' }),
	scanImage: async (id: string) => { scans.push(id); return []; }
}));
mock.module(root + 'notifications', () => ({ sendEventNotification: noop }));
mock.module(root + 'semver/check', () => ({ checkNewerVersion: async () => null }));
mock.module(root + 'authorize', () => ({ authorize: async () => ({ authEnabled: false }) }));
mock.module(root + 'audit', () => ({ auditContainer: noop }));
mock.module(root + 'stacks', () => ({ getStackComposeFile: noop }));

const calls: string[] = [];
let stalledSignal: AbortSignal | undefined;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
	const url = new URL(String(input));
	const path = decodeURIComponent(url.pathname);
	const method = init.method ?? 'GET';
	calls.push(method + ' ' + path);
	if (url.hostname === 'destination.test') {
		if (path.startsWith('/images/') && path.endsWith('/json')) {
			assert.equal(path, '/images/' + restoreReference + '/json', 'Restore must inspect the immutable registry reference');
			return destinationHasImage ? Response.json({ Id: destinationImageId }) : new Response('{}', { status: 404 });
		}
		if (path === '/images/create') {
			assert.equal(url.searchParams.get('fromImage'), restoreReference, 'Restore must pull the approved manifest, never the mutable tag or local ID');
			assert.equal(url.searchParams.get('tag'), null);
			destinationHasImage = true;
			return new Response('{"status":"Downloaded"}\n');
		}
		if (path === '/containers/create') {
			destinationConfig = JSON.parse(init.body as string);
			return Response.json({ Id: createdId });
		}
		if (path === '/containers/' + createdId + '/start') return new Response(null, { status: 204 });
		throw new Error('Unexpected destination request ' + method + ' ' + path);
	}
	if (url.hostname !== 'daemon.test') {
		assert.equal(url.hostname, 'registry.example.com', 'Unexpected network access');
		if ((phase === 'timeout-auth' && path === '/v2/') || (phase === 'timeout-head' && method === 'HEAD')) { stalledSignal = init.signal!; return new Promise(() => {}); }
		if (path === '/v2/') return new Response('{}');
		if (path.includes('/manifests/')) return Response.json({ schemaVersion: 2 }, { headers: { 'Docker-Content-Digest': digest } });
		throw new Error('Unexpected registry request ' + path);
	}
	if (path.startsWith('/distribution/')) {
		assert.ok(path.includes(image), 'Update checks must follow the original tag');
		if (phase === 'timeout-daemon') { stalledSignal = init.signal!; return new Promise(() => {}); }
		if (phase.startsWith('timeout-')) return new Response(null, { status: 404 });
		return Response.json({ Descriptor: { digest } });
	}
	if (phase === 'metadata-info-failure' && path === '/info') return new Response('{}', { status: 503 });
	if (path === '/containers/json') {
		if (url.searchParams.has('filters')) return Response.json(systemd ? [{ Id: current.Id, Names: ['/app'], State: current.State.Running ? 'running' : 'exited' }] : []);
		return Response.json([{ Id: current.Id, Names: ['/app'], Image: current.Config.Image, ImageID: current.Image, Labels: current.Config.Labels, State: 'exited', Status: 'Exited (0)' }]);
	}
	if (systemd && path === '/containers/' + originalId + '/stop') {
		assert.equal(localTag, approved, 'The approved tag must be selected before systemd respawns');
		if (phase.includes('race')) localTag = young;
		current = { ...current, Id: createdId, Image: localTag, State: { Running: true } };
		return new Response(null, { status: 204 });
	}
	if (systemd && path === '/containers/' + createdId + '/stop') {
		assert.equal(localTag, old, 'Rollback must restore the previous tag before restarting systemd');
		if (phase.includes('rollback-failure')) localTag = young;
		current = { ...current, Id: rollbackId, Image: localTag, State: { Running: true } };
		return new Response(null, { status: 204 });
	}
	if (systemd && path === '/containers/' + createdId + '/json') {
		replacementInspections++;
		if (phase.includes('inspect-failure')) return new Response('{}', { status: 503 });
	}
	if (path.startsWith('/containers/') && path.endsWith('/json')) return Response.json(current);
	if (path.startsWith('/images/') && path.endsWith('/json')) {
		const ref = path.slice('/images/'.length, -'/json'.length);
		if (phase === 'portable-unavailable') return new Response('{}', { status: 404 });
		if (systemd && phase.includes('preflight') && ref === image) localTag = young;
		const id = ref === image ? localTag : ref.includes('@') ? approved : ref;
		const repo = phase === 'portable-hub' ? 'registry-1.docker.io/library/nginx' : 'registry.example.com/team/app';
		return Response.json({ Id: id, RepoDigests: phase.includes('empty') ? [] : ['registry.example.com/unrelated/app@' + young, repo + '@' + (id === approved ? digest : old)], Config: { Env: [id === approved ? 'VERSION=approved' : id === old ? 'VERSION=old' : 'VERSION=other'], Labels: {} } });
	}
	if (path === '/images/create') {
		pullReferences.push(url.searchParams.get('fromImage')!);
		localTag = approved;
		return new Response('{"status":"Downloaded"}\n');
	}
	if (path.startsWith('/images/') && path.endsWith('/tag')) {
		if (url.searchParams.get('tag') === 'latest') localTag = path.slice('/images/'.length, -'/tag'.length);
		if (!systemd && localTag === approved) localTag = young; // Also race the scheduler's scan-ID handoff.
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
async function assertPortableRoundTrip(expectedReference: string) {
	// Exercise the export endpoint before capture enriches the old tracking label.
	const { GET } = await import('../../src/routes/api/containers/[id]/compose/+server');
	const response = await GET({ params: { id: current.Id }, url: new URL('http://dockhand/api/containers/' + current.Id + '/compose?env=1'), cookies: {} } as any);
	assert.equal(response.status, 200);
	const exported = await response.json();
	for (const compose of [exported.compose, exported.composeFullEnv]) {
		assert.ok(compose.includes(expectedReference), 'Both Compose variants must preserve the approved registry digest');
		assert.ok(!compose.includes('dockhand.update.source'), 'Do not export local tracking metadata');
	}

	// Capture on the source, serialize a real snapshot layout, then restore on an
	// empty destination with a different platform-local ID for the same manifest.
	const config = await docker.getPortableContainerConfig(current.Config, 1);
	assert.equal(portableImageReference(config.Image, config.Labels), expectedReference);
	assert.equal(inspectToComposeService({ Config: config }).service.image, expectedReference);
	const snapshot = parseSnapshotLayout(serializeLayout(buildSnapshotLayout({
		type: 'container', targetName: 'app', environmentId: 1, backupTime: new Date().toISOString(), volumes: [],
		container: { ...current, Config: config }
	})))!.container as typeof current;
	restoreReference = expectedReference;
	await docker.createContainerFromMetadata('restored-app', snapshot.Config.Image, {
		config: snapshot.Config, hostConfig: snapshot.HostConfig, networkSettings: snapshot.NetworkSettings
	}, 2);
	assert.ok(destinationHasImage, 'Restore must pull the missing image');
	assert.equal(destinationConfig.Image, destinationImageId, 'Recreation must pin the destination image ID');
	assert.deepEqual(destinationConfig.Env, snapshot.Config.Env);
	assert.equal(trackedImageReference(destinationConfig.Image, destinationConfig.Labels), image, 'Future updates must still follow the original tag');
	assert.equal(portableImageReference(destinationConfig.Image, destinationConfig.Labels), expectedReference);
}

if (phase === 'metadata-info-failure') {
	const { imageReleaseAgeStatus } = await import(root + 'minimum-release-age');
	await Promise.all([
		imageReleaseAgeStatus(image, digest, 72, async () => ({ platform: 'linux/amd64/', createdAt: new Date(Date.now() - 73 * 3600000).toISOString() }), 1),
		imageReleaseAgeStatus(image, digest, 72, async () => ({ platform: 'linux/arm64/', createdAt: new Date(Date.now() - 3600000).toISOString() }), 2)
	]);
	const mature = await docker.checkImageUpdateAvailable(image, old, 1);
	assert.equal(mature.hasUpdate, true, JSON.stringify(mature));
	assert.equal(mature.releaseAgeRemainingHours, undefined);
	assert.equal(await docker.verifyImageReleaseAge(image, 1), digest, 'Daemon info failure must not re-impose the cooldown');
	assert.equal(await docker.getImageReleaseAgeWarning(image, 1), null, 'Manual advisory must use the same durable platform');
	await assert.rejects(docker.verifyImageReleaseAge(image, 2), /cooldown/, 'A different platform must retain its own cooldown');
	await assert.rejects(docker.verifyImageReleaseAge(image, 3), /cooldown/, 'An unknown environment must not borrow the mature platform');
	assert.equal(calls.filter(call => call === 'GET /info').length, 5, 'Exercise actual daemon info failures in every age path');
	assert.equal(pullReferences.length, 0);
} else if (phase === 'blocked-registry') {
	for (const reference of ['localhost:5000/app:latest', '127.0.0.1:5000/app:latest', '169.254.169.254/app:latest']) {
		const result = await docker.getRegistryManifestDigestDetailed(reference, 1);
		assert.equal(result.digest, null);
		assert.ok(result.reason, 'Blocked registry must retain upstream diagnostics');
	}
	assert.equal(calls.length, 0, 'Blocked registry must not be sent to the daemon or queried directly');
} else if (phase === 'portable-legacy' || phase === 'portable-hub') {
	await assertPortableRoundTrip(image.split(':')[0] + '@' + old);
	assert.equal(portableImageReference(current.Config.Image, current.Config.Labels), old, 'Capture must not mutate the live configuration');
} else if (phase === 'portable-unavailable') {
	assert.deepEqual(await docker.getPortableContainerConfig(current.Config, 1), current.Config);
	assert.equal(pullReferences.length, 0, 'Do not replace an unavailable immutable image with the current tag');
} else if (phase.startsWith('timeout-')) {
	const progress: any[] = [];
	await docker.pullImage(image, (data: any) => progress.push(data), 1);
	assert.equal(stalledSignal?.aborted, true);
	assert.ok(progress.some(p => p.status === 'warning' && p.message.includes('could not be determined')));
	assert.equal(pullReferences.length, 1, 'An advisory timeout must still pull');
} else if (phase.startsWith('check-')) {
	const youngResult = await docker.checkImageUpdateAvailable(image, old, 1);
	assert.equal(youngResult.hasUpdate, false, JSON.stringify(youngResult));
	assert.equal(youngResult.releaseAgeRemainingHours, 2, 'Both digest branches must expose rounded remaining cooldown');
	assert.equal(youngResult.registryDigest, digest);
	assert.equal(youngResult.error, undefined);
	assert.equal(ageChecks, 1);
	remainingMs = 0;
	const matureResult = await docker.checkImageUpdateAvailable(image, old, 1);
	assert.equal(matureResult.hasUpdate, true, JSON.stringify(matureResult));
	assert.equal(matureResult.releaseAgeRemainingHours, undefined);
	assert.equal(ageChecks, 2, 'Mature re-check must run the same age gate');
	assert.equal(pullReferences.length, 0, 'Checking only must not pull');
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
	if (deferred) {
		assert.equal(ageChecks, 1, 'Scheduler must reach the actual age deferral gate');
		assert.equal(pullReferences.length, 0, 'Young images must be deferred before moving any tag');
		assert.equal(createBody, undefined);
		assert.ok(logs.some(line => line.includes('2 hour(s) remain')), JSON.stringify(logs));
		if (phase.startsWith('env')) {
			// A held update is persisted so the UI can show it as waiting across a
			// reload, with hasImageUpdate false so no bulk update ever offers it.
			assert.equal(pendingUpdates.length, 1, 'A held update must be surfaced as waiting');
			const options = pendingUpdates[0][4];
			assert.equal(options.hasImageUpdate, false, 'A held update must not be offered for a bulk update');
			assert.equal(options.releaseAgeRemainingHours, 2);
		} else {
			assert.equal(pendingUpdates.length, 0);
		}
	} else if (systemdFailure) {
		assert.equal(ageChecks, 2);
		assert.equal(createBody, undefined, 'Systemd owns both recreation and rollback');
		assert.equal(lastUpdated, 0, 'An unverified replacement must not be marked as updated');
		assert.equal(removedPending, 0, 'A failed update must remain pending');
		assert.ok(!executions.some(e => e.status === 'success'), JSON.stringify(executions));
		assert.ok(executions.some(e => e.status === 'failed'), JSON.stringify(executions));
		if (scanning) assert.deepEqual(scans, [approved]);
		if (phase.includes('preflight')) {
			assert.equal(current.Id, originalId, 'Preflight must leave the original container running');
			assert.equal(current.Image, old);
			assert.ok(!calls.some(call => call.endsWith('/stop')), 'Tag mismatch must be detected before stopping');
			assert.ok(logs.some(line => line.includes('changed before the systemd restart')), JSON.stringify(logs));
		} else {
			assert.equal(replacementInspections, 1, 'Inspect the replacement instead of trusting its name and running state');
			assert.equal(current.Id, rollbackId, 'A failed verification must attempt a rollback');
			assert.ok(calls.includes('GET /containers/' + rollbackId + '/json'), 'Verify the rollback image too');
			if (phase.includes('rollback-failure')) {
				assert.equal(current.Image, young);
				assert.ok(logs.some(line => line.includes('Rollback failed:')), JSON.stringify(logs));
				assert.equal(calls.filter(call => call.endsWith('/stop')).length, 2, 'Rollback must not retry indefinitely');
			} else {
				assert.equal(current.Image, old, 'The unapproved replacement must be replaced with the previous image');
				assert.ok(logs.some(line => line.includes('The previous image was restored')), JSON.stringify(logs));
			}
		}
	} else if (systemd) {
		assert.equal(ageChecks, 2, 'Mature systemd images must pass both check and pull gates');
		assert.deepEqual(pullReferences, [image.split(':')[0] + '@' + digest]);
		assert.ok(calls.includes('POST /containers/' + originalId + '/stop'));
		assert.equal(current.Id, createdId, 'The systemd respawn must complete');
		assert.equal(current.Image, approved);
		assert.ok(replacementInspections > 0, 'Verify the image systemd actually started');
		if (scanning) assert.deepEqual(scans, [approved], 'Quadlet must scan the same approved image selected for respawn');
		assert.equal(createBody, undefined, 'Systemd owns recreation');
		assert.ok(executions.some(e => e.status === 'success'), JSON.stringify(executions));
		if (phase.startsWith('env')) assert.equal(pendingUpdates.length, 1, 'Mature update must be surfaced to the environment UI');
	} else {
		assert.ok(createBody, JSON.stringify(executions));
		assert.equal(createBody.Image, phase.includes('disabled') ? image : approved, 'Recreation must use the verified image despite tag movement');
		assert.equal(createBody.Env[0], phase.includes('disabled') ? 'VERSION=other' : 'VERSION=approved', 'Rebase must use the verified image too');
		assert.equal(trackedImageReference(createBody.Image, createBody.Labels), image, 'Future update checks retain the source tag');
		assert.equal(pullReferences[0], phase.includes('disabled') ? image.split(':')[0] : image.split(':')[0] + '@' + digest);
		if (!phase.includes('disabled')) assert.equal(portableImageReference(createBody.Image, createBody.Labels), image.split(':')[0] + '@' + digest);
		if (scanning) assert.deepEqual(scans, [approved], 'Scan the same image that will be created');
		assert.ok(executions.some(e => e.status === 'success'), JSON.stringify(executions));
		if (phase.includes('portable')) await assertPortableRoundTrip(image.split(':')[0] + '@' + digest);
	}
}
if (phase.includes('disabled')) assert.ok(!calls.some(call => call.startsWith('GET /distribution/')), 'Disabled cooldown must retain the direct registry check without an extra daemon round trip');
metadataDatabase?.close();
process.exit(0);
