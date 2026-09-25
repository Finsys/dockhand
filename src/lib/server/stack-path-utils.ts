import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
	return join(flatLocal ? localRoot : defaultRoot, ...(!flatLocal && environmentName ? [environmentName] : []), stackName);
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
