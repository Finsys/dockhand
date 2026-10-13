/**
 * One-shot container exec API
 *
 * POST: Runs a finite command in a container and returns { stdout, stderr, exitCode }.
 * Unlike the interactive exec endpoint (which returns an execId for a terminal
 * WebSocket), this waits for the command to finish and returns its result, so
 * automation clients get a plain argv -> output + exit code contract.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runExecInContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';

/**
 * POST /api/containers/{id}/exec/run - Run a one-shot command and return its output and exit code
 *
 * @openapi
 * summary: Run a finite command in a container and wait for the result, returning stdout, stderr and the exit code (a non-interactive alternative to the terminal exec endpoint). Intended for short commands - the request is bounded by a ~30s ceiling on remote (Hawser/TCP) environments; use the interactive terminal for long-running work.
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: envId:integer! The target environment ID the container lives in (from GET /api/environments)
 * body: {cmd:array<string>!, user:string, workingDir:string}
 * body-example: {"cmd":["sh","-c","echo hi && exit 3"],"workingDir":"/app"}
 * resp-200: {stdout:string!, stderr:string!, exitCode:integer!}
 * resp-400: Missing or invalid cmd (must be a non-empty array of strings)
 * resp-401: Not authenticated
 * resp-403: Permission denied
 * resp-500: Failed to run the command
 */
export const POST: RequestHandler = async ({ params, request, cookies, url }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const containerId = params.id;
	const envIdParam = url.searchParams.get('envId');
	const envId = envIdParam ? Number.parseInt(envIdParam, 10) : undefined;

	if (!await auth.can('containers', 'exec', envId)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const body = await request.json().catch(() => ({}));
	const cmd = body.cmd;
	if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c: unknown) => typeof c === 'string')) {
		return json({ error: 'cmd must be a non-empty array of strings' }, { status: 400 });
	}

	try {
		const result = await runExecInContainer(containerId, cmd, envId, {
			user: typeof body.user === 'string' ? body.user : undefined,
			workingDir: typeof body.workingDir === 'string' ? body.workingDir : undefined
		});
		return json(result);
	} catch (error: any) {
		console.error('Failed to run exec command:', error);
		return json({ error: error.message || 'Failed to run command' }, { status: 500 });
	}
};
