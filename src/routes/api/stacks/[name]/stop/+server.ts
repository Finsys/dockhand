import { json } from '@sveltejs/kit';
import { stopStack, ComposeFileNotFoundError } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Stop a stack (docker compose stop), asynchronously
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment id (from GET /api/environments)
 * resp-200: {jobId:string!}
 * resp-200-desc: Fire-and-forget job id — poll GET /api/jobs/{jobId} for the result. Send "Accept: application/json" (without text/event-stream) to instead block and receive the final {success,output|error} synchronously.
 * resp-200-example: {"jobId":"3f9c5b1a-2e4d-4a6f-9b0a-1c7d8e9f0a1b"}
 * resp-403: Permission denied, or access denied to this environment
 */
export const POST: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'stop', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	return createJobResponse(async (send) => {
		try {
			const stackName = decodeURIComponent(params.name);
			const result = await stopStack(stackName, envIdNum);

			// Audit log
			await auditStack(event, 'stop', stackName, envIdNum);

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
			console.error('Error stopping compose stack:', error);
			send('result', { success: false, error: 'Failed to stop compose stack' });
		}
	}, event.request);
};
