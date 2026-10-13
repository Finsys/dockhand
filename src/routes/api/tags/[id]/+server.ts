import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { updateTag, deleteTag, getTags } from '$lib/server/db';
import { normalizeTag, normalizeColor, TAG_COLORS } from '$lib/utils/tags-core';

/**
 * @openapi
 * summary: Update a global catalog tag's name and/or colour
 * path: id:integer! Tag id
 * body: {name:string, color:string, icon:string}
 * body-example: {"color":"blue","icon":"cloud"}
 * resp-200: {success:boolean!}
 * resp-400: Invalid tag id or name
 * resp-403: Permission denied (admin only)
 * resp-409: A tag with that name already exists
 */
export const PUT: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	// The tag catalog is global; only admins may rename/recolour a tag.
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Only an administrator can manage the tag catalog' }, { status: 403 });
	}
	const tagId = Number.parseInt(params.id, 10);
	if (Number.isNaN(tagId)) return json({ error: 'Invalid tag id' }, { status: 400 });

	const body = await request.json().catch(() => ({}));
	const patch: { name?: string; color?: string; icon?: string | null } = {};
	if (body.name !== undefined) {
		const name = normalizeTag(body.name);
		if (!name) return json({ error: 'A valid tag name is required' }, { status: 400 });
		// Reject a rename that would collide with another tag (unique on name).
		const clash = (await getTags()).some(
			(t) => t.id !== tagId && t.name.toLowerCase() === name.toLowerCase()
		);
		if (clash) return json({ error: `A tag named "${name}" already exists` }, { status: 409 });
		patch.name = name;
	}
	if (body.color !== undefined && (TAG_COLORS as readonly string[]).includes(body.color)) {
		patch.color = normalizeColor(body.color);
	}
	// icon: a non-empty string sets it; null or '' clears it back to the default tag icon.
	if (body.icon !== undefined) {
		patch.icon = typeof body.icon === 'string' && body.icon.trim() ? body.icon.trim() : null;
	}
	await updateTag(tagId, patch);
	return json({ success: true });
};

/**
 * @openapi
 * summary: Delete a catalog tag (removes it from every container and stack)
 * path: id:integer! Tag id
 * resp-200: {success:boolean!}
 * resp-400: Invalid tag id
 * resp-403: Permission denied (admin only)
 */
export const DELETE: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	// The tag catalog is global; only admins may delete a tag (cascades to all envs).
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Only an administrator can manage the tag catalog' }, { status: 403 });
	}
	const tagId = Number.parseInt(params.id, 10);
	if (Number.isNaN(tagId)) return json({ error: 'Invalid tag id' }, { status: 400 });
	await deleteTag(tagId);
	return json({ success: true });
};
