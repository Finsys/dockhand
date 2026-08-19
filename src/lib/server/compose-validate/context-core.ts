/**
 * Pure context assembly - NO docker.ts import (which pulls better-sqlite3 and can't
 * load under the bun unit runner). buildValidateContext (context.ts) fetches the live
 * lists and calls this; unit tests import only this file.
 */

import type { ValidateContext } from './types';

/** Minimal shapes the pure builder needs (subset of docker.ts types). */
export interface CtxContainer {
	name: string;
	ports?: Array<{ PublicPort?: number }>;
	labels?: Record<string, string>;
}

/**
 * Given the env's containers/networks/volumes, produce the ValidateContext. Excludes
 * THIS stack's own containers so a re-deploy isn't flagged as a self-collision. Match on
 * the compose project LABEL first (authoritative - Docker stamps it on every compose
 * container regardless of a custom container_name), then fall back to the default
 * `<project>-<svc>-<n>` name prefix for containers that lack the label.
 */
export function deriveContextFromLists(
	containers: CtxContainer[],
	networkNames: string[],
	volumeNames: string[],
	selfStackName?: string | null
): ValidateContext {
	const usedHostPorts = new Set<number>();
	const hostPortOwners = new Map<number, string>();
	const existingContainerNames = new Set<string>();
	for (const c of containers) {
		const isSelf =
			!!selfStackName &&
			(c.labels?.['com.docker.compose.project'] === selfStackName ||
				c.name.startsWith(`${selfStackName}-`));
		if (isSelf) continue;
		existingContainerNames.add(c.name);
		for (const p of c.ports || []) {
			if (typeof p.PublicPort === 'number' && p.PublicPort > 0) {
				usedHostPorts.add(p.PublicPort);
				// First writer wins; a port maps to one publishing container.
				if (!hostPortOwners.has(p.PublicPort)) hostPortOwners.set(p.PublicPort, c.name);
			}
		}
	}
	return {
		selfStackName: selfStackName ?? undefined,
		usedHostPorts,
		hostPortOwners,
		existingContainerNames,
		existingNetworks: new Set(networkNames.filter(Boolean)),
		existingVolumes: new Set(volumeNames.filter(Boolean))
	};
}
