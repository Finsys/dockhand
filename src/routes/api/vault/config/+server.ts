/**
 * Vault Configuration API
 *
 * GET  /api/vault/config - Get current Vault configuration
 * PUT  /api/vault/config - Update Vault configuration
 * DELETE /api/vault/config - Remove Vault configuration
 */

import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { getVaultConfig, saveVaultConfig, deleteVaultConfig } from '$lib/server/db';
import { encrypt } from '$lib/server/encryption';

export interface VaultConfigResponse {
	configured: boolean;
	enabled: boolean;
	address?: string;
	namespace?: string;
	defaultPath?: string;
	authMethod?: string;
	hasToken?: boolean;
	roleId?: string;
	hasSecretId?: boolean;
	kubeRole?: string;
	skipTlsVerify?: boolean;
}

/**
 * GET /api/vault/config
 * Get current Vault configuration (without sensitive values)
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('settings', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const config = await getVaultConfig();

		if (!config) {
			return json({
				configured: false,
				enabled: false
			} as VaultConfigResponse);
		}

		// Return config without sensitive values
		const response: VaultConfigResponse = {
			configured: true,
			enabled: config.enabled ?? true,
			address: config.address,
			namespace: config.namespace ?? undefined,
			defaultPath: config.defaultPath ?? undefined,
			authMethod: config.authMethod,
			hasToken: !!config.token,
			roleId: config.roleId ?? undefined,
			hasSecretId: !!config.secretId,
			kubeRole: config.kubeRole ?? undefined,
			skipTlsVerify: config.skipTlsVerify ?? false
		};

		return json(response);
	} catch (error) {
		console.error('Failed to get Vault config:', error);
		return json({ error: 'Failed to get Vault configuration' }, { status: 500 });
	}
};

/**
 * PUT /api/vault/config
 * Update Vault configuration
 */
export const PUT: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();

		// Validate required fields
		if (!body.address || typeof body.address !== 'string') {
			return json({ error: 'Vault address is required' }, { status: 400 });
		}

		if (!body.authMethod || !['token', 'approle', 'kubernetes'].includes(body.authMethod)) {
			return json({ error: 'Valid auth method is required (token, approle, kubernetes)' }, { status: 400 });
		}

		// Validate auth-specific fields
		if (body.authMethod === 'token' && !body.token && !body.keepExistingToken) {
			return json({ error: 'Token is required for token authentication' }, { status: 400 });
		}

		if (body.authMethod === 'approle') {
			if (!body.roleId) {
				return json({ error: 'Role ID is required for AppRole authentication' }, { status: 400 });
			}
			if (!body.secretId && !body.keepExistingSecretId) {
				return json({ error: 'Secret ID is required for AppRole authentication' }, { status: 400 });
			}
		}

		if (body.authMethod === 'kubernetes' && !body.kubeRole) {
			return json({ error: 'Kubernetes role is required for Kubernetes authentication' }, { status: 400 });
		}

		// Get existing config for keeping existing secrets
		const existingConfig = await getVaultConfig();

		// Build config object
		const configToSave: Parameters<typeof saveVaultConfig>[0] = {
			address: body.address.trim(),
			namespace: body.namespace?.trim() || null,
			defaultPath: body.defaultPath?.trim() || null,
			authMethod: body.authMethod,
			enabled: body.enabled ?? true,
			skipTlsVerify: body.skipTlsVerify ?? false,
			token: null,
			roleId: null,
			secretId: null,
			kubeRole: null
		};

		// Handle token
		if (body.authMethod === 'token') {
			if (body.token && body.token !== '***') {
				configToSave.token = encrypt(body.token);
			} else if (body.keepExistingToken && existingConfig?.token) {
				configToSave.token = existingConfig.token;
			}
		}

		// Handle AppRole
		if (body.authMethod === 'approle') {
			configToSave.roleId = body.roleId?.trim() || null;

			if (body.secretId && body.secretId !== '***') {
				configToSave.secretId = encrypt(body.secretId);
			} else if (body.keepExistingSecretId && existingConfig?.secretId) {
				configToSave.secretId = existingConfig.secretId;
			}
		}

		// Handle Kubernetes
		if (body.authMethod === 'kubernetes') {
			configToSave.kubeRole = body.kubeRole?.trim() || null;
		}

		await saveVaultConfig(configToSave);

		// Return updated config
		const updatedConfig = await getVaultConfig();

		return json({
			configured: true,
			enabled: updatedConfig?.enabled ?? true,
			address: updatedConfig?.address,
			namespace: updatedConfig?.namespace ?? undefined,
			defaultPath: updatedConfig?.defaultPath ?? undefined,
			authMethod: updatedConfig?.authMethod,
			hasToken: !!updatedConfig?.token,
			roleId: updatedConfig?.roleId ?? undefined,
			hasSecretId: !!updatedConfig?.secretId,
			kubeRole: updatedConfig?.kubeRole ?? undefined,
			skipTlsVerify: updatedConfig?.skipTlsVerify ?? false
		} as VaultConfigResponse);
	} catch (error) {
		console.error('Failed to save Vault config:', error);
		return json({ error: 'Failed to save Vault configuration' }, { status: 500 });
	}
};

/**
 * DELETE /api/vault/config
 * Remove Vault configuration
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		await deleteVaultConfig();
		return json({ success: true });
	} catch (error) {
		console.error('Failed to delete Vault config:', error);
		return json({ error: 'Failed to delete Vault configuration' }, { status: 500 });
	}
};
