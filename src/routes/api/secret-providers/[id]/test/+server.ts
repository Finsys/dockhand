import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecretProviderById } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { testProviderConnection } from '$lib/server/secretproviders';
import { mergeProviderConfigForWrite, destinationOverridesStored, SECRET_CONFIG_KEYS } from '$lib/server/secretproviders/shared';
import type { SecretProviderConfig } from '$lib/server/secretproviders/shared';

/**
 * Test a stored provider. With no body it tests the persisted config. With an optional
 * `{ config }` override (the edit form's typed non-secret fields) a blank secret falls back to
 * the stored one - BUT ONLY when the override keeps the same destination (host/address).
 *
 * If the override points at a DIFFERENT host/address, the request is tested with the client's
 * config as-is and NO stored secret is reattached, so a `secrets:view` user cannot make the
 * server send the stored credential to a caller-chosen host. (A blank secret then just makes the
 * connection fail; the caller can supply the secret for the new host themselves.)
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
			const incoming = body.config as Record<string, unknown>;
			const stored = provider.config as unknown as Record<string, unknown>;

			if (destinationOverridesStored(incoming, stored)) {
				// Override targets a DIFFERENT server - test it with exactly what the client
				// sent, with NO stored-secret fallback, so the stored credential is never
				// delivered to a caller-chosen host.
				const hasSecret = [...SECRET_CONFIG_KEYS].some((k) => {
					const v = incoming[k];
					return typeof v === 'string' && v.trim() !== '';
				});
				if (!hasSecret) {
					// Friendlier than a raw auth failure: the stored credential is deliberately
					// not reused for a new host, so the caller must supply one for it.
					return json({
						ok: false,
						error: 'You changed the host or address, so enter its credential to test - the saved one is not reused for a different server.'
					}, { status: 200 });
				}
				configToTest = incoming as unknown as SecretProviderConfig;
			} else {
				// Same destination: normal edit-form flow (a blank secret keeps the stored one).
				configToTest = mergeProviderConfigForWrite(
					incoming,
					stored
				) as unknown as SecretProviderConfig;
			}
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
