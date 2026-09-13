import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfigSets, createConfigSet } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditConfigSet } from '$lib/server/audit';

/**
 * @openapi
 * summary: List all config sets (reusable bundles of env vars, labels, ports, volumes, and runtime defaults)
 * resp-200: array<{id:integer!, name:string!, description:string, envVars:array<{key:string!, value:string!}>, labels:array<{key:string!, value:string!}>, ports:array<{hostPort:string!, containerPort:string!, protocol:string!}>, volumes:array<{hostPath:string!, containerPath:string!, mode:string!}>, networkMode:string!, restartPolicy:string!, createdAt:string!, updatedAt:string!}>
 * resp-200-example: [{"id":1,"name":"web-defaults","description":"Defaults for web stacks","envVars":[{"key":"TZ","value":"UTC"}],"labels":[],"ports":[],"volumes":[],"networkMode":"bridge","restartPolicy":"unless-stopped","createdAt":"2026-06-01T10:00:00Z","updatedAt":"2026-06-01T10:00:00Z"}]
 * resp-403: Permission denied (requires configsets:view)
 * resp-500: Failed to fetch config sets
 */
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

/**
 * @openapi
 * summary: Create a new config set
 * body: {name:string!, description:string, envVars:array<{key:string!, value:string!}>, labels:array<{key:string!, value:string!}>, ports:array<{hostPort:string!, containerPort:string!, protocol:string!}>, volumes:array<{hostPath:string!, containerPath:string!, mode:string!}>, networkMode:string, restartPolicy:string}
 * body-example: {"name":"web-defaults","description":"Defaults for web stacks","envVars":[{"key":"TZ","value":"UTC"}],"networkMode":"bridge","restartPolicy":"unless-stopped"}
 * resp-201: {id:integer!, name:string!, description:string, envVars:array<{key:string!, value:string!}>, labels:array<{key:string!, value:string!}>, ports:array<{hostPort:string!, containerPort:string!, protocol:string!}>, volumes:array<{hostPath:string!, containerPath:string!, mode:string!}>, networkMode:string!, restartPolicy:string!, createdAt:string!, updatedAt:string!}
 * resp-201-desc: Config set created
 * resp-201-example: {"id":1,"name":"web-defaults","description":"Defaults for web stacks","envVars":[{"key":"TZ","value":"UTC"}],"labels":[],"ports":[],"volumes":[],"networkMode":"bridge","restartPolicy":"unless-stopped","createdAt":"2026-06-01T10:00:00Z","updatedAt":"2026-06-01T10:00:00Z"}
 * resp-400: Name is required, or a config set with this name already exists
 * resp-403: Permission denied (requires configsets:create)
 * resp-500: Failed to create config set
 */
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
