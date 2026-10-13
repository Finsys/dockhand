import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getTags, getOrCreateTag } from '$lib/server/db';
import { normalizeTag, normalizeColor } from '$lib/utils/tags-core';

/**
 * @openapi
 * summary: List the global tag catalog (name + colour)
 * resp-200: {tags:array<{id:integer!, name:string!, color:string!}>!}
 * resp-200-example: {"tags":[{"id":3,"name":"auth","color":"green"}]}
 * resp-403: Permission denied (needs containers:view)
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	// Anyone who can view containers can read the catalog (needed to assign tags);
	// only admins can mutate it (POST/PUT/DELETE below).
	if (auth.authEnabled && !(await auth.can('containers', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	return json({ tags: await getTags() });
};

/**
 * @openapi
 * summary: Create a tag (or return the existing one with the same name) in the global catalog
 * body: {name:string!, color:string, icon:string}
 * body-example: {"name":"auth","color":"green","icon":"shield"}
 * resp-200: {id:integer!, name:string!, color:string!, icon:string}
 * resp-200-example: {"id":3,"name":"auth","color":"green","icon":"shield"}
 * resp-400: Missing or invalid tag name
 * resp-403: Permission denied (admin only)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	// The catalog is global and shared across every environment, so only admins may
	// create tags. Non-admins can assign existing tags (per-env assignment endpoints).
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Only an administrator can manage the tag catalog' }, { status: 403 });
	}
	const body = await request.json().catch(() => ({}));
	const name = normalizeTag(body.name);
	if (!name) {
		return json({ error: 'A valid tag name is required' }, { status: 400 });
	}
	const icon = typeof body.icon === 'string' && body.icon.trim() ? body.icon.trim() : null;
	const tag = await getOrCreateTag(name, normalizeColor(body.color), icon);
	return json(tag);
};
