/**
 * Merge container env vars with new image env vars during auto-update.
 * Image-baked vars get updated to the new image's values.
 * User-set vars (not present in old image) are preserved.
 * Env vars removed from the new image are dropped.
 */
export function mergeImageEnvVars(
	containerEnv: string[],
	oldImageEnv: string[],
	newImageEnv: string[]
): string[] {
	const getKey = (entry: string) => entry.split('=')[0];
	const oldImageKeys = new Set(oldImageEnv.map(getKey));

	const merged: string[] = [];

	// Keep user-set env vars (key not present in old image)
	for (const entry of containerEnv) {
		if (!oldImageKeys.has(getKey(entry))) {
			merged.push(entry);
		}
	}

	// Add all new image env vars (updates changed values, adds new ones)
	for (const entry of newImageEnv) {
		const key = getKey(entry);
		// Skip if user already set this key (user wins)
		if (!merged.some(e => getKey(e) === key)) {
			merged.push(entry);
		}
	}

	return merged;
}
