/**
 * Build the ValidateContext for a target environment: the live facts the
 * context-aware rules need (host ports already in use, existing networks/volumes,
 * container names). Thin async wrapper over the docker.ts list functions; the pure
 * assembly lives in context-core.ts so it stays unit-testable without docker.ts.
 */

import { listContainers, listNetworks, listVolumes } from '../docker';
import { deriveContextFromLists } from './context-core';
import type { ValidateContext } from './types';

export { deriveContextFromLists } from './context-core';

/**
 * Fetch the live context for `envId`. Degrades to an empty-ish context if the env
 * can't be reached, so a validate never fails just because the daemon is momentarily
 * down (context-aware rules simply produce nothing).
 */
export async function buildValidateContext(
	envId: number | null | undefined,
	selfStackName?: string | null
): Promise<ValidateContext> {
	const [containers, networks, volumes] = await Promise.all([
		listContainers(true, envId).catch(() => []),
		listNetworks(envId).catch(() => []),
		listVolumes(envId).catch(() => [])
	]);
	return deriveContextFromLists(
		containers,
		networks.map((n) => n.name),
		volumes.map((v) => v.name),
		selfStackName
	);
}
