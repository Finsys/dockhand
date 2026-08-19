import { json } from '@sveltejs/kit';
import { restartStack, ComposeFileNotFoundError } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Restart a stack (mode=restart) or recreate its containers (mode=recreate); progress and the final result stream over Server-Sent Events
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * query: mode:string Restart mode — "recreate" recreates containers, anything else performs a plain restart
 * resp-200: Server-Sent-Events job stream with a final result event ({success, output})
 * resp-403: Permission denied (requires stacks:restart, or environment access denied on enterprise)
 */
export const POST: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'restart', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	const mode = url.searchParams.get('mode') === 'recreate' ? 'recreate' : 'restart';

	return createJobResponse(async (send) => {
		try {
			const stackName = decodeURIComponent(params.name);
			const result = await restartStack(stackName, envIdNum, mode);

			// Audit log
			await auditStack(event, 'restart', stackName, envIdNum);

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
			console.error('Error restarting compose stack:', error);
			send('result', { success: false, error: 'Failed to restart compose stack' });
		}
	}, event.request);
};
