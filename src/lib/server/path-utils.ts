import { resolve, sep as pathSep } from 'node:path';

/**
 * True when `child` is `root` or a descendant. Uses `root + sep` so a sibling
 * path that merely shares a string prefix (e.g. `/repos/myrepo2` vs `/repos/myrepo`)
 * is rejected.
 */
export function isPathUnderRoot(childPath: string, rootPath: string): boolean {
	const resolvedChild = resolve(childPath);
	const resolvedRoot = resolve(rootPath);
	return resolvedChild === resolvedRoot || resolvedChild.startsWith(resolvedRoot + pathSep);
}
