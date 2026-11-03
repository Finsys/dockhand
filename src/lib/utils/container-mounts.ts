export interface StructuredMount {
	Type: string;
	Source?: string;
	Target: string;
	ReadOnly?: boolean;
	[key: string]: unknown;
}

interface InspectMount {
	Type?: string;
	Name?: string;
	Source?: string;
	Destination?: string;
	Mode?: string;
	RW?: boolean;
}

interface MountInspect {
	HostConfig?: { Binds?: string[] | null; Mounts?: StructuredMount[] | null };
	Mounts?: InspectMount[] | null;
}

const target = (path: string) => path.replace(/\/+$/, '') || '/';
const bindTarget = (bind: string) => target(bind.split(':')[1] || bind.split(':')[0]);
const bindKey = (bind: string) => {
	const [source, destination, mode = 'rw'] = bind.split(':');
	return JSON.stringify([source, target(destination || source), mode.split(',').filter(m => m !== 'rw').sort()]);
};

/** Show every persistent mount, including --mount and anonymous volumes, in the editor. */
export function containerMountBindings(inspect: MountInspect): string[] {
	const binds = [...(inspect.HostConfig?.Binds || [])];
	const taken = new Set(binds.map(bindTarget));
	const actual = inspect.Mounts || [];
	const add = (source: string | undefined, destination: string | undefined, mode: string) => {
		if (!source || !destination || taken.has(target(destination))) return;
		binds.push(`${source}:${destination}:${mode}`);
		taken.add(target(destination));
	};
	for (const mount of inspect.HostConfig?.Mounts || []) {
		const runtime = actual.find(m => m.Destination && target(m.Destination) === target(mount.Target));
		const source = mount.Type === 'volume' ? runtime?.Name || mount.Source : mount.Type === 'bind' ? mount.Source : undefined;
		add(source, mount.Target, runtime?.Mode || (mount.ReadOnly ? 'ro' : 'rw'));
	}
	for (const mount of actual) {
		const source = mount.Type === 'volume' ? mount.Name : mount.Type === 'bind' ? mount.Source : undefined;
		add(source, mount.Destination, mount.Mode || (mount.RW === false ? 'ro' : 'rw'));
	}
	return binds;
}

/** Keep unchanged structured mounts intact so unrelated edits retain their full Docker options. */
export function containerMountOptions(inspect: MountInspect, requested?: string[] | null) {
	const current = containerMountBindings(inspect);
	// Older editors send null when their volume list is empty; only [] explicitly clears it.
	const binds = requested == null ? current : requested;
	const wanted = new Set(binds.map(bindKey));
	const byTarget = new Map(current.map(bind => [bindTarget(bind), bindKey(bind)]));
	const mounts = (inspect.HostConfig?.Mounts || []).filter(mount =>
		requested == null || !['bind', 'volume'].includes(mount.Type) || wanted.has(byTarget.get(target(mount.Target)) || '')
	).map(mount => {
		if (mount.Type !== 'volume' || mount.Source) return mount;
		const source = inspect.Mounts?.find(m => m.Destination && target(m.Destination) === target(mount.Target))?.Name;
		if (!source) throw new Error(`Cannot preserve anonymous volume at ${mount.Target}: volume name missing`);
		return { ...mount, Source: source };
	});
	const structuredTargets = new Set(mounts.map(mount => target(mount.Target)));
	return { volumeBinds: binds.filter(bind => !structuredTargets.has(bindTarget(bind))), mounts };
}
