import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnvironment, updateEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { saveEnvironmentIcon, deleteEnvironmentIcon, getEnvironmentIconBuffer } from '$lib/server/env-icons';

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
