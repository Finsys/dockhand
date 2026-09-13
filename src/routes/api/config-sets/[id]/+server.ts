import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfigSet, updateConfigSet, deleteConfigSet } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditConfigSet } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';

/**
 * @openapi
 * summary: Fetch a single config set by its numeric ID
 * path: id:integer! Config set ID (from GET /api/config-sets)
 * resp-200: {id:integer!, name:string!, description:string, envVars:array<{key:string!, value:string!}>, labels:array<{key:string!, value:string!}>, ports:array<{hostPort:string!, containerPort:string!, protocol:string!}>, volumes:array<{hostPath:string!, containerPath:string!, mode:string!}>, networkMode:string!, restartPolicy:string!, createdAt:string!, updatedAt:string!}
 * resp-200-example: {"id":1,"name":"web-defaults","description":"Defaults for web stacks","envVars":[{"key":"TZ","value":"UTC"}],"labels":[],"ports":[],"volumes":[],"networkMode":"bridge","restartPolicy":"unless-stopped","createdAt":"2026-06-01T10:00:00Z","updatedAt":"2026-06-01T10:00:00Z"}
 * resp-400: Invalid ID
 * resp-403: Permission denied (requires configsets:view)
 * resp-404: Config set not found
 * resp-500: Failed to fetch config set
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('configsets', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid ID' }, { status: 400 });
		}

		const configSet = await getConfigSet(id);
		if (!configSet) {
			return json({ error: 'Config set not found' }, { status: 404 });
		}

		return json(configSet);
	} catch (error) {
		console.error('Failed to fetch config set:', error);
		return json({ error: 'Failed to fetch config set' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Update an existing config set by ID
 * path: id:integer! Config set ID (from GET /api/config-sets)
 * body: {name:string, description:string, envVars:array<{key:string!, value:string!}>, labels:array<{key:string!, value:string!}>, ports:array<{hostPort:string!, containerPort:string!, protocol:string!}>, volumes:array<{hostPath:string!, containerPath:string!, mode:string!}>, networkMode:string, restartPolicy:string}
 * body-example: {"name":"web-defaults","networkMode":"host","restartPolicy":"always"}
 * resp-200: {id:integer!, name:string!, description:string, envVars:array<{key:string!, value:string!}>, labels:array<{key:string!, value:string!}>, ports:array<{hostPort:string!, containerPort:string!, protocol:string!}>, volumes:array<{hostPath:string!, containerPath:string!, mode:string!}>, networkMode:string!, restartPolicy:string!, createdAt:string!, updatedAt:string!}
 * resp-200-example: {"id":1,"name":"web-defaults","description":"Defaults for web stacks","envVars":[],"labels":[],"ports":[],"volumes":[],"networkMode":"host","restartPolicy":"always","createdAt":"2026-06-01T10:00:00Z","updatedAt":"2026-06-02T12:00:00Z"}
 * resp-400: Invalid ID, or a config set with this name already exists
 * resp-403: Permission denied (requires configsets:edit)
 * resp-404: Config set not found
 * resp-500: Failed to update config set
 */
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('configsets', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid ID' }, { status: 400 });
		}

		// Get old values before update for diff
		const oldConfigSet = await getConfigSet(id);
		if (!oldConfigSet) {
			return json({ error: 'Config set not found' }, { status: 404 });
		}

		const body = await request.json();

		const configSet = await updateConfigSet(id, {
			name: body.name?.trim(),
			description: body.description?.trim(),
			envVars: body.envVars,
			labels: body.labels,
			ports: body.ports,
			volumes: body.volumes,
			networkMode: body.networkMode,
			restartPolicy: body.restartPolicy
		});

		if (!configSet) {
			return json({ error: 'Config set not found' }, { status: 404 });
		}

		// Compute diff for audit
		const diff = computeAuditDiff(oldConfigSet, configSet);

		// Audit log
		await auditConfigSet(event, 'update', configSet.id, configSet.name, diff);

		return json(configSet);
	} catch (error: any) {
		console.error('Failed to update config set:', error);
		if (error.message?.includes('UNIQUE constraint')) {
			return json({ error: 'A config set with this name already exists' }, { status: 400 });
		}
		return json({ error: 'Failed to update config set' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Delete a config set by ID
 * path: id:integer! Config set ID (from GET /api/config-sets)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: Invalid ID
 * resp-403: Permission denied (requires configsets:delete)
 * resp-404: Config set not found
 * resp-500: Failed to delete config set
 */
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('configsets', 'delete')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid ID' }, { status: 400 });
		}

		// Get config set name before deletion for audit log
		const configSet = await getConfigSet(id);
		if (!configSet) {
			return json({ error: 'Config set not found' }, { status: 404 });
		}

		const deleted = await deleteConfigSet(id);
		if (!deleted) {
			return json({ error: 'Failed to delete config set' }, { status: 500 });
		}

		// Audit log
		await auditConfigSet(event, 'delete', id, configSet.name);

		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete config set:', error);
		return json({ error: 'Failed to delete config set' }, { status: 500 });
	}
};
