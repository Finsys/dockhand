import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfigSets, createConfigSet } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditConfigSet } from '$lib/server/audit';

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('configsets', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const configSets = await getConfigSets();
		return json(configSets);
	} catch (error) {
		console.error('Failed to fetch config sets:', error);
		return json({ error: 'Failed to fetch config sets' }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('configsets', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();

		if (!body.name?.trim()) {
			return json({ error: 'Name is required' }, { status: 400 });
		}

		const configSet = await createConfigSet({
			name: body.name.trim(),
			description: body.description?.trim() || undefined,
			envVars: body.envVars || [],
			labels: body.labels || [],
			ports: body.ports || [],
			volumes: body.volumes || [],
			networkMode: body.networkMode || 'bridge',
			restartPolicy: body.restartPolicy || 'no'
		});

		// Audit log
		await auditConfigSet(event, 'create', configSet.id, configSet.name);

		return json(configSet, { status: 201 });
	} catch (error: any) {
		console.error('Failed to create config set:', error);
		if (error.message?.includes('UNIQUE constraint')) {
			return json({ error: 'A config set with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to create config set' }, { status: 500 });
	}
};
