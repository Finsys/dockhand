// With the containerd image store a rebuild from cache gives the tag a new image (index) ID
// while a container that was not recreated keeps the old one, which no longer exists as an
// image. The platform manifest it runs is unchanged, so that is what still links the two.

export interface UsageImage {
	Id: string;
	RepoTags?: string[] | null;
	Created?: number;
	/** Present when the image list is requested with manifests=1 (API 1.47+). */
	Manifests?: { ID?: string }[] | null;
}

export interface UsageContainer {
	ImageID?: string;
	/** Present on API 1.48+ with the containerd image store. */
	ImageManifestDescriptor?: { digest?: string } | null;
}

/**
 * The images a container runs: its exact image ID, else every image holding the platform
 * manifest it was created from (several can, e.g. one Dockerfile built under two tags).
 */
export function containerImageResolver<T extends UsageImage>(images: T[]): (container: UsageContainer) => T[] {
	const byId = new Map<string, T>();
	const byManifest = new Map<string, T[]>();
	for (const image of images) {
		byId.set(image.Id, image);
		for (const manifest of image.Manifests ?? []) {
			if (!manifest.ID) continue;
			const holders = byManifest.get(manifest.ID);
			if (holders) holders.push(image);
			else byManifest.set(manifest.ID, [image]);
		}
	}
	return (container) => {
		const direct = container.ImageID ? byId.get(container.ImageID) : undefined;
		if (direct) return [direct];
		const digest = container.ImageManifestDescriptor?.digest;
		return (digest && byManifest.get(digest)) || [];
	};
}

/**
 * Whether resolving needs the image list with manifests: only a container that carries a
 * manifest descriptor and whose image ID is missing. Everywhere else the plain list is enough,
 * so engines without the containerd store never see the extra request.
 */
export function needsManifestLookup(images: UsageImage[], containers: UsageContainer[]): boolean {
	const ids = new Set(images.map((image) => image.Id));
	return containers.some((c) => !!c.ImageManifestDescriptor?.digest && !(c.ImageID && ids.has(c.ImageID)));
}

/**
 * How many containers use each image, keyed by image ID; a container matching no image counts
 * under its own image ID. loadManifests runs only when needsManifestLookup says so. With
 * strict a failed load throws (a prune must not treat an image in use as unused); otherwise
 * the plain list is used.
 */
export async function containersPerImage(
	images: UsageImage[],
	containers: (UsageContainer & { Image?: string })[],
	loadManifests: () => Promise<UsageImage[]>,
	strict: boolean
): Promise<Map<string, number>> {
	let listed = images;
	if (needsManifestLookup(images, containers)) {
		try {
			listed = await loadManifests();
		} catch (err) {
			if (strict) throw err;
		}
	}
	const imagesOf = containerImageResolver(listed);
	const counts = new Map<string, number>();
	for (const container of containers) {
		const holders = imagesOf(container).map((image) => image.Id);
		const fallback = container.ImageID || container.Image;
		for (const id of holders.length ? holders : fallback ? [fallback] : []) {
			counts.set(id, (counts.get(id) || 0) + 1);
		}
	}
	return counts;
}

/**
 * Names for containers whose displayed image is a bare sha256 ID: the tag of the newest image
 * holding the same content. Loads the manifest list only when such a container carries a
 * descriptor, and keeps the ID when the load fails.
 */
export async function containerImageNamer<C extends UsageContainer>(
	containers: C[],
	nameOf: (container: C) => string,
	loadManifests: () => Promise<UsageImage[]>
): Promise<(container: C) => string> {
	const bare = (c: C) => nameOf(c).startsWith('sha256:');
	if (!containers.some((c) => bare(c) && c.ImageManifestDescriptor?.digest)) return nameOf;
	let imagesOf: (container: UsageContainer) => UsageImage[];
	try {
		imagesOf = containerImageResolver(await loadManifests());
	} catch {
		return nameOf;
	}
	return (container) => {
		const name = nameOf(container);
		if (!name.startsWith('sha256:')) return name;
		const newestFirst = [...imagesOf(container)].sort((a, b) => (b.Created ?? 0) - (a.Created ?? 0) || a.Id.localeCompare(b.Id));
		for (const image of newestFirst) {
			const tag = displayTag(image);
			if (tag) return tag;
		}
		return name;
	};
}

/** The first real tag of an image, for showing a name instead of a bare ID. */
export function displayTag(image: UsageImage | undefined): string | undefined {
	return image?.RepoTags?.find((tag) => tag && tag !== '<none>:<none>');
}
