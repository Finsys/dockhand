import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironment, getEnvSetting, setEnvSetting } from '$lib/server/db';

// Per-env "remote stacks directory" for `direct` environments. A direct daemon has no
// agent and no shared filesystem with Dockhand, so relative bind files (./config.yaml,
// ./data) never reach it. When this is set, Dockhand stages the stack files onto the
// remote host under this dir before `docker compose up`. Empty/unset = current behavior.
// Stored via the generic per-env settings store (no schema column).

export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('environments', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const id = parseInt(params.id);
	const env = await getEnvironment(id);
	if (!env) return json({ error: 'Environment not found' }, { status: 404 });

	const stored = await getEnvSetting('remote_stacks_dir', id);
	const remoteStacksDir = stored && typeof stored === 'string' && stored.trim() !== '' ? stored : null;
	return json({ remoteStacksDir });
};

export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('environments', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const id = parseInt(params.id);
	const env = await getEnvironment(id);
	if (!env) return json({ error: 'Environment not found' }, { status: 404 });

	const data = await request.json().catch(() => ({}));
	const raw = data?.remoteStacksDir;

	// null / '' clears the setting (reverts to current behavior).
	if (raw === null || raw === undefined || raw === '') {
		await setEnvSetting('remote_stacks_dir', '', id);
		return json({ success: true, remoteStacksDir: null });
	}
	if (typeof raw !== 'string') {
		return json({ error: 'remoteStacksDir must be a string or null' }, { status: 400 });
	}
	// Must be an absolute path on the remote host; reject relative or traversal-y input.
	const value = raw.trim();
	if (!value.startsWith('/') || value.includes('..')) {
		return json({ error: 'remoteStacksDir must be an absolute path with no ".."' }, { status: 400 });
	}
	await setEnvSetting('remote_stacks_dir', value, id);
	return json({ success: true, remoteStacksDir: value });
};
