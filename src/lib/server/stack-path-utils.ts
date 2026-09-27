import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The four compose filenames Dockhand recognizes as a stack's compose file, in
 * probe order (newest style first). Shared by the read path (getStackComposeFile
 * probing) and the save-path internal-default classification (PR #1548 review
 * point 3: the old save sentinel only matched `compose.yaml`, so an internal
 * stack whose live file was e.g. `docker-compose.yml` took the plain
 * writeFileSync custom-path branch and silently lost versioning).
 */
export const INTERNAL_COMPOSE_FILENAMES = [
	'compose.yaml',
	'compose.yml',
	'docker-compose.yml',
	'docker-compose.yaml'
] as const;

/**
 * True when `composePath` is the stack's OWN compose file - i.e. it sits inside
 * the stack's internal dir AND is one of the four standard compose filenames.
 * The edit modal always submits the RESOLVED path (including the internal
 * default for internal stacks), so this is what separates "internal default" (must
 * take the versioned save) from a genuinely external custom path (plain write).
 * A `null`/`undefined` internalDir (stack dir not found) is never the internal
 * default.
 */
export function isInternalDefaultComposePath(composePath: string, internalDir: string | null | undefined): boolean {
	if (!internalDir) return false;
	const name = basename(composePath);
	if (!(INTERNAL_COMPOSE_FILENAMES as readonly string[]).includes(name)) return false;
	return dirname(composePath) === internalDir;
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
