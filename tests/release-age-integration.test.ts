import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseAgeAdvisory } from '../src/lib/server/release-age-advisory';
import { trackedImageLabels, trackedImageReference } from '../src/lib/utils/tracked-image';
import { collectPullWarning, pullLogStatus } from '../src/lib/utils/pull-warning';

for (const phase of ['container', 'container-scan', 'env', 'env-scan', 'container-systemd', 'env-systemd', 'container-disabled', 'env-disabled', 'timeout-daemon', 'timeout-auth', 'timeout-head', 'young', 'warning-json', 'warning-stream']) {
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
