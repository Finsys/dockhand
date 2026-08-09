import { json } from '@sveltejs/kit';
import { removeStack, ComposeFileNotFoundError } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { auditStack } from '$lib/server/audit';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const auth = await authorize(cookies);

	const force = url.searchParams.get('force') === 'true';
	const volumes = url.searchParams.get('volumes') === 'true';
	// files defaults to true (backward-compatible: old callers with no param still delete
	// files). The delete modal passes files=false for "Remove stack" (keep files on disk).
	const files = url.searchParams.get('files') !== 'false';
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !(await auth.can('stacks', 'remove', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		const result = await removeStack(stackName, envIdNum, force, volumes, files);

		// Audit log
		await auditStack(event, 'delete', stackName, envIdNum, { force, volumes, files });

		if (!result.success) {
			return json({ success: false, error: result.error }, { status: 400 });
		}
		return json({ success: true });
	} catch (error) {
		if (error instanceof ComposeFileNotFoundError) {
			return json({ error: error.message }, { status: 404 });
		}
		console.error('Error removing compose stack:', error);
		return json({ error: 'Failed to remove compose stack' }, { status: 500 });
	}
};
