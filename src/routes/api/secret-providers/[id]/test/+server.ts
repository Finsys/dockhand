import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecretProviderById } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { testProviderConnection } from '$lib/server/secretproviders';
import { mergeProviderConfigForWrite } from '$lib/server/secretproviders/shared';
import type { SecretProviderConfig } from '$lib/server/secretproviders/shared';

/**
 * Test a stored provider. With no body it tests the persisted config. With an optional
 * `{ config }` override (the edit form's typed non-secret fields) it tests exactly what a
 * Save would persist: the incoming config merged over the stored one, with a blank token
 * falling back to the stored secret. The secret is NEVER supplied by the client - it comes
 * from storage server-side - so this stays a `secrets:view` operation.
 *
 * @openapi
 * summary: Test a stored provider's connectivity, optionally against typed override fields the edit form would save
 * path: id:integer The secret provider id
 * body: {config:object}
 * body-example: {"config":{"host":"https://vault.example.com","mount":"secret"}}
 * resp-200: {ok:boolean!, error:string}
 * resp-200-desc: ok=false carries the connection error (still 200 so the edit form can show it inline)
 * resp-400: Invalid secret provider ID
 * resp-403: Permission denied (needs secrets:view)
 * resp-404: Secret provider not found
 */
export const POST: RequestHandler = async ({ params, cookies, request }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = Number.parseInt(params.id);
	if (Number.isNaN(id)) {
		return json({ error: 'Invalid secret provider ID' }, { status: 400 });
	}

	const provider = await getSecretProviderById(id);
	if (!provider) {
		return json({ error: 'Secret provider not found' }, { status: 404 });
	}

	let configToTest: SecretProviderConfig = provider.config;
	try {
		const body = await request.json();
		if (body && typeof body.config === 'object' && body.config !== null) {
			configToTest = mergeProviderConfigForWrite(
				body.config as Record<string, unknown>,
				provider.config as unknown as Record<string, unknown>
			) as unknown as SecretProviderConfig;
		}
	} catch {
		// No/invalid body: test the stored config as-is.
	}

	const result = await testProviderConnection(provider.type, configToTest);
	if (!result.ok) {
		return json({ ok: false, error: result.error }, { status: 200 });
	}
	return json({ ok: true });
};
