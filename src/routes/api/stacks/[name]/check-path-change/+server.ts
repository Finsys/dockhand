import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getStackSource } from '$lib/server/db';
import { findStackDir } from '$lib/server/stacks';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * POST /api/stacks/[name]/check-path-change
 *
 * Check if the proposed compose path differs from current and if old directory has files.
 * Returns information about what would need to be moved if location changes.
 */
export const POST: RequestHandler = async ({ params, request, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

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

		return json({
			hasChanges,
			oldDir: currentDir,
			newDir,
			fileCount,
			currentComposePath
		});
	} catch (error: any) {
		console.error(`Error checking path change for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to check path changes' }, { status: 500 });
	}
};
