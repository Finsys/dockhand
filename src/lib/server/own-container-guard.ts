import { json } from '@sveltejs/kit';
import { inspectContainer } from './docker';
import { getOwnContainerId } from './host-path';
import { targetsOwnContainer } from './own-container-core';

/**
 * Refuse an act on the container Dockhand itself runs in, or null to allow it. Dockhand's
 * container holds its database, encryption key and Docker socket, so it is administrator
 * territory: exec, file access and network changes there are refused to everyone else.
 *
 * Docker accepts a container NAME wherever it accepts an id, so the reference is
 * resolved to an id before it is compared: a name can also be reassigned between the
 * check and the act it guards, which an id cannot.
 *
 * An inspect that fails means the reference names nothing this daemon knows, so the
 * act would fail anyway - it is let through to fail on its own terms rather than
 * being reported as a permission problem.
 */
export async function refuseOwnContainer(
	containerRef: string,
	envId?: number
): Promise<Response | null> {
	if (!(await isOwnContainer(containerRef, envId))) return null;
	return json({ error: 'Only an administrator can act on the Dockhand container' }, { status: 403 });
}

/** Whether the reference resolves to the container Dockhand itself runs in. */
export async function isOwnContainer(containerRef: string, envId?: number): Promise<boolean> {
	const ownId = getOwnContainerId();
	if (!ownId) return false;

	let resolvedId: string | null = null;
	try {
		resolvedId = (await inspectContainer(containerRef, envId))?.Id ?? null;
	} catch {
		return false;
	}
	return targetsOwnContainer(resolvedId, { id: ownId });
}
