import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { hasProvider, testProviderConnection } from '$lib/server/secretproviders';

/**
 * Test a provider config before it's persisted to the database.
 *
 * @openapi
 * summary: Test an unsaved provider config (before creating the provider)
 * body: {type:string!, config:object!}
 * body-example: {"type":"vault","config":{"host":"https://vault.example.com","mount":"secret","token":"hvs...."}}
 * resp-200: {ok:boolean!, error:string}
 * resp-200-desc: ok=false carries the reason (invalid type, missing config, or a connection error) - still 200 so the form shows it inline
 * resp-400: Invalid request body
 * resp-403: Permission denied (needs secrets:create)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'create'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	let type = '';
	let config: unknown;
	try {
		const data = await request.json();
		type = typeof data.type === 'string' ? data.type.trim() : '';
		config = data.config;
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}

	if (!type || !hasProvider(type)) {
		return json({ ok: false, error: 'A valid provider type is required' }, { status: 200 });
	}
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		return json({ ok: false, error: 'Config is required' }, { status: 200 });
	}

	const result = await testProviderConnection(type, config as any);
	return json(result);
};
