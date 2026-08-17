import { existsSync, rmSync } from 'node:fs';

export function getRemoteStackRemovalFiles<T>(
	deleteFiles: boolean,
	filesToDelete: T[] | undefined
): { removeFiles: boolean; filesToDelete: T[] | undefined } {
	return {
		removeFiles: deleteFiles,
		filesToDelete: deleteFiles ? filesToDelete : undefined
	};
}

/**
 * Remove a stack directory already approved by the stack path guard. Returning an error
 * keeps filesystem failures in the existing best-effort cleanup flow.
 */
export function removeStackDirectory(stackDir: string | null, deleteFiles: boolean): string | null {
	if (!stackDir || !deleteFiles) return null;

	try {
		rmSync(stackDir, { recursive: true, force: true });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	// rmSync with force:true may not throw on every failure.
	return existsSync(stackDir) ? 'Directory still exists after deletion attempt' : null;
}
