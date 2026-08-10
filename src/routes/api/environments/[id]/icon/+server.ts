import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnvironment, updateEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { saveEnvironmentIcon, deleteEnvironmentIcon, getEnvironmentIconBuffer } from '$lib/server/env-icons';

/**
 * @openapi
 * summary: Get the custom icon image for an environment (raw image/webp bytes, not JSON)
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: Binary image/webp response body, Cache-Control public max-age=3600
 * resp-404: No custom icon set for this environment
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = parseInt(params.id);
	const buffer = getEnvironmentIconBuffer(id);

	if (!buffer) {
		return json({ error: 'No custom icon' }, { status: 404 });
	}

	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'image/webp',
			'Cache-Control': 'public, max-age=3600'
		}
	});
};

/**
 * @openapi
 * summary: Upload a custom icon for an environment (base64-encoded image, ~200KB limit)
 * path: id:integer! Environment id (from GET /api/environments)
 * body: {image:string!}
 * resp-200: {success:boolean!, icon:string!}
 * resp-200-example: {"success":true,"icon":"custom:env-3.webp"}
 * resp-400: Missing image data, or image exceeds the ~300000-char base64 size limit
 * resp-403: Permission denied (RBAC 'environments:edit' missing)
 * resp-404: Environment not found
 */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = parseInt(params.id);
	const env = await getEnvironment(id);
	if (!env) {
		return json({ error: 'Environment not found' }, { status: 404 });
	}

	const data = await request.json();
	if (!data.image || typeof data.image !== 'string') {
		return json({ error: 'Missing image data' }, { status: 400 });
	}

	// Validate size (~200KB base64 limit)
	if (data.image.length > 300_000) {
		return json({ error: 'Image too large' }, { status: 400 });
	}

	saveEnvironmentIcon(id, data.image);
	const iconValue = `custom:env-${id}.webp`;
	await updateEnvironment(id, { icon: iconValue });

	return json({ success: true, icon: iconValue });
};

/**
 * @openapi
 * summary: Remove an environment's custom icon and reset it to the default "globe" icon
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: {success:boolean!, icon:string!}
 * resp-200-example: {"success":true,"icon":"globe"}
 * resp-403: Permission denied (RBAC 'environments:edit' missing)
 * resp-404: Environment not found
 */
export const DELETE: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = parseInt(params.id);
	const env = await getEnvironment(id);
	if (!env) {
		return json({ error: 'Environment not found' }, { status: 404 });
	}

	deleteEnvironmentIcon(id);
	await updateEnvironment(id, { icon: 'globe' });

	return json({ success: true, icon: 'globe' });
};
