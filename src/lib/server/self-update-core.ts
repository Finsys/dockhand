/**
 * Pure config-building for self-update, with no heavy imports (no db/docker/SvelteKit)
 * so it is unit-testable: a test pins that self-update's create config carries the Podman
 * HostConfig fixups, which every create-from-inspect path must apply.
 */
import { getAdditionalVolumeBinds, dedupeVolumesForRecreate } from './mount-dedupe';
import {
	stripDefaultMemorySwappiness,
	resolveNanoCpusConflict,
	applyPodmanUsernsMode
} from './hostconfig-recreate';

/**
 * Build the new container's create config from the running container's inspect data.
 * Does NOT include NetworkingConfig: applySelfUpdateNetworks adds the primary network
 * when it pins an IP, and the sidecar connects the rest.
 */
export function buildSelfUpdateCreateConfig(inspectData: any, newImage: string): any {
	const config = inspectData.Config || {};
	const hostConfig = inspectData.HostConfig || {};

	const createConfig: any = {
		...config,
		Image: newImage,
		HostConfig: { ...hostConfig }
	};

	// Clear MacAddress for Docker API < 1.44 compatibility
	delete createConfig.MacAddress;

	// Clear Entrypoint and Cmd so the new image's defaults are used.
	// This prevents carrying over a stale entrypoint from a previous runtime
	// (e.g. Bun's docker-entrypoint.sh -> Node.js docker-entrypoint-node.sh).
	delete createConfig.Entrypoint;
	delete createConfig.Cmd;

	// Clear Hostname so Docker assigns the new container's own ID
	// Otherwise the old container's hostname is inherited, breaking self-identification
	delete createConfig.Hostname;

	// Podman inspect-vs-create fixups - the same ones recreateContainerFromInspect
	// applies. Without them self-update creates a container that Podman cannot start:
	// a default MemorySwappiness crun rejects on cgroup v2, the NanoCpus/period-quota
	// conflict, and the lowered keep-id userns.
	stripDefaultMemorySwappiness(createConfig.HostConfig);
	resolveNanoCpusConflict(createConfig.HostConfig);
	applyPodmanUsernsMode(createConfig.HostConfig, config.Annotations);

	const additionalBinds = getAdditionalVolumeBinds(hostConfig, inspectData.Mounts || []);
	// Drop image-VOLUME entries that collide with a bind/tmpfs/inspect mount, so create never
	// sends a duplicate mount point.
	const kept = dedupeVolumesForRecreate(createConfig.Volumes, hostConfig, inspectData.Mounts || [], additionalBinds);
	if (kept) createConfig.Volumes = kept;
	else delete createConfig.Volumes;
	if (additionalBinds.length > 0) {
		createConfig.HostConfig = {
			...createConfig.HostConfig,
			Binds: [...(createConfig.HostConfig.Binds || []), ...additionalBinds]
		};
	}

	return createConfig;
}
