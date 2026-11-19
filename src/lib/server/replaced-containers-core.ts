/**
 * While Dockhand replaces a container (an image update, a recreate, or a save in the
 * container editor), it renames the old one `<name>-old` to free the name, creates and
 * starts the new one, then removes the old one, or renames it back if the new one
 * fails. For those seconds the old copy is a second container in the list: the UI shows
 * it, and API clients such as Home Assistant's Dockhand integration create entities for
 * it, only for it to vanish moments later.
 *
 * GET /api/containers leaves that copy out while the replacement runs. It is known by
 * its id and the name the replacement gave it, never by its name alone, so a user's own
 * container called `something-old` is always listed, and so is the old container once a
 * failed replacement renames it back. An `-old` container that a failure leaves behind
 * is listed again as soon as the replacement ends. Pure and in-memory, like
 * expected-events-core.ts.
 */
export class ReplacedContainers {
	// container id -> the name its old copy has while it is being replaced
	private readonly oldNames = new Map<string, string>();

	/** Run `replace` with the container `id` (named `name`) marked as being replaced. */
	async whileReplacing<T>(id: string | undefined, name: string | undefined, replace: () => Promise<T>): Promise<T> {
		const bare = (name ?? '').replace(/^\//, '');
		if (!id || !bare) return replace();
		this.oldNames.set(id, `${bare}-old`);
		try {
			return await replace();
		} finally {
			this.oldNames.delete(id);
		}
	}

	/** True for the old copy of a container being replaced, under its `-old` name. */
	isOldCopy(container: { id: string; name: string }): boolean {
		return this.oldNames.get(container.id) === container.name;
	}

	/** Test/introspection helper. */
	size(): number {
		return this.oldNames.size;
	}
}

/**
 * Process-wide shared tracker: docker.ts marks a container while it replaces it, and
 * the containers list leaves its old copy out.
 */
export const replacedContainers = new ReplacedContainers();
