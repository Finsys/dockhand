import { json } from '@sveltejs/kit';
import { deployStack, requireComposeFile, ComposeFileNotFoundError } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import { createRunRecorder } from '$lib/server/deploy-run-record';
import { hashComposeContent, hashEnvFingerprint } from '$lib/server/deploy-run-record-core';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Deploy (docker compose up) a stack, optionally pulling images, building, and force-recreating; progress and the final result stream over Server-Sent Events
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * body: {pull:boolean, build:boolean, forceRecreate:boolean}
 * body-example: {"pull":true,"build":false,"forceRecreate":false}
 * resp-200: Server-Sent-Events job stream with progress events and a final result event ({success, output})
 * resp-403: Permission denied (requires stacks:start, or environment access denied on enterprise)
 */
export const POST: RequestHandler = async (event) => {
	const { params, url, cookies, request } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'start', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	const body = await request.json().catch(() => ({}));
	const { pull, build, forceRecreate } = body as {
		pull?: boolean;
		build?: boolean;
		forceRecreate?: boolean;
	};

	const stackName = decodeURIComponent(params.name);

	// Read up-front (not inside createJobResponse's callback, as before): the run
	// record needs a compose/env hash and a schedule_executions row BEFORE the job
	// stream opens, since createJobResponse takes the recorder as a plain (already
	// resolved) argument, not something it can await for itself.
	let composeResult: Awaited<ReturnType<typeof requireComposeFile>>;
	try {
		composeResult = await requireComposeFile(stackName, envIdNum);
	} catch (error) {
		const message = error instanceof ComposeFileNotFoundError
			? error.message
			: 'Failed to deploy compose stack';
		return createJobResponse(async (send) => {
			send('result', { success: false, error: message });
		}, event.request);
	}

	if (!composeResult.success) {
		const message = composeResult.needsFileLocation
			? 'Stack compose file location not configured'
			: composeResult.error || 'Compose file not found';
		return createJobResponse(async (send) => {
			send('result', { success: false, error: message });
		}, event.request);
	}

	// Same merged set used for envHash below -- also the redaction list end() applies
	// to the stored error text, so a leaked env value never reaches errorMessage.
	const effectiveEnvVars = { ...(composeResult.nonSecretVars ?? {}), ...(composeResult.secretVars ?? {}) };

	const recorder = await createRunRecorder({
		stackName,
		envId: envIdNum ?? null,
		userId: auth.user?.id,
		triggeredBy: 'manual',
		options: { pull: !!pull, build: !!build, forceRecreate: !!forceRecreate },
		composeHash: hashComposeContent(composeResult.content!),
		envHash: hashEnvFingerprint(effectiveEnvVars),
		secrets: Object.values(effectiveEnvVars)
	});

	return createJobResponse(async (send) => {
		try {
			send('progress', { status: 'Deploying stack...' });
			const result = await deployStack({
				name: stackName,
				compose: composeResult.content!,
				envId: envIdNum,
				pullPolicy: pull ? 'always' : undefined,
				build,
				forceRecreate,
				composePath: composeResult.composePath,
				envPath: composeResult.envPath,
				onLine: (line) => send('progress', { type: 'line', line })
			});

			// Audit log
			await auditStack(event, 'deploy', stackName, envIdNum, {
				pull, build, forceRecreate
			});

			if (!result.success) {
				send('result', { success: false, error: result.error });
				return;
			}
			send('result', { success: true, output: result.output });
		} catch (error) {
			if (error instanceof ComposeFileNotFoundError) {
				send('result', { success: false, error: error.message });
				return;
			}
			console.error('Error deploying compose stack:', error);
			send('result', { success: false, error: 'Failed to deploy compose stack' });
		}
	}, event.request, recorder);
};
