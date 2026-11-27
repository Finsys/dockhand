import { describe, it, expect } from 'bun:test';
import { isDynamicallySpawnedOrphan, shouldCleanupStackContainer } from '../src/lib/server/stack-orphan-core';

describe('isDynamicallySpawnedOrphan', () => {
	it('treats a compose service (has com.docker.compose.service) as NOT an orphan', () => {
		// The regression: a recreate used to restart these too, killing a
		// network_mode: service:X dependent mid-startup (exit 137).
		expect(isDynamicallySpawnedOrphan({
			'com.docker.compose.project': 'media',
			'com.docker.compose.service': 'gluetun'
		})).toBe(false);
		expect(isDynamicallySpawnedOrphan({
			'com.docker.compose.project': 'media',
			'com.docker.compose.service': 'jellyfin',
			'com.docker.compose.container-number': '1'
		})).toBe(false);
	});

	it('treats a dynamically-spawned child (project label, NO service label) as an orphan', () => {
		// e.g. a nextcloud-aio master spawns workers via the Docker API: they carry the
		// project label so they group with the stack, but compose never defined them.
		expect(isDynamicallySpawnedOrphan({
			'com.docker.compose.project': 'nextcloud-aio'
		})).toBe(true);
	});

	it('is an orphan when there are no labels at all', () => {
		expect(isDynamicallySpawnedOrphan({})).toBe(true);
		expect(isDynamicallySpawnedOrphan(undefined)).toBe(true);
		expect(isDynamicallySpawnedOrphan(null)).toBe(true);
	});

	it('an empty service label does not count as a compose service', () => {
		// defensive: a blank value must not be read as "this is a compose service".
		expect(isDynamicallySpawnedOrphan({ 'com.docker.compose.service': '' })).toBe(true);
	});
});

describe('shouldCleanupStackContainer (the cleanupOrphanStackContainers decision)', () => {
	const service = { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'gluetun' };
	const orphan = { 'com.docker.compose.project': 'media' };

	it('restart acts ONLY on orphans, never on a compose service (#1873)', () => {
		// The exact regression: restarting a compose service after a recreate kills a
		// network_mode: service:X dependent mid-startup (exit 137).
		expect(shouldCleanupStackContainer('restart', 'running', service)).toBe(false);
		expect(shouldCleanupStackContainer('restart', 'running', orphan)).toBe(true);
	});

	it('stop and remove sweep every running container (teardown safety net)', () => {
		// A failed/partial compose down can leave services running; the forced teardown
		// must still clean them up. These paths never restart, so no mid-startup concern.
		for (const op of ['stop', 'remove'] as const) {
			expect(shouldCleanupStackContainer(op, 'running', service)).toBe(true);
			expect(shouldCleanupStackContainer(op, 'running', orphan)).toBe(true);
			expect(shouldCleanupStackContainer(op, 'restarting', service)).toBe(true);
		}
	});

	it('never acts on a container that is not running or restarting', () => {
		for (const op of ['stop', 'remove', 'restart'] as const) {
			expect(shouldCleanupStackContainer(op, 'exited', service)).toBe(false);
			expect(shouldCleanupStackContainer(op, 'created', orphan)).toBe(false);
		}
	});
});
