import { join, relative, resolve } from 'node:path';
import { isPathUnderRoot } from './path-utils';

function remapPathBetweenStackDirs(fromDir: string, toDir: string, path: string): string {
	const fromResolved = resolve(fromDir);
	const toResolved = resolve(toDir);
	const resolved = resolve(path);
	if (isPathUnderRoot(resolved, fromResolved)) {
		return join(toResolved, relative(fromResolved, resolved));
	}
	return path;
}

function remapPathsBetweenStackDirs(fromDir: string, toDir: string, paths: string[]): string[] {
	return paths.map((p) => remapPathBetweenStackDirs(fromDir, toDir, p));
}

function remapComposeContentsBetweenStackDirs(
	fromDir: string,
	toDir: string,
	contents: Record<string, string>
): Record<string, string> {
	const remapped: Record<string, string> = {};
	for (const [path, content] of Object.entries(contents)) {
		remapped[remapPathBetweenStackDirs(fromDir, toDir, path)] = content;
	}
	return remapped;
}

/**
 * Remap absolute paths from Dockhand's Hawser staging dir to the remote host stack dir.
 */
export function remapPathsFromStagingToRemote(
	stagingStackDir: string,
	remoteStackDir: string,
	paths: string[]
): string[] {
	return remapPathsBetweenStackDirs(stagingStackDir, remoteStackDir, paths);
}

/**
 * Remap absolute paths from the Hawser remote stack dir back to Dockhand staging.
 */
export function remapPathsFromRemoteToStaging(
	stagingStackDir: string,
	remoteStackDir: string,
	paths: string[]
): string[] {
	return remapPathsBetweenStackDirs(remoteStackDir, stagingStackDir, paths);
}

/**
 * Remap composeContents keys from staging paths to remote display paths.
 */
export function remapComposeContentsFromStagingToRemote(
	stagingStackDir: string,
	remoteStackDir: string,
	contents: Record<string, string>
): Record<string, string> {
	return remapComposeContentsBetweenStackDirs(stagingStackDir, remoteStackDir, contents);
}

/**
 * Remap composeContents keys from remote display paths back to staging paths.
 */
export function remapComposeContentsFromRemoteToStaging(
	stagingStackDir: string,
	remoteStackDir: string,
	contents: Record<string, string>
): Record<string, string> {
	return remapComposeContentsBetweenStackDirs(remoteStackDir, stagingStackDir, contents);
}
