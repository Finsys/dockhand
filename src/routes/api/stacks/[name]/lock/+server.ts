import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getStackSource, updateStackSourceLock } from '$lib/server/db';
import { auditStack } from '$lib/server/audit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const { params, url, cookies, request } = event;
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	if (envIdNum && auth.isEnterprise && !(await auth.canAccessEnvironment(envIdNum))) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	const stackName = decodeURIComponent(params.name);
	const source = await getStackSource(stackName, envIdNum);
	if (!source) {
		return json({ error: `Stack source not found for "${stackName}"` }, { status: 404 });
	}

	let locked: boolean;
	try {
		const body = await request.json();
		if (typeof body.locked !== 'boolean') {
			return json({ error: 'locked (boolean) is required' }, { status: 400 });
		}
		locked = body.locked;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const updated = await updateStackSourceLock(stackName, envIdNum ?? null, locked);
	if (!updated) {
		return json({ error: `Failed to update lock for "${stackName}"` }, { status: 400 });
	}

	await auditStack(event, locked ? 'lock' : 'unlock', stackName, envIdNum, { locked });
	return json({ success: true, stackName, locked });
};
