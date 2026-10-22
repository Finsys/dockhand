import { json } from '@sveltejs/kit';
import { inspectContainer } from './docker';
import { getOwnContainerId } from './host-path';
import { targetsOwnContainer } from './own-container-core';

/**
 * Refuse an act on the container Dockhand itself runs in, or null to allow it.
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
	const ownId = getOwnContainerId();
	if (!ownId) return null;

	let resolvedId: string | null = null;
	try {
		resolvedId = (await inspectContainer(containerRef, envId))?.Id ?? null;
	} catch {
		return null;
	}

	if (!targetsOwnContainer(resolvedId, { id: ownId })) return null;
	return json(
		{ error: 'Only an administrator can change the networks of the Dockhand container' },
		{ status: 403 }
	);
}
