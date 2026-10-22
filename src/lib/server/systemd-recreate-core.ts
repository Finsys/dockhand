// Pure decision helpers for recreating a Podman Quadlet / systemd-managed container.
// Import-light (no docker/db) so the respawn-detection logic is unit-testable without a
// live Podman socket.

/**
 * Whether a `PODMAN_SYSTEMD_UNIT` label really means systemd owns the lifecycle.
 *
 * Quadlet sets the label for a unit that exists, whose ExecStop removes the container
 * and whose Restart= brings a fresh one back - the handover the systemd recreate path
 * relies on. podman-compose sets the SAME label unconditionally, naming a
 * `podman-compose@<project>.service` template that it never installs: nothing removes
 * the container and nothing respawns it, so handing the recreate to systemd stops the
 * container and then waits for a restart that cannot come.
 *
 * podman-compose stamps its own `io.podman.compose.*` labels alongside, which Quadlet
 * does not, so the two are told apart by those rather than by the unit name - a project
 * legitimately called "podman-compose" would otherwise be misread.
 *
 * The `io.podman.compose.*` labels stay the right signal even when podman-compose is
 * itself launched from a systemd unit: measured on podman 5.4.2, such a container gets
 * `RestartPolicy=no` and stays Exited(137) under its original id after a stop, so there
 * is no respawn to wait for and the normal recreate is what has to run.
 */
export function isSystemdManagedUnit(
	unit: string | undefined,
	labels: Record<string, string> | undefined
): boolean {
	if (!unit) return false;
	const keys = Object.keys(labels || {});
	if (keys.some((k) => k.startsWith('io.podman.compose.'))) return false;
	return true;
}

export interface FoundContainer {
	Id: string;
	State: string;
}

/**
 * Classify what a name-lookup found while polling for the unit to respawn the container
 * after a stop. `oldId` is the container we stopped.
 * - 'respawned-running': a NEW id, running -> the recreate succeeded (fresh container
 *   from the unit's `podman run --replace` on the new image).
 * - 'respawned-not-running': a NEW id, not yet/no longer running (created/exited/
 *   restarting) -> respawned but not healthy; keep polling, and on timeout this is a
 *   FAILURE (a crash-loop on the new image must not be reported as success).
 * - 'old-still-there': the id we stopped is still the one under this name -> keep polling.
 * - 'gone': nothing under this name yet -> keep polling.
 */
export function classifyRespawn(
	found: FoundContainer | null,
	oldId: string
): 'respawned-running' | 'respawned-not-running' | 'old-still-there' | 'gone' {
	if (!found) return 'gone';
	if (found.Id === oldId) return 'old-still-there';
	return found.State === 'running' ? 'respawned-running' : 'respawned-not-running';
}

/** Exact-name match filter for a container-list `name` filter (Podman/Docker treat it as regex-contains). */
export function isExactNameMatch(names: string[] | undefined, name: string): boolean {
	return (names || []).some((n) => n.replace(/^\//, '') === name);
}

export type RespawnOutcome =
	| { done: true; ok: true; id: string } // a new container is running -> success
	| { done: false } // keep polling
	| { done: true; ok: false }; // deadline reached without a running new container

/**
 * Decide, from one poll observation, whether to finish or keep polling. Pure so the
 * timeout/success/failure branches are unit-testable without a live socket.
 *
 * A running new-id container is an immediate success. Otherwise we keep polling until the
 * deadline; once reached, we only succeed if the CURRENT observation is a running new-id
 * container - a container that merely appeared but never reached running (crash-loop on a
 * broken new image) is a FAILURE, never a false success.
 */
export function decideRespawnOutcome(
	found: FoundContainer | null,
	oldId: string,
	deadlineReached: boolean
): RespawnOutcome {
	const state = classifyRespawn(found, oldId);
	if (state === 'respawned-running') return { done: true, ok: true, id: found!.Id };
	if (!deadlineReached) return { done: false };
	return { done: true, ok: false };
}
