import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackComposeFile, deployStack, saveStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { createJobResponse } from '$lib/server/sse';

/**
 * GET /api/stacks/[name]/compose - Get compose file content
 *
 * @openapi
 * summary: Read the resolved compose file content for a stack, along with the resolved compose/env file paths
 * path: name:string! Stack name
 * query: env:integer Environment ID the stack belongs to
 * resp-200: {content:string!, stackDir:string, composePath:string, envPath:string, suggestedEnvPath:string}
 * resp-200-example: {"content":"services:\n  web:\n    image: nginx","stackDir":"/opt/stacks/web","composePath":"/opt/stacks/web/compose.yaml","envPath":"/opt/stacks/web/.env","suggestedEnvPath":"/opt/stacks/web/.env"}
 * resp-403: Permission denied (requires stacks:view)
 * resp-404: Compose file not found — the response carries needsFileLocation plus the suggested composePath/envPath
 * resp-500: Failed to get compose file
 */
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

/**
 * PUT /api/stacks/[name]/compose - Update compose file content
 *
 * @openapi
 * summary: Save the compose file content (with optional custom/moved paths); when restart=true the stack is redeployed with force-recreate and progress streams over SSE
 * path: name:string! Stack name
 * query: env:integer Environment ID the stack belongs to
 * body: {content:string!, restart:boolean, composePath:string, envPath:string, moveFromDir:string, oldComposePath:string, oldEnvPath:string}
 * body-example: {"content":"services:\n  web:\n    image: nginx","restart":false}
 * resp-200: {success:boolean!}
 * resp-200-desc: File saved (restart=false) or a Server-Sent-Events job stream (restart=true) reporting deploy progress and the final result
 * resp-400: Compose file content is required
 * resp-403: Permission denied (requires stacks:edit)
 * resp-500: Failed to save or deploy the compose file
 */
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

			// Deploy via SSE to keep connection alive during long operations
			return createJobResponse(async (send) => {
				try {
					const result = await deployStack({
						name,
						compose: content,
						envId: envIdNum,
						forceRecreate: true,
						composePath: composeInfo.composePath || undefined,
						envPath: composeInfo.envPath || undefined
					});

					if (!result.success) {
						send('result', { success: false, error: result.error });
						return;
					}
					send('result', { success: true });
				} catch (error: any) {
					console.error(`Error deploying stack ${name}:`, error);
					send('result', { success: false, error: error.message || 'Failed to deploy stack' });
				}
			}, request);
		}

		// Just save the file without restarting (update operation, not create)
		const result = await saveStackComposeFile(name, content, false, envIdNum, pathOptions);

		if (!result.success) {
			return json({ error: result.error }, { status: 500 });
		}

		return json({ success: true });
	} catch (error: any) {
		console.error(`Error updating compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to update compose file' }, { status: 500 });
	}
};
