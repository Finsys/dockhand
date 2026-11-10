// Which "Stack files on the host" entries the picker lets the user deselect.

export type StackFileEntry = { name: string; capturedAs?: 'bind' | 'volume' };

/** Files the server never excludes (isLoadBearingStackFile): any `.yml`/`.yaml` (the compose
 *  graph) and `.env*`. Locked here so the picker never shows an exclusion that will not happen. */
export function isLoadBearingStackEntry(name: string): boolean {
	if (name === '.env' || name.startsWith('.env.')) return true;
	return /\.ya?ml$/i.test(name);
}

/**
 * A bind dir stays deselectable here: when its bind is unticked below, these stack files
 * are the only place it is still captured, so this is where the user leaves it out.
 */
export function isStackEntryLocked(e: StackFileEntry): boolean {
	return isLoadBearingStackEntry(e.name) || e.capturedAs === 'volume';
}

/** The saved exclusions that take effect: a load-bearing name the server keeps anyway is dropped. */
export function effectiveStackFileExclusions(excluded: string[]): string[] {
	return excluded.filter((name) => !isLoadBearingStackEntry(name));
}
