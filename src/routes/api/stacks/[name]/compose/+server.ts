import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackComposeFile, deployStack, saveStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';

// GET /api/stacks/[name]/compose - Get compose file content
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	try {
		const result = await getStackComposeFile(name, envIdNum);

		if (!result.success) {
			// Return info about what's needed - unified response for all missing compose files
			return json({
				error: result.error,
				needsFileLocation: result.needsFileLocation || false,
				composePath: result.composePath,
				envPath: result.envPath
			}, { status: 404 });
		}

		return json({
			content: result.content,
			stackDir: result.stackDir,
			composePath: result.composePath,
			envPath: result.envPath,
			suggestedEnvPath: result.suggestedEnvPath
		});
	} catch (error: any) {
		console.error(`Error getting compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to get compose file' }, { status: 500 });
	}
};

// PUT /api/stacks/[name]/compose - Update compose file content
export const PUT: RequestHandler = async ({ params, request, url, cookies }) => {
	const auth = await authorize(cookies);

	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { content, restart = false, composePath, envPath, moveFromDir, oldComposePath, oldEnvPath } = body;

		if (!content || typeof content !== 'string') {
			return json({ error: 'Compose file content is required' }, { status: 400 });
		}

		// Build options object for custom paths, move operation, and file renames
		const pathOptions = (composePath || envPath !== undefined || moveFromDir || oldComposePath || oldEnvPath)
			? { composePath, envPath, moveFromDir, oldComposePath, oldEnvPath }
			: undefined;

		let result;
		if (restart) {
			// Deploy with docker compose up -d --force-recreate
			// Force recreate ensures env var changes are applied
			// Save paths first if provided
			if (pathOptions) {
				const saveResult = await saveStackComposeFile(name, content, false, envIdNum, pathOptions);
				if (!saveResult.success) {
					return json({ error: saveResult.error }, { status: 500 });
				}
			}
			// Get authoritative paths from DB/filesystem for deploy
			const composeInfo = await getStackComposeFile(name, envIdNum);
			result = await deployStack({
				name,
				compose: content,
				envId: envIdNum,
				forceRecreate: true,
				composePath: composeInfo.composePath || undefined,
				envPath: composeInfo.envPath || undefined
			});
		} else {
			// Just save the file without restarting (update operation, not create)
			result = await saveStackComposeFile(name, content, false, envIdNum, pathOptions);
		}

		if (!result.success) {
			return json({ error: result.error }, { status: 500 });
		}

		return json({ success: true });
	} catch (error: any) {
		console.error(`Error updating compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to update compose file' }, { status: 500 });
	}
};
