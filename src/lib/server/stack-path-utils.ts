import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isValidStackName } from './stack-name-guard';

export function getStackPathHintsFromContainers(containers: { labels?: Record<string, string> | null }[]): {
	workingDir: string | null;
	configFiles: string[] | null;
} {
	const configLabel = 'com.docker.compose.project.config_files';
	// Child containers may omit the label; stdin deployments use '-' instead of a path.
	const labels = containers.map(container => container.labels || {})
		.filter(labels => !!labels[configLabel] && labels[configLabel] != '-');
	const values = new Set(labels.map(labels => labels[configLabel]));
	if (values.size != 1) { return { workingDir: null, configFiles: null }; }

	return {
		workingDir: labels[0]['com.docker.compose.project.working_dir'] || null,
		configFiles: labels[0][configLabel].split(',').map(file => file.trim())
	};
}

export function resolveStackDirForLayout(
	defaultRoot: string,
	localRoot: string,
	stackName: string,
	environmentName: string | undefined,
	flatLocal: boolean
): string {
	// Defence in depth: the routes reject a bad name before they get here, but this is the
	// one place every stack path is built, and a future caller that skips the route guard
	// must not be able to escape the root. A name that is not a plain stack name - a '..',
	// a '/', a percent-escape that decoded to one - can only ever name a child of the root,
	// so it is refused here rather than joined.
	if (!isValidStackName(stackName)) {
		throw new Error('Invalid stack name');
	}
	const root = flatLocal ? localRoot : defaultRoot;
	const dir = join(root, ...(!flatLocal && environmentName ? [environmentName] : []), stackName);
	// The environment name comes from the database, not the request, but assert containment
	// on the final path anyway so this function can never hand back a path outside the root.
	const resolvedRoot = resolve(root);
	if (resolve(dir) !== resolvedRoot && !resolve(dir).startsWith(resolvedRoot + sep)) {
		throw new Error('Resolved stack path escapes the stacks root');
	}
	return dir;
}

export function findStackNameCollision<T extends { stackName: string; environmentId: number | null }>(
	sources: T[],
	stackName: string,
	environmentId?: number | null
): T | undefined {
	return sources.find(
		(source) => source.stackName === stackName && source.environmentId !== environmentId && source.environmentId != null
	);
}

/** Move a file atomically when possible, with a copy+delete fallback across filesystems. */
export function moveStackFilePathCrossDevice(
	sourcePath: string,
	destPath: string,
	label: string,
	rename: typeof renameSync = renameSync
): void {
	try {
		rename(sourcePath, destPath);
		console.log(`[Stack] Moved ${label}: ${sourcePath} -> ${destPath}`);
	} catch (renameError: any) {
		if (renameError.code !== 'EXDEV') {
			console.warn(`[Stack] Failed to move ${label}: ${renameError.message}`);
			return;
		}

		try {
			writeFileSync(destPath, readFileSync(sourcePath));
			unlinkSync(sourcePath);
			console.log(`[Stack] Copied ${label} (cross-fs): ${sourcePath} -> ${destPath}`);
		} catch (error: any) {
			console.warn(`[Stack] Failed to copy ${label}: ${error.message}`);
		}
	}
}
