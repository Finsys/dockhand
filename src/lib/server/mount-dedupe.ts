type HostConfigLike = {
	Tmpfs?: Record<string, string> | null;
	Binds?: string[] | null;
	Mounts?: Array<{ Target?: string | null }> | null;
};

type InspectMountLike = {
	Type?: string | null;
	Name?: string | null;
	Destination?: string | null;
};

/** Destination path of a bind string ("src:/dst:ro" -> "/dst", "/dst" -> "/dst"). */
function bindTarget(bind: string): string {
	const parts = bind.split(':');
	return parts.length >= 2 ? parts[1] : parts[0];
}

/**
 * Drop Config.Volumes entries whose path is already mounted, so recreate never sends a duplicate
 * mount point (#1088 / #1363). The path can be occupied by Tmpfs, an existing bind, a bind we're
 * ABOUT to add (getAdditionalVolumeBinds), or a volume that shows up only in inspect.Mounts (the
 * shape a remote/hawser daemon returns) - the earlier fix checked Tmpfs/Binds only, so a named
 * volume at an image-VOLUME path (e.g. cups /etc/cups) slipped through and collided with the bind
 * re-added from inspect.Mounts. Checking all four sources in one place closes that gap.
 */
export function dedupeVolumesForRecreate(
	volumes: Record<string, unknown> | undefined | null,
	hostConfig: HostConfigLike,
	mounts: InspectMountLike[],
	additionalBinds: string[]
): Record<string, unknown> | undefined {
	if (!volumes) return undefined;
	const mounted = new Set<string>();
	for (const p of Object.keys(hostConfig.Tmpfs || {})) mounted.add(p);
	for (const b of hostConfig.Binds || []) mounted.add(bindTarget(b));
	for (const b of additionalBinds) mounted.add(bindTarget(b));
	for (const m of hostConfig.Mounts || []) { if (m?.Target) mounted.add(m.Target); }
	for (const m of mounts || []) { if (m.Destination) mounted.add(m.Destination); }

	const kept: Record<string, unknown> = {};
	for (const [path, val] of Object.entries(volumes)) {
		if (!mounted.has(path)) kept[path] = val;
	}
	return Object.keys(kept).length > 0 ? kept : undefined;
}

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
