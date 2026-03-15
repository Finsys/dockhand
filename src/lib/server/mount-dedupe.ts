type HostConfigLike = {
	Binds?: string[] | null;
	Mounts?: Array<{ Target?: string | null }> | null;
};

type InspectMountLike = {
	Type?: string | null;
	Name?: string | null;
	Destination?: string | null;
};

/** Build extra bind strings for volume mounts missing from HostConfig. */
export function getAdditionalVolumeBinds(
	hostConfig: HostConfigLike,
	mounts: InspectMountLike[]
): string[] {
	const existingMountTargets = new Set((hostConfig.Binds || []).map((bind: string) => {
		const parts = bind.split(':');
		return parts.length >= 2 ? parts[1] : parts[0];
	}));

	for (const mount of hostConfig.Mounts || []) {
		if (mount?.Target) existingMountTargets.add(mount.Target);
	}

	const additionalBinds: string[] = [];
	for (const mount of mounts || []) {
		if (mount.Type === 'volume' && mount.Name && mount.Destination) {
			if (!existingMountTargets.has(mount.Destination)) {
				additionalBinds.push(`${mount.Name}:${mount.Destination}`);
			}
		}
	}

	return additionalBinds;
}
