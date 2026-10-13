/**
 * Finding a container whose id has changed under a stale selection.
 *
 * An update recreates the container with a new id, so a list of containers to update
 * that was gathered before one ran holds an id nothing answers to any more. The
 * pending row records the NAME, which survives a recreate - the same thing the
 * auto-update schedule identifies a container by - so the container is still
 * reachable when the id alone is not.
 */

export type Candidate = { id: string; name: string };

/**
 * The container this id meant, by id first and by its recorded name second.
 *
 * Returns null when neither finds it, which is a container that is genuinely gone
 * rather than merely recreated.
 */
export function resolveContainer<T extends Candidate>(
	containers: readonly T[],
	containerId: string,
	recordedName: string | null | undefined
): T | null {
	const byId = containers.find((c) => c.id === containerId);
	if (byId) return byId;
	if (!recordedName) return null;
	return containers.find((c) => c.name === recordedName) ?? null;
}

/** What to call a container that could not be found: its recorded name, or nothing. */
export function labelForMissing(recordedName: string | null | undefined): string {
	return recordedName?.trim() || 'unknown';
}
