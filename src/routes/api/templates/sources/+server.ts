import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { isSafeWebhookUrl } from '$lib/server/url-safety';
import { getTemplateSources, updateTemplateSource, addTemplateSource, deleteTemplateSource } from '$lib/server/templates';

/**
 * GET /api/templates/sources - List configured template sources
 *
 * @openapi
 * summary: List all configured template sources (built-in and custom)
 * resp-200: array<{id:integer!, name:string!, url:string!, enabled:boolean!}>
 * resp-200-example: [{"id":1,"name":"LinuxServer.io","url":"https://fleet.linuxserver.io/api/v1/images","enabled":true}]
 * resp-403: Permission denied
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('templates', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const sources = await getTemplateSources();
	return json(sources);
};

// Toggle enabled or update a source
/**
 * PUT /api/templates/sources - Toggle or update a template source
 *
 * @openapi
 * summary: Update a template source — toggle enabled, or change its name/URL (only provided fields are changed)
 * body: {id:integer!, enabled:boolean, name:string, url:string}
 * body-example: {"id":3,"enabled":false}
 * resp-200: {ok:boolean!}
 * resp-200-example: {"ok":true}
 * resp-400: Missing id
 * resp-403: Permission denied
 */
export const PUT: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('templates', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const { id, enabled, name, url } = await request.json();
	if (!id) return json({ error: 'Missing id' }, { status: 400 });

	const updates: any = {};
	if (enabled !== undefined) updates.enabled = enabled;
	if (name !== undefined) updates.name = name;
	if (url !== undefined) {
		const safety = isSafeWebhookUrl(url);
		if (!safety.ok) return json({ error: `Invalid source URL: ${safety.reason}` }, { status: 400 });
		updates.url = url;
	}

	await updateTemplateSource(id, updates);
	return json({ ok: true });
};

// Add a custom source
/**
 * POST /api/templates/sources - Add a custom template source
 *
 * @openapi
 * summary: Add a custom template source with a name and URL
 * body: {name:string!, url:string!}
 * body-example: {"name":"My Templates","url":"https://example.com/templates.json"}
 * resp-200: {id:integer!, name:string!, url:string!, enabled:boolean!}
 * resp-200-example: {"id":4,"name":"My Templates","url":"https://example.com/templates.json","enabled":true}
 * resp-400: Name and URL are required
 * resp-403: Permission denied
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('templates', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const { name, url } = await request.json();
	if (!name?.trim() || !url?.trim()) {
		return json({ error: 'Name and URL are required' }, { status: 400 });
	}
	const safety = isSafeWebhookUrl(url.trim());
	if (!safety.ok) return json({ error: `Invalid source URL: ${safety.reason}` }, { status: 400 });

	const source = await addTemplateSource({ name: name.trim(), url: url.trim() });
	return json(source);
};

// Delete a custom source
/**
 * DELETE /api/templates/sources - Delete a custom template source
 *
 * @openapi
 * summary: Delete a custom template source by ID
 * query: id:integer! ID of the template source to delete (from GET /api/templates/sources)
 * resp-200: {ok:boolean!}
 * resp-200-example: {"ok":true}
 * resp-400: Missing id
 * resp-403: Permission denied
 */
export const DELETE: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('templates', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'Missing id' }, { status: 400 });

	await deleteTemplateSource(parseInt(id));
	return json({ ok: true });
};
