import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackComposeFile, deployStack, saveStackComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { createJobResponse } from '$lib/server/sse';

// GET /api/stacks/[name]/compose - Get compose file content
/**
 * @openapi
 * summary: Get a stack's compose file content plus its resolved compose/env paths
 * path: name:string The stack name
 * query: env:integer Environment id the stack belongs to
 * resp-403: Permission denied (needs stacks:view)
 * resp-404: Stack or compose file not found
 * resp-500: Failed to read the compose file
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

// PUT /api/stacks/[name]/compose - Update compose file content
/**
 * @openapi
 * summary: Save a stack's compose file (and optionally relocate it, bind a secret provider, and redeploy)
 * description: Every accepted PUT persists the compose content; with restart it also redeploys. Supports moving the compose/env to a new path and binding a secret provider.
 * path: name:string The stack name
 * query: env:integer Environment id the stack belongs to
 * body: {content:string!, composePath:string, envPath:string, oldComposePath:string, oldEnvPath:string, moveFromDir:string, restart:boolean, secretProviderId:integer}
 * resp-400: Invalid request (e.g. missing content, or secretProviderId wrong type)
 * resp-403: Permission denied (needs stacks:edit; binding a secret provider also needs secrets:view)
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
		const { content, restart = false, composePath, envPath, moveFromDir, oldComposePath, oldEnvPath, secretProviderId } = body;

		if (!content || typeof content !== 'string') {
			return json({ error: 'Compose file content is required' }, { status: 400 });
		}

		if (
			'secretProviderId' in body &&
			secretProviderId !== null &&
			typeof secretProviderId !== 'number'
		) {
			return json({ error: 'secretProviderId must be a number or null' }, { status: 400 });
		}

		// Binding a secret provider resolves its secrets into the container at deploy;
		// require the secrets permission so a stacks-only user can't exfiltrate a
		// provider's secrets by binding it and reading the container env.
		if (
			typeof secretProviderId === 'number' &&
			auth.authEnabled &&
			!(await auth.can('secrets', 'view', envIdNum))
		) {
			return json({ error: 'Permission denied: binding a secret provider requires the secrets permission' }, { status: 403 });
		}

		// Build options object for custom paths, move operation, file renames, and secret provider binding
		const pathOptions = (composePath || envPath !== undefined || moveFromDir || oldComposePath || oldEnvPath || secretProviderId !== undefined)
			? { composePath, envPath, moveFromDir, oldComposePath, oldEnvPath, secretProviderId }
			: undefined;

		// Persist the submitted content on EVERY accepted PUT, whether or not path fields came
		// along. Gating this on pathOptions left Dockhand's stored copy stale while restart:true
		// deployed the new content - a later GET then served the old copy, silently reverting the
		// change on the next read/edit/deploy round-trip (#1383). saveStackComposeFile handles a
		// possibly-undefined pathOptions fine (the non-restart branch already relied on that).
		const saveResult = await saveStackComposeFile(name, content, false, envIdNum, pathOptions);
		if (!saveResult.success) {
			return json({ error: saveResult.error }, { status: 500 });
		}

		if (restart) {
			// Deploy with docker compose up -d --force-recreate.
			// Force recreate ensures env var changes are applied.
			// Get authoritative paths from DB/filesystem for deploy (now reflects the saved content).
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

		// No restart: the content is already persisted above.
		return json({ success: true });
	} catch (error: any) {
		console.error(`Error updating compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to update compose file' }, { status: 500 });
	}
};
