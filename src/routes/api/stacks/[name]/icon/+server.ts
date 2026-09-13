import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { updateStackSource, getStackSource } from '$lib/server/db';
import { saveStackIcon, deleteStackIcon, getStackIconBuffer, looksLikeImage } from '$lib/server/stack-icons';

function parseEnv(raw: string | null): number | null {
	if (!raw) return null;
	const n = parseInt(raw, 10);
	return Number.isNaN(n) ? null : n;
}

/**
 * @openapi
 * summary: Get a stack's uploaded custom icon (raw image/webp bytes, not JSON)
 * path: name:string! Stack name
 * query: env:integer Environment id the stack belongs to
 * resp-200: Binary image/webp response body, Cache-Control public max-age=3600
 * resp-403: Permission denied (needs stacks:view)
 * resp-404: No custom icon set for this stack
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnv(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'view', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envId);
	if (envAccessDenied) return envAccessDenied;
	const buffer = getStackIconBuffer(params.name, envId);
	if (!buffer) return json({ error: 'No custom icon' }, { status: 404 });
	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'image/webp',
			'Cache-Control': 'public, max-age=3600',
			'X-Content-Type-Options': 'nosniff'
		}
	});
};

/**
 * @openapi
 * summary: Set a stack's icon - either a name reference or an uploaded image
 * description: Body carries EITHER `icon` (a lucide name or `selfhst:<ref>`) to set a referenced icon, OR `image` (a base64-encoded data URL, ~300KB limit) to upload a custom one (stored as `custom:stack`). One of the two is required.
 * path: name:string! Stack name
 * query: env:integer Environment id the stack belongs to
 * body: {icon:string, image:string}
 * resp-200: {success:boolean!, icon:string!}
 * resp-200-example: {"success":true,"icon":"selfhst:plex"}
 * resp-400: Neither icon nor image supplied, or image exceeds the size limit
 * resp-403: Permission denied (needs stacks:edit)
 */
export const POST: RequestHandler = async ({ params, url, request, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnv(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envId);
	if (envAccessDenied) return envAccessDenied;
	const data = await request.json();

	let iconValue: string;
	if (typeof data.image === 'string' && data.image) {
		if (data.image.length > 400_000) {
			return json({ error: 'Image too large' }, { status: 400 });
		}
		const raw = Buffer.from(data.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
		if (!looksLikeImage(raw)) {
			return json({ error: 'Uploaded file is not a recognised image' }, { status: 400 });
		}
		saveStackIcon(params.name, envId, data.image);
		iconValue = 'custom:stack';
	} else if (typeof data.icon === 'string' && data.icon) {
		// A referenced icon (lucide name or selfhst:<ref>) - drop any old upload.
		deleteStackIcon(params.name, envId);
		iconValue = data.icon;
	} else {
		return json({ error: 'Missing icon or image' }, { status: 400 });
	}

	// Ensure a stack_sources row exists, then set the icon.
	if (!(await getStackSource(params.name, envId))) {
		const { upsertStackSource } = await import('$lib/server/db');
		await upsertStackSource({ stackName: params.name, environmentId: envId, sourceType: 'external', icon: iconValue });
	} else {
		await updateStackSource(params.name, envId, { icon: iconValue });
	}
	return json({ success: true, icon: iconValue });
};

/**
 * @openapi
 * summary: Remove a stack's custom icon
 * path: name:string! Stack name
 * query: env:integer Environment id the stack belongs to
 * resp-200: {success:boolean!}
 * resp-403: Permission denied (needs stacks:edit)
 */
export const DELETE: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnv(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envId);
	if (envAccessDenied) return envAccessDenied;
	deleteStackIcon(params.name, envId);
	await updateStackSource(params.name, envId, { icon: null });
	return json({ success: true });
};
