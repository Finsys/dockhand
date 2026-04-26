/**
 * HashiCorp Vault Client Module
 *
 * Provides secure communication with HashiCorp Vault for secret management.
 * Supports multiple authentication methods: Token, AppRole, Kubernetes.
 */

import { decrypt } from './encryption.js';

// =============================================================================
// TYPES
// =============================================================================

export interface VaultConfig {
	address: string;
	namespace?: string;
	defaultPath?: string;
	authMethod: 'token' | 'approle' | 'kubernetes';
	token?: string; // Encrypted
	roleId?: string;
	secretId?: string; // Encrypted
	kubeRole?: string;
	skipTlsVerify?: boolean; // Accept self-signed certificates
	enabled: boolean;
}

export interface VaultSecret {
	key: string;
	value: string;
}

export interface VaultConnectionResult {
	success: boolean;
	error?: string;
	version?: string;
}

interface VaultResponse {
	data?: {
		data?: Record<string, any>;
		[key: string]: any;
	};
	auth?: {
		client_token: string;
		accessor: string;
		policies: string[];
		lease_duration: number;
		renewable: boolean;
	};
	errors?: string[];
}

// =============================================================================
// VAULT CLIENT CLASS
// =============================================================================

export class VaultClient {
	private address: string;
	private namespace?: string;
	private token?: string;
	private skipTlsVerify: boolean;
	private initialized = false;

	constructor(address: string, namespace?: string, skipTlsVerify = false) {
		// Normalize address (remove trailing slash)
		this.address = address.replace(/\/$/, '');
		this.namespace = namespace;
		this.skipTlsVerify = skipTlsVerify;
	}

	/**
	 * Make an HTTP request to Vault
	 */
	private async request(
		method: 'GET' | 'POST' | 'PUT' | 'DELETE',
		path: string,
		body?: Record<string, any>
	): Promise<VaultResponse> {
		const url = `${this.address}/v1/${path}`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};

		if (this.token) {
			headers['X-Vault-Token'] = this.token;
		}

		if (this.namespace) {
			headers['X-Vault-Namespace'] = this.namespace;
		}

		try {
			const fetchOptions: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined
			};

			// Allow self-signed certificates if configured
			if (this.skipTlsVerify) {
				fetchOptions.tls = { rejectUnauthorized: false };
			}

			const response = await fetch(url, fetchOptions);

			if (!response.ok) {
				const text = await response.text();
				let error: string;
				try {
					const json = JSON.parse(text);
					error = json.errors?.join(', ') || text;
				} catch {
					error = text;
				}
				throw new Error(`Vault request failed (${response.status}): ${error}`);
			}

			// Some Vault responses are empty (204 No Content)
			const text = await response.text();
			if (!text) {
				return {};
			}

			return JSON.parse(text);
		} catch (error) {
			if (error instanceof Error) {
				throw error;
			}
			throw new Error(`Vault request failed: ${String(error)}`);
		}
	}

	/**
	 * Authenticate with a Vault token
	 */
	async authenticateWithToken(token: string): Promise<void> {
		this.token = token;
		// Verify the token works
		await this.request('GET', 'auth/token/lookup-self');
		this.initialized = true;
	}

	/**
	 * Authenticate with AppRole
	 */
	async authenticateWithAppRole(roleId: string, secretId: string): Promise<void> {
		const response = await this.request('POST', 'auth/approle/login', {
			role_id: roleId,
			secret_id: secretId
		});

		if (!response.auth?.client_token) {
			throw new Error('AppRole authentication failed: no token returned');
		}

		this.token = response.auth.client_token;
		this.initialized = true;
	}

	/**
	 * Authenticate with Kubernetes
	 */
	async authenticateWithKubernetes(role: string): Promise<void> {
		// Read the service account token from the container
		const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
		let jwt: string;

		try {
			jwt = await Bun.file(tokenPath).text();
		} catch (error) {
			throw new Error(
				`Failed to read Kubernetes service account token from ${tokenPath}. ` +
				'Make sure Dockhand is running in a Kubernetes pod with a service account.'
			);
		}

		const response = await this.request('POST', 'auth/kubernetes/login', {
			role,
			jwt
		});

		if (!response.auth?.client_token) {
			throw new Error('Kubernetes authentication failed: no token returned');
		}

		this.token = response.auth.client_token;
		this.initialized = true;
	}

	/**
	 * Check if the client is authenticated
	 */
	isAuthenticated(): boolean {
		return this.initialized && !!this.token;
	}

	/**
	 * Read a secret from Vault (KV v2)
	 * @param path - Full path to the secret (e.g., "secret/data/myapp")
	 */
	async readSecret(path: string): Promise<Record<string, string>> {
		if (!this.isAuthenticated()) {
			throw new Error('Vault client not authenticated');
		}

		const response = await this.request('GET', path);

		// KV v2 returns data.data, KV v1 returns data directly
		const data = response.data?.data ?? response.data ?? {};

		// Convert all values to strings
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(data)) {
			result[key] = String(value);
		}

		return result;
	}

	/**
	 * Get specific secrets by keys from a path
	 * @param path - Full path to the secret (e.g., "secret/data/myapp")
	 * @param keys - Array of key names to retrieve
	 */
	async getSecrets(path: string, keys: string[]): Promise<VaultSecret[]> {
		const allSecrets = await this.readSecret(path);
		const result: VaultSecret[] = [];

		for (const key of keys) {
			if (key in allSecrets) {
				result.push({ key, value: allSecrets[key] });
			} else {
				console.warn(`[Vault] Secret key "${key}" not found at path "${path}"`);
			}
		}

		return result;
	}

	/**
	 * Test connection to Vault
	 */
	async testConnection(): Promise<VaultConnectionResult> {
		try {
			const response = await this.request('GET', 'sys/health');
			return {
				success: true,
				version: response.data?.version ?? 'unknown'
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create and authenticate a Vault client from config
 */
export async function createVaultClient(config: VaultConfig): Promise<VaultClient> {
	const client = new VaultClient(config.address, config.namespace, config.skipTlsVerify);

	switch (config.authMethod) {
		case 'token':
			if (!config.token) {
				throw new Error('Vault token auth requires a token');
			}
			// Decrypt the token before use
			const decryptedToken = decrypt(config.token);
			if (!decryptedToken) {
				throw new Error('Failed to decrypt Vault token');
			}
			await client.authenticateWithToken(decryptedToken);
			break;

		case 'approle':
			if (!config.roleId || !config.secretId) {
				throw new Error('Vault AppRole auth requires roleId and secretId');
			}
			// Decrypt the secret ID before use
			const decryptedSecretId = decrypt(config.secretId);
			if (!decryptedSecretId) {
				throw new Error('Failed to decrypt Vault secret ID');
			}
			await client.authenticateWithAppRole(config.roleId, decryptedSecretId);
			break;

		case 'kubernetes':
			if (!config.kubeRole) {
				throw new Error('Vault Kubernetes auth requires a role');
			}
			await client.authenticateWithKubernetes(config.kubeRole);
			break;

		default:
			throw new Error(`Unknown Vault auth method: ${config.authMethod}`);
	}

	return client;
}

/**
 * Test Vault connection with given config (without full authentication)
 */
export async function testVaultConnection(config: VaultConfig): Promise<VaultConnectionResult> {
	try {
		const client = await createVaultClient(config);
		return await client.testConnection();
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

/**
 * Fetch secrets from Vault for a given path and key list
 */
export async function fetchSecretsFromVault(
	config: VaultConfig,
	path: string,
	keys: string[]
): Promise<VaultSecret[]> {
	const client = await createVaultClient(config);

	// If path doesn't include 'data/' for KV v2, add it
	let fullPath = path;
	if (!path.includes('/data/')) {
		// Convert "secret/myapp" to "secret/data/myapp"
		const parts = path.split('/');
		if (parts.length >= 2) {
			fullPath = `${parts[0]}/data/${parts.slice(1).join('/')}`;
		}
	}

	return client.getSecrets(fullPath, keys);
}
