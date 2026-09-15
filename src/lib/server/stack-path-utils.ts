import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep as pathSep } from 'node:path';

/** True when childPath is rootPath or one of its descendants. */
export function isPathUnderRoot(childPath: string, rootPath: string): boolean {
	const child = resolve(childPath);
	const root = resolve(rootPath);
	return child === root || child.startsWith(root + pathSep);
}

/** Remap a path from one stack dir root to its mirror under another root. Paths outside fromDir pass through. */
export function remapPathBetweenDirs(fromDir: string, toDir: string, path: string): string {
	const resolvedPath = resolve(path);
	return isPathUnderRoot(resolvedPath, fromDir)
		? join(resolve(toDir), relative(resolve(fromDir), resolvedPath))
		: path;
}

export function remapPathsBetweenDirs(fromDir: string, toDir: string, paths: string[]): string[] {
	return paths.map((path) => remapPathBetweenDirs(fromDir, toDir, path));
}

export function remapContentsBetweenDirs(
	fromDir: string,
	toDir: string,
	contents: Record<string, string>
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(contents).map(([path, content]) => [remapPathBetweenDirs(fromDir, toDir, path), content])
	);
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
