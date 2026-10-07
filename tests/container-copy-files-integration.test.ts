import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const phase of [
	'recreate-userns', 'recreate-userns-edge', 'edit-userns', 'recreate-userns-empty-failure',
	'recreate-userns-old-engine-failure', 'edit-userns-clear-user-failure', 'edit-userns-host-mode-failure',
	'recreate', 'recreate-stopped', 'recreate-missing', 'recreate-copy-failure',
	'recreate-create-failure', 'recreate-start-failure', 'recreate-edge', 'recreate-edge-copy-failure',
	'recreate-compose', 'recreate-compose-missing', 'recreate-compose-unreadable', 'recreate-compose-edge', 'edit-labels-compose',
	'edit', 'edit-stopped', 'edit-missing', 'edit-copy-failure', 'edit-start-failure', 'edit-remove-label', 'edit-mounts', 'edit-mounts-override'
]) {
	test(`copy-file recreation: ${phase}`, () => {
		// Isolate module mocks from the suite's database and Docker clients.
		const result = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/container-copy-files-probe.ts', import.meta.url)), phase], {
			cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10000
		});
		expect({ status: result.status, error: result.error?.message, output: result.status === 0 ? '' : result.stdout + result.stderr })
			.toEqual({ status: 0, error: undefined, output: '' });
	});
}
