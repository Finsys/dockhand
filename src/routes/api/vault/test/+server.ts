/**
 * Vault Connection Test API
 *
 * POST /api/vault/test - Test Vault connection with provided or saved config
 */

import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getVaultConfig } from '$lib/server/db';
import { testVaultConnection, type VaultConfig } from '$lib/server/vault';
import { encrypt, decrypt } from '$lib/server/encryption';

/**
 * POST /api/vault/test
 * Test Vault connection
 *
 * Can either:
 * - Test with provided config (for testing before saving)
 * - Test with saved config (if no config provided)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		let configToTest: VaultConfig;

		if (body.address) {
			// Test with provided config
			if (!body.authMethod || !['token', 'approle', 'kubernetes'].includes(body.authMethod)) {
				return json({ error: 'Valid auth method is required' }, { status: 400 });
			}

			configToTest = {
				address: body.address,
				namespace: body.namespace || undefined,
				defaultPath: body.defaultPath || undefined,
				authMethod: body.authMethod,
				skipTlsVerify: body.skipTlsVerify ?? false,
				enabled: true,
				token: undefined,
				roleId: undefined,
				secretId: undefined,
				kubeRole: undefined
			};

			// Handle auth credentials
			if (body.authMethod === 'token') {
				if (!body.token) {
					// Try to use existing token
					const existingConfig = await getVaultConfig();
					if (body.keepExistingToken && existingConfig?.token) {
						configToTest.token = existingConfig.token;
					} else {
						return json({ error: 'Token is required' }, { status: 400 });
					}
				} else if (body.token !== '***') {
					// Encrypt the provided token for the test
					configToTest.token = encrypt(body.token) ?? undefined;
				} else {
					// Using placeholder, get existing
					const existingConfig = await getVaultConfig();
					if (existingConfig?.token) {
						configToTest.token = existingConfig.token;
					} else {
						return json({ error: 'Token is required' }, { status: 400 });
					}
				}
			}

			if (body.authMethod === 'approle') {
				configToTest.roleId = body.roleId;

				if (!body.secretId) {
					const existingConfig = await getVaultConfig();
					if (body.keepExistingSecretId && existingConfig?.secretId) {
						configToTest.secretId = existingConfig.secretId;
					} else {
						return json({ error: 'Secret ID is required' }, { status: 400 });
					}
				} else if (body.secretId !== '***') {
					configToTest.secretId = encrypt(body.secretId) ?? undefined;
				} else {
					const existingConfig = await getVaultConfig();
					if (existingConfig?.secretId) {
						configToTest.secretId = existingConfig.secretId;
					} else {
						return json({ error: 'Secret ID is required' }, { status: 400 });
					}
				}
			}

			if (body.authMethod === 'kubernetes') {
				configToTest.kubeRole = body.kubeRole;
			}
		} else {
			// Test with saved config
			const savedConfig = await getVaultConfig();
			if (!savedConfig) {
				return json({ error: 'No Vault configuration found' }, { status: 400 });
			}

			configToTest = {
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
		}

		const result = await testVaultConnection(configToTest);

		return json({
			success: result.success,
			error: result.error,
			version: result.version
		});
	} catch (error) {
		console.error('Failed to test Vault connection:', error);
		return json({
			success: false,
			error: error instanceof Error ? error.message : 'Failed to test Vault connection'
		});
	}
};
