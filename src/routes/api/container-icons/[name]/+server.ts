import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getContainerIconOverride, setContainerIconOverride, deleteContainerIconOverride } from '$lib/server/db';
import { saveContainerIcon, deleteContainerIcon, getContainerIconBuffer, looksLikeImage } from '$lib/server/container-icons';

function parseEnv(raw: string | null): number | null {
	if (!raw) return null;
	const n = parseInt(raw, 10);
	return Number.isNaN(n) ? null : n;
}

/**
 * @openapi
 * summary: Get a container's uploaded custom icon (raw image/webp bytes, not JSON)
 * path: name:string! Container name
 * query: env:integer Environment id the container belongs to
 * resp-200: Binary image/webp response body, Cache-Control public max-age=3600
 * resp-403: Permission denied (needs containers:view)
 * resp-404: No custom icon set for this container
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnv(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('containers', 'view', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const buffer = getContainerIconBuffer(params.name, envId);
	if (!buffer) return json({ error: 'No custom icon' }, { status: 404 });
	return new Response(new Uint8Array(buffer), {
		headers: {
			'Content-Type': 'image/webp',
			// no-cache (revalidate every load) so a re-uploaded icon at the same URL isn't
			// served stale - the override URL has no version token to bust a long cache.
			'Cache-Control': 'no-cache, must-revalidate',
			'X-Content-Type-Options': 'nosniff'
		}
	});
};

/**
 * @openapi
 * summary: Set a container's icon override - either a name reference or an uploaded image
 * description: Body carries EITHER `icon` (a lucide name or `selfhst:<ref>`) to set a referenced icon, OR `image` (a base64-encoded data URL, ~300KB limit) to upload a custom one (stored as `custom:container`). One of the two is required. The override is keyed by container name + environment, so it survives container recreation.
 * path: name:string! Container name
 * query: env:integer Environment id the container belongs to
 * body: {icon:string, image:string}
 * resp-200: {success:boolean!, icon:string!}
 * resp-200-example: {"success":true,"icon":"selfhst:plex"}
 * resp-400: Neither icon nor image supplied, or image exceeds the size limit
 * resp-403: Permission denied (needs containers:edit)
 */
export const POST: RequestHandler = async ({ params, url, request, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnv(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('containers', 'edit', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
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
		saveContainerIcon(params.name, envId, data.image);
		iconValue = 'custom:container';
	} else if (typeof data.icon === 'string' && data.icon) {
		// A referenced icon (lucide name or selfhst:<ref>) - drop any old upload.
		deleteContainerIcon(params.name, envId);
		iconValue = data.icon;
	} else {
		return json({ error: 'Missing icon or image' }, { status: 400 });
	}

	await setContainerIconOverride(params.name, envId, iconValue);
	return json({ success: true, icon: iconValue });
};

/**
 * @openapi
 * summary: Remove a container's icon override (fall back to automatic matching)
 * path: name:string! Container name
 * query: env:integer Environment id the container belongs to
 * resp-200: {success:boolean!}
 * resp-403: Permission denied (needs containers:edit)
 */
export const DELETE: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = parseEnv(url.searchParams.get('env'));
	if (auth.authEnabled && !(await auth.can('containers', 'edit', envId ?? undefined))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	deleteContainerIcon(params.name, envId);
	await deleteContainerIconOverride(params.name, envId);
	return json({ success: true });
};
