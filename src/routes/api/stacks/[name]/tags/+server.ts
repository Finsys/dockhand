import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { parseEnvParam } from '$lib/server/env-param';
import { getStackTagIds, setStackTagIds } from '$lib/server/db';

/**
 * @openapi
 * summary: Get the tag ids assigned to one stack (by name)
 * path: name:string! Stack name
 * query: env:integer Environment id
 * resp-200: {tagIds:array<integer>!}
 * resp-200-example: {"tagIds":[3]}
 * resp-403: Permission denied (needs stacks:view)
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnvParam(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'view', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	return json({ tagIds: await getStackTagIds(params.name, envId) });
};

/**
 * @openapi
 * summary: Replace the tag ids assigned to one stack (by name)
 * path: name:string! Stack name
 * query: env:integer Environment id
 * body: {tagIds:array<integer>!}
 * body-example: {"tagIds":[3]}
 * resp-200: {tagIds:array<integer>!}
 * resp-200-example: {"tagIds":[3]}
 * resp-403: Permission denied (needs stacks:edit)
 */
export const PUT: RequestHandler = async ({ params, url, request, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnvParam(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const body = await request.json().catch(() => ({}));
	const tagIds = Array.isArray(body.tagIds) ? body.tagIds.filter((n: unknown) => Number.isInteger(n)) : [];
	await setStackTagIds(params.name, envId, tagIds);
	return json({ tagIds });
};
