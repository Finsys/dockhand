import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getStackSource } from '$lib/server/db';
import { findStackDir } from '$lib/server/stacks';
import { getCachedContainerMounts, unpersistedComposePathWarning } from '$lib/server/host-path';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * POST /api/stacks/[name]/check-path-change
 *
 * @openapi
 * summary: Check whether a proposed compose path moves the stack to a different directory and how many files the old directory still holds
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * body: {newComposePath:string!}
 * body-example: {"newComposePath":"/opt/stacks/web/compose.yaml"}
 * resp-200: {hasChanges:boolean!, oldDir:string, newDir:string, fileCount:integer!, currentComposePath:string, persistenceWarning:string}
 * resp-200-example: {"hasChanges":true,"oldDir":"/opt/stacks/old","newDir":"/opt/stacks/web","fileCount":3,"currentComposePath":"/opt/stacks/old/compose.yaml"}
 * resp-403: Permission denied (requires stacks:edit)
 * resp-500: Failed to check path changes
 */
export const POST: RequestHandler = async ({ params, request, url, cookies }) => {
	const auth = await authorize(cookies);
	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	// edit OR create: this pre-flight (files-to-move + persistence warning) is used by both
	// the relocate/save flows (edit) and the create flow (a not-yet-existing stack), and it
	// reveals nothing beyond the caller's own proposed path + Dockhand's mount layout.
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envIdNum)) && !(await auth.can('stacks', 'create', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envIdNum ?? null);
	if (envAccessDenied) return envAccessDenied;

	try {
		const body = await request.json();
		const { newComposePath } = body;

		// Get current source info
		const source = await getStackSource(name, envIdNum);

		// Determine current compose path and directory
		let currentComposePath: string | null = null;
		let currentDir: string | null = null;

		if (source?.composePath) {
			currentComposePath = source.composePath;
			currentDir = dirname(source.composePath);
		} else {
			// Stack uses default directory structure - check all valid compose filenames
			const stackDir = await findStackDir(name, envIdNum);
			if (stackDir) {
				const composeNames = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
				for (const fileName of composeNames) {
					const composePath = join(stackDir, fileName);
					if (existsSync(composePath)) {
						currentComposePath = composePath;
						currentDir = stackDir;
						break;
					}
				}
			}
		}

		// Determine new directory
		const newDir = newComposePath ? dirname(newComposePath) : null;

		// Check if directories are different and old directory exists with files
		let hasChanges = false;
		let fileCount = 0;

		if (currentDir && newDir && currentDir !== newDir && existsSync(currentDir)) {
			try {
				const files = readdirSync(currentDir);
				fileCount = files.length;
				hasChanges = fileCount > 0;
			} catch {
				// Ignore read errors
			}
		}

		// Warn if the chosen path won't survive a Dockhand recreate because it is not
		// under any of Dockhand's mounted volumes (#1524).
		const persistenceWarning = unpersistedComposePathWarning(newComposePath, getCachedContainerMounts());

		return json({
			hasChanges,
			oldDir: currentDir,
			newDir,
			fileCount,
			currentComposePath,
			persistenceWarning
		});
	} catch (error: any) {
		console.error(`Error checking path change for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to check path changes' }, { status: 500 });
	}
};
