/**
 * Vault Secret Fetch Test API
 *
 * POST /api/vault/fetch-test - Test fetching secrets from Vault
 */

import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getVaultConfig } from '$lib/server/db';
import { createVaultClient, type VaultConfig } from '$lib/server/vault';

/**
 * POST /api/vault/fetch-test
 * Test fetching secrets from Vault
 *
 * Request body:
 * - path: string - The Vault path to fetch from (e.g., "secret/data/myapp")
 * - keys: string[] - The secret keys to look for
 *
 * Response:
 * - success: boolean
 * - found: string[] - Keys that were found
 * - missing: string[] - Keys that were not found
 * - error?: string - Error message if failed
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();

		// Validate input
		if (!body.path || typeof body.path !== 'string') {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		if (!body.keys || !Array.isArray(body.keys) || body.keys.length === 0) {
			return json({ error: 'Keys array is required and must not be empty' }, { status: 400 });
		}

		// Get saved Vault config
		const savedConfig = await getVaultConfig();
		if (!savedConfig) {
			return json({ error: 'No Vault configuration found. Please configure Vault first.' }, { status: 400 });
		}

		if (!savedConfig.enabled) {
			return json({ error: 'Vault integration is disabled' }, { status: 400 });
		}

		// Build config for client
		const config: VaultConfig = {
			address: savedConfig.address,
			namespace: savedConfig.namespace || undefined,
			defaultPath: savedConfig.defaultPath || undefined,
			authMethod: savedConfig.authMethod as VaultConfig['authMethod'],
			skipTlsVerify: savedConfig.skipTlsVerify ?? false,
			enabled: savedConfig.enabled ?? true,
			token: savedConfig.token || undefined,
			roleId: savedConfig.roleId || undefined,
			secretId: savedConfig.secretId || undefined,
			kubeRole: savedConfig.kubeRole || undefined
		};

		// Create and authenticate client
		const client = await createVaultClient(config);

		// Normalize path for KV v2 if needed
		let fullPath = body.path;
		if (!fullPath.includes('/data/')) {
			const parts = fullPath.split('/');
			if (parts.length >= 2) {
				fullPath = `${parts[0]}/data/${parts.slice(1).join('/')}`;
			}
		}

		console.log(`[Vault Fetch Test] Fetching from path: ${fullPath}`);
		console.log(`[Vault Fetch Test] Looking for keys: ${body.keys.join(', ')}`);

		// Fetch the secret
		const secretData = await client.readSecret(fullPath);

		// Check which keys were found
		const found: string[] = [];
		const missing: string[] = [];

		for (const key of body.keys) {
			if (key in secretData) {
				found.push(key);
				console.log(`[Vault Fetch Test] Key "${key}" found`);
			} else {
				missing.push(key);
				console.log(`[Vault Fetch Test] Key "${key}" NOT found`);
			}
		}

		// Log available keys (without values)
		const availableKeys = Object.keys(secretData);
		console.log(`[Vault Fetch Test] Available keys in secret: ${availableKeys.join(', ')}`);

		return json({
			success: true,
			found,
			missing,
			availableKeys,
			path: fullPath
		});
	} catch (error) {
		console.error('[Vault Fetch Test] Error:', error);
		return json({
			success: false,
			found: [],
			missing: [],
			error: error instanceof Error ? error.message : 'Failed to fetch secrets from Vault'
		});
	}
};
