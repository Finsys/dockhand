import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseAgeAdvisory } from '../src/lib/server/release-age-advisory';
import { portableImageReference, trackedImageLabels, trackedImageReference, UPDATE_SOURCE_LABEL } from '../src/lib/utils/tracked-image';
import { collectPullWarning, pullLogStatus } from '../src/lib/utils/pull-warning';

for (const phase of ['metadata-info-failure', 'blocked-registry', 'container', 'container-scan', 'env', 'env-scan', 'container-systemd', 'env-systemd', 'container-systemd-scan', 'env-systemd-scan', 'container-systemd-race', 'env-systemd-race', 'container-systemd-race-scan', 'env-systemd-race-scan', 'container-systemd-inspect-failure', 'env-systemd-inspect-failure', 'container-systemd-preflight', 'env-systemd-preflight', 'container-systemd-race-rollback-failure', 'env-systemd-race-rollback-failure', 'container-young', 'env-young', 'container-systemd-young', 'env-systemd-young', 'check-young-empty', 'check-young-mismatch', 'container-disabled', 'env-disabled', 'timeout-daemon', 'timeout-auth', 'timeout-head', 'young', 'warning-json', 'warning-stream', 'container-portable', 'container-scan-portable', 'env-portable', 'env-scan-portable', 'portable-legacy', 'portable-hub', 'portable-unavailable']) {
	test(`release age integration: ${phase}`, () => {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/release-age-integration-probe.ts', import.meta.url)), phase], {
			cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10000
		});
		expect({ status: result.status, error: result.error?.message, output: result.status === 0 ? '' : result.stdout + result.stderr }).toEqual({ status: 0, error: undefined, output: '' });
	});
}

test('whole advisory deadline bounds storage or I/O that ignores abort', async () => {
	let signal: AbortSignal | undefined;
	await expect(releaseAgeAdvisory(async s => { signal = s; return new Promise(() => {}); }, 10)).rejects.toThrow('timed out');
	expect(signal?.aborted).toBe(true);
	expect(await releaseAgeAdvisory(async () => 'ready', 1000)).toBe('ready');
});

test('tracking metadata does not override an explicit image change or digest pin', () => {
	const id = 'sha256:' + 'a'.repeat(64);
	const labels = trackedImageLabels({ custom: 'kept' }, 'nginx:latest', id);
	expect(labels.custom).toBe('kept');
	expect(trackedImageReference(id, labels)).toBe('nginx:latest');
	for (const reference of ['nginx:stable', 'nginx@' + id, 'sha256:' + 'b'.repeat(64)]) {
		expect(trackedImageReference(reference, labels)).toBe(reference);
	}
	expect(trackedImageReference(id, { 'dockhand.update.source': 'bad json' })).toBe(id);
});

test('structured warnings retain their explanation in pull logs', () => {
	const warnings: { status: 'warning'; message: string }[] = [];
	collectPullWarning(warnings, { status: 'warning', message: 'Too young; pulling anyway' });
	collectPullWarning(warnings, { status: 'Downloading', id: 'layer' });
	expect(warnings).toEqual([{ status: 'warning', message: 'Too young; pulling anyway' }]);
	expect(pullLogStatus(warnings[0])).toBe('[warning] Too young; pulling anyway');
	expect(pullLogStatus({ status: 'Downloading' })).toBe('Downloading');
});

test('portable references ignore stale tracking and reject malformed or unrelated digests', () => {
	const id = 'sha256:' + 'a'.repeat(64);
	const digest = 'sha256:' + 'b'.repeat(64);
	for (const reference of ['nginx:latest', 'registry.example.com:5000/team/app']) {
		const repo = reference === 'nginx:latest' ? 'nginx' : reference;
		const pinned = repo + '@' + digest;
		const labels = trackedImageLabels({ custom: 'kept' }, reference, id, pinned);
		expect(portableImageReference(id, labels)).toBe(pinned);
		expect(trackedImageReference(id, labels)).toBe(reference);
		for (const image of ['other:latest', 'nginx@' + digest, 'sha256:' + 'c'.repeat(64)]) {
			expect(portableImageReference(image, labels)).toBe(image);
		}
		for (const registryReference of ['other@' + digest, repo + '@invalid', repo + '@' + digest + '/extra']) {
			expect(() => trackedImageLabels({}, reference, id, registryReference)).toThrow('Invalid verified registry reference');
			expect(portableImageReference(id, { [UPDATE_SOURCE_LABEL]: JSON.stringify({ reference, imageId: id, registryReference }) })).toBe(id);
		}
	}
	expect(portableImageReference(id, { [UPDATE_SOURCE_LABEL]: 'bad json' })).toBe(id);
});
