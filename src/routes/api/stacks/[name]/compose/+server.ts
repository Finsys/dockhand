import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackComposeFile, deployStack, saveStackComposeFile, requireComposeFile } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { createJobResponse } from '$lib/server/sse';
import { createRunRecorder } from '$lib/server/deploy-run-record';
import { hashComposeContent, hashEnvFingerprint } from '$lib/server/deploy-run-record-core';

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
 * body: {content:string!, composePath:string, envPath:string, oldComposePath:string, oldEnvPath:string, moveFromDir:string, restart:boolean, secretProviderId:integer, pull:boolean, build:boolean, forceRecreate:boolean}
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
		const { content, restart = false, composePath, envPath, moveFromDir, oldComposePath, oldEnvPath, secretProviderId, pull, build, forceRecreate } = body;

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
			// Build/pull/force-recreate come from the caller (StackModal's "Save & redeploy"
			// popover, see RedeployPopover) -- previously this branch always deployed with
			// build:false and pull skipped regardless of what the compose file needed, so a
			// service with a `build:` section silently never rebuilt (the change was saved,
			// but `docker compose up` just reused the stale local image). forceRecreate
			// defaults to true when the caller omits it, preserving the prior hardcoded
			// behavior for any caller that hasn't been updated to send it explicitly -- env
			// var changes need --force-recreate to take effect.
			const pullOpt = !!pull;
			const buildOpt = !!build;
			const forceRecreateOpt = forceRecreate === undefined ? true : !!forceRecreate;

			// Get authoritative paths AND effective env vars from DB/filesystem for deploy
			// (now reflects the saved content). requireComposeFile() wraps
			// getStackComposeFile() and additionally resolves secretVars/nonSecretVars --
			// the same DB-sourced values deployStack itself resolves again internally
			// at deploy time (stacks.ts), and the same shape deploy/+server.ts already
			// merges for ITS run record below.
			const composeInfo = await requireComposeFile(name, envIdNum);

			// Same run record as the dedicated deploy endpoint (deploy/+server.ts:75) --
			// built up front since createJobResponse takes the recorder as an
			// already-resolved value, not something it can await for itself.
			//
			// composeHash is hashed off the just-submitted `content`, NOT
			// composeInfo.content: saveStackComposeFile() above wrote this exact string
			// verbatim (no reformatting, see stacks.ts), and it's the same string handed
			// to the deployStack call below -- hashing it directly ties the recorded hash to
			// precisely what gets deployed, instead of a redundant re-read off disk that
			// could only ever produce the same bytes anyway.
			//
			// Skipped entirely when composeInfo.success is false (the compose file is
			// unexpectedly unreadable right here, immediately after we just wrote it) --
			// the deploy below proceeds unchanged either way (composePath/envPath already
			// tolerate this via `|| undefined`), but recording a run without secretVars
			// would mean the recorder's end() redacts against an empty secrets list,
			// risking a leaked secret value in the stored error text.
			let recorder: Awaited<ReturnType<typeof createRunRecorder>> | undefined;
			if (composeInfo.success) {
				const effectiveEnvVars = { ...(composeInfo.nonSecretVars ?? {}), ...(composeInfo.secretVars ?? {}) };
				recorder = await createRunRecorder({
					stackName: name,
					envId: envIdNum ?? null,
					userId: auth.user?.id,
					triggeredBy: 'manual',
					options: { pull: pullOpt, build: buildOpt, forceRecreate: forceRecreateOpt },
					composeHash: hashComposeContent(content),
					envHash: hashEnvFingerprint(effectiveEnvVars),
					secrets: Object.values(effectiveEnvVars)
				});
			}

			// Deploy via SSE to keep connection alive during long operations
			return createJobResponse(async (send) => {
				try {
					const result = await deployStack({
						name,
						compose: content,
						envId: envIdNum,
						forceRecreate: forceRecreateOpt,
						build: buildOpt,
						// pullPolicy undefined (pull unchecked) means deployStack's post-deploy
						// reconcileStackPendingUpdates() call is skipped too -- a stale "update
						// available" badge on this stack won't clear until the next pull. Accepted
						// tradeoff, not a bug.
						pullPolicy: pullOpt ? 'always' : undefined,
						composePath: composeInfo.composePath || undefined,
						envPath: composeInfo.envPath || undefined,
						onLine: (line) => send('progress', { type: 'line', line })
					});

					// F4 fix: deployStack resolves the bound secret provider's values
					// internally, AFTER `recorder` above was already built from
					// composeInfo's DB-only vars. Feed the provider-resolved values in
					// now, before createJobResponse calls recorder.end() below -- see
					// deploy-run-record.ts. recorder may be undefined (composeInfo
					// wasn't readable), matching its optional-recorder construction above.
					recorder?.addSecrets(result.resolvedSecrets ?? []);

					if (!result.success) {
						send('result', { success: false, error: result.error });
						return;
					}
					send('result', { success: true });
				} catch (error: any) {
					console.error(`Error deploying stack ${name}:`, error);
					send('result', { success: false, error: error.message || 'Failed to deploy stack' });
				}
			}, request, recorder);
		}

		// No restart: the content is already persisted above.
		return json({ success: true });
	} catch (error: any) {
		console.error(`Error updating compose file for stack ${name}:`, error);
		return json({ error: error.message || 'Failed to update compose file' }, { status: 500 });
	}
};
