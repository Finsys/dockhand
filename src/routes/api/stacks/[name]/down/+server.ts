import { json } from '@sveltejs/kit';
import { downStack, ComposeFileNotFoundError } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import { createJobResponse } from '$lib/server/sse';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const { params, url, cookies, request } = event;
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

	// Parse body BEFORE creating SSE response (body can only be read once)
	let removeVolumes = false;
	try {
		const body = await request.json();
		removeVolumes = body.removeVolumes === true;
	} catch {
		// No body or invalid JSON - use defaults
	}

	return createJobResponse(async (send) => {
		try {
			const stackName = decodeURIComponent(params.name);
			const result = await downStack(stackName, envIdNum, removeVolumes);

			// Audit log
			await auditStack(event, 'down', stackName, envIdNum, { removeVolumes });

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
			console.error('Error downing compose stack:', error);
			send('result', { success: false, error: 'Failed to down compose stack' });
		}
	}, request);
};
