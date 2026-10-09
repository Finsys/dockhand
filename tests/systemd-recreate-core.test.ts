// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import {
	classifyRespawn,
	isExactNameMatch,
	decideRespawnOutcome,
	isSystemdManagedUnit
} from '../src/lib/server/systemd-recreate-core';

describe('classifyRespawn (Quadlet/systemd recreate detection)', () => {
	const OLD = 'old111';

	test('a new id that is running is a successful respawn', () => {
		expect(classifyRespawn({ Id: 'new222', State: 'running' }, OLD)).toBe('respawned-running');
	});

	test('a new id that is not running is respawned-not-running (crash-loop / settling)', () => {
		expect(classifyRespawn({ Id: 'new222', State: 'created' }, OLD)).toBe('respawned-not-running');
		expect(classifyRespawn({ Id: 'new222', State: 'restarting' }, OLD)).toBe('respawned-not-running');
		expect(classifyRespawn({ Id: 'new222', State: 'exited' }, OLD)).toBe('respawned-not-running');
	});

	test('the same id as the stopped container means keep waiting', () => {
		expect(classifyRespawn({ Id: OLD, State: 'running' }, OLD)).toBe('old-still-there');
		expect(classifyRespawn({ Id: OLD, State: 'exited' }, OLD)).toBe('old-still-there');
	});

	test('nothing found means keep waiting (systemd removed it, not yet respawned)', () => {
		expect(classifyRespawn(null, OLD)).toBe('gone');
	});
});

describe('decideRespawnOutcome (poll loop: continue / succeed / fail)', () => {
	const OLD = 'old111';

	test('a running new-id container succeeds immediately, even before the deadline', () => {
		expect(decideRespawnOutcome({ Id: 'new222', State: 'running' }, OLD, false)).toEqual({
			done: true,
			ok: true,
			id: 'new222'
		});
	});

	test('before the deadline, a non-running / absent / old container keeps polling', () => {
		expect(decideRespawnOutcome({ Id: 'new222', State: 'created' }, OLD, false)).toEqual({ done: false });
		expect(decideRespawnOutcome({ Id: OLD, State: 'running' }, OLD, false)).toEqual({ done: false });
		expect(decideRespawnOutcome(null, OLD, false)).toEqual({ done: false });
	});

	test('at the deadline, a crash-looping new container is a FAILURE, not a false success', () => {
		// a broken new image (crash-loop) must never be reported as a successful update
		expect(decideRespawnOutcome({ Id: 'new222', State: 'restarting' }, OLD, true)).toEqual({
			done: true,
			ok: false
		});
		expect(decideRespawnOutcome({ Id: 'new222', State: 'exited' }, OLD, true)).toEqual({
			done: true,
			ok: false
		});
	});

	test('at the deadline, nothing respawned is a failure', () => {
		expect(decideRespawnOutcome(null, OLD, true)).toEqual({ done: true, ok: false });
	});

	test('at the deadline, a genuinely running new container still succeeds', () => {
		expect(decideRespawnOutcome({ Id: 'new222', State: 'running' }, OLD, true)).toEqual({
			done: true,
			ok: true,
			id: 'new222'
		});
	});
});

describe('isExactNameMatch', () => {
	test('matches the exact name, tolerating a leading slash', () => {
		expect(isExactNameMatch(['/immich-server'], 'immich-server')).toBe(true);
		expect(isExactNameMatch(['immich-server'], 'immich-server')).toBe(true);
	});

	test('matches when the exact name is not the first of several names', () => {
		expect(isExactNameMatch(['/other', '/immich-server'], 'immich-server')).toBe(true);
	});

	test('does not match a name that merely contains the target (regex-contains guard)', () => {
		expect(isExactNameMatch(['/immich-server-old'], 'immich-server')).toBe(false);
		expect(isExactNameMatch(['/my-immich-server'], 'immich-server')).toBe(false);
		expect(isExactNameMatch(['/immich-server-old', '/immich-server-old2'], 'immich-server')).toBe(false);
	});

	test('handles missing/empty names', () => {
		expect(isExactNameMatch(undefined, 'x')).toBe(false);
		expect(isExactNameMatch([], 'x')).toBe(false);
	});
});

/**
 * Which containers the systemd handover applies to.
 *
 * Measured on podman 5.4.2 + podman-compose 1.3.0: podman-compose stamps
 * PODMAN_SYSTEMD_UNIT=podman-compose@<project>.service on every container while
 * installing no such unit, and a stopped container stays Exited(137) - nothing
 * respawns it. Treating that as systemd-managed stops the container and waits for a
 * restart that never comes, leaving it DOWN after a "successful" pull.
 */
describe('isSystemdManagedUnit', () => {
	const quadlet = { PODMAN_SYSTEMD_UNIT: 'radicale.service' };
	// The real label set from the reproduction, trimmed to what matters.
	const podmanCompose = {
		PODMAN_SYSTEMD_UNIT: 'podman-compose@pc-repro.service',
		'com.docker.compose.project': 'pc-repro',
		'io.podman.compose.project': 'pc-repro',
		'io.podman.compose.version': '1.3.0',
		'io.podman.compose.config-hash': '0f6e21'
	};

	test('a Quadlet unit owns the lifecycle', () => {
		expect(isSystemdManagedUnit('radicale.service', quadlet)).toBe(true);
	});

	test('a podman-compose container does not, however the unit is named', () => {
		expect(isSystemdManagedUnit('podman-compose@pc-repro.service', podmanCompose)).toBe(false);
	});

	test('no label means no handover', () => {
		expect(isSystemdManagedUnit(undefined, {})).toBe(false);
		expect(isSystemdManagedUnit('', {})).toBe(false);
		expect(isSystemdManagedUnit(undefined, undefined)).toBe(false);
	});

	// The decision is made on podman-compose's own labels, not on the unit name: a
	// Quadlet project a user happens to call "podman-compose" still gets the handover.
	test('a Quadlet unit merely named like podman-compose still owns the lifecycle', () => {
		expect(
			isSystemdManagedUnit('podman-compose@thing.service', {
				PODMAN_SYSTEMD_UNIT: 'podman-compose@thing.service'
			})
		).toBe(true);
	});

	// docker compose labels alone are not the signal - a Quadlet unit can run a compose
	// project, and podman-compose is identified by its io.podman.compose.* labels.
	test('docker compose labels alone do not disqualify a unit', () => {
		expect(
			isSystemdManagedUnit('radicale.service', {
				PODMAN_SYSTEMD_UNIT: 'radicale.service',
				'com.docker.compose.project': 'radicale',
				'com.docker.compose.service': 'radicale'
			})
		).toBe(true);
	});

	test('any io.podman.compose label is enough to recognise podman-compose', () => {
		expect(
			isSystemdManagedUnit('podman-compose@x.service', {
				PODMAN_SYSTEMD_UNIT: 'podman-compose@x.service',
				'io.podman.compose.version': '1.0.6'
			})
		).toBe(false);
	});
});
