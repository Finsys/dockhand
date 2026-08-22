/**
 * Azure Key Vault provider.
 *
 * Authenticates a service principal (app registration) via OAuth2
 * client-credentials against Azure AD, then reads secrets over the Key Vault
 * REST API. Two resolution modes:
 *   - Bulk pull: every secret in the vault, keyed by secret name.
 *   - Inline references: `azurekv://<secret-name>`, one secret at a time.
 *
 * Pure HTTP (undici) - no Azure SDK. The client secret stays in the (encrypted)
 * config; the short-lived bearer token is cached in memory per service principal.
 */

import { request } from 'undici';
import type { AzureKvConfig, SecretProvider, TestConnectionResult } from './shared';
import { assertSafeProviderHost, isJsonResponse } from './shared';

const API_VERSION = '7.4';
const AZURE_REF_PREFIX = 'azurekv://';
// Key Vault secret names are 1-127 chars, alphanumeric and dashes only.
const AZURE_REF_RE = /^azurekv:\/\/[A-Za-z0-9-]{1,127}$/;

/** Strip a trailing slash from the vault URI so path joins are clean. */
function baseUrl(config: AzureKvConfig): string {
	return config.vaultUri.replace(/\/+$/, '');
}

/** The secret name from an `azurekv://<name>` reference. */
function refName(ref: string): string {
	return ref.slice(AZURE_REF_PREFIX.length);
}

interface CachedToken {
	token: string;
	/** Epoch ms after which the cached token is treated as expired. */
	expiresAt: number;
}
// Keyed by tenant + client + vault so two providers never share a token.
const tokenCache = new Map<string, CachedToken>();
const TOKEN_REFRESH_MARGIN_MS = 60_000;

function tokenCacheKey(config: AzureKvConfig): string {
	return `${config.tenantId}::${config.clientId}::${baseUrl(config)}`;
}

/** Clear the AD token cache (called on provider config change / deletion). */
export function clearAzureKvTokenCache(): void {
	tokenCache.clear();
}

/**
 * Acquire an AD access token for the Key Vault scope via client-credentials.
 * Cached until shortly before expiry. Throws on auth failure.
 */
async function getAccessToken(config: AzureKvConfig): Promise<string> {
	const key = tokenCacheKey(config);
	const now = Date.now();
	const hit = tokenCache.get(key);
	if (hit && hit.expiresAt > now) return hit.token;

	// Azure AD lives on login.microsoftonline.com - a fixed, public host. The
	// vaultUri IS user-controlled, so it is SSRF-guarded before any request.
	const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`;
	const form = new URLSearchParams({
		grant_type: 'client_credentials',
		client_id: config.clientId,
		client_secret: config.clientSecret,
		scope: 'https://vault.azure.net/.default'
	});

	const { statusCode, body } = await request(tokenUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: form.toString()
	});
	const text = await body.text();
	if (statusCode < 200 || statusCode >= 300 || !isJsonResponse(text)) {
		let detail = '';
		try {
			detail = ((JSON.parse(text) as { error_description?: string }).error_description ?? '')
				.split('\n')[0]
				?.trim() ?? '';
		} catch {
			// non-JSON body; leave detail empty
		}
		throw new Error(
			`Azure Key Vault: authentication failed (HTTP ${statusCode}${detail ? `: ${detail}` : ''})`
		);
	}
	const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
	if (!data.access_token) throw new Error('Azure Key Vault: no access token returned');

	const ttlMs = (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000;
	tokenCache.set(key, { token: data.access_token, expiresAt: now + ttlMs - TOKEN_REFRESH_MARGIN_MS });
	return data.access_token;
}

/** Read one secret's value by name. Returns null when the secret is absent. */
async function readSecret(config: AzureKvConfig, token: string, name: string): Promise<string | null> {
	const { statusCode, body } = await request(
		`${baseUrl(config)}/secrets/${encodeURIComponent(name)}?api-version=${API_VERSION}`,
		{ method: 'GET', headers: { authorization: `Bearer ${token}` } }
	);
	const text = await body.text();
	if (statusCode === 404) return null;
	if (statusCode < 200 || statusCode >= 300 || !isJsonResponse(text)) {
		throw new Error(`Azure Key Vault: failed to read secret "${name}" (HTTP ${statusCode})`);
	}
	const data = JSON.parse(text) as { value?: string };
	return data.value ?? null;
}

/** List every secret name in the vault (paginated), capped for safety. */
async function listSecretNames(config: AzureKvConfig, token: string): Promise<string[]> {
	const names: string[] = [];
	let url: string | null = `${baseUrl(config)}/secrets?api-version=${API_VERSION}&maxresults=25`;
	while (url && names.length < 500) {
		const { statusCode, body } = await request(url, {
			method: 'GET',
			headers: { authorization: `Bearer ${token}` }
		});
		const text = await body.text();
		if (statusCode < 200 || statusCode >= 300 || !isJsonResponse(text)) {
			throw new Error(`Azure Key Vault: cannot list secrets (HTTP ${statusCode})`);
		}
		const data = JSON.parse(text) as { value?: { id: string }[]; nextLink?: string | null };
		for (const item of data.value ?? []) {
			const name = item.id.split('/').pop();
			if (name) names.push(name);
		}
		url = data.nextLink ?? null;
	}
	return names;
}

export const azureKvProvider: SecretProvider<AzureKvConfig> = {
	type: 'azure-kv',
	label: 'Azure Key Vault',
	supportsReferences: true,
	supportsBulk: true,

	isReference(value: unknown): value is string {
		return typeof value === 'string' && AZURE_REF_RE.test(value.trim());
	},

	async testConnection(config: AzureKvConfig): Promise<TestConnectionResult> {
		try {
			assertSafeProviderHost(config.vaultUri, 'Azure Key Vault');
			const token = await getAccessToken(config);
			// A list call proves both auth AND that the vault URI is reachable/authorized.
			await listSecretNames(config, token);
			return { ok: true };
		} catch (e: unknown) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	},

	async resolveSecretReferences(
		config: AzureKvConfig,
		refs: string[],
		logPrefix = '[Azure Key Vault]'
	): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		if (refs.length === 0) return result;
		assertSafeProviderHost(config.vaultUri, 'Azure Key Vault');
		const token = await getAccessToken(config);
		// Unique names only - two refs to the same secret cost one call.
		const names = new Set(refs.map(refName));
		const values = new Map<string, string>();
		await Promise.all(
			[...names].map(async (name) => {
				try {
					const v = await readSecret(config, token, name);
					if (v !== null) values.set(name, v);
					else console.warn(`${logPrefix} Skipping azurekv://${name}: secret not found`);
				} catch (e) {
					console.warn(`${logPrefix} Skipping azurekv://${name}: ${e instanceof Error ? e.message : e}`);
				}
			})
		);
		for (const ref of refs) {
			const v = values.get(refName(ref));
			if (v !== undefined) result.set(ref, v);
		}
		return result;
	},

	// The selector is ignored: a Key Vault has no sub-paths, so a bulk pull is
	// always "every secret in the vault".
	async resolveBulk(config: AzureKvConfig, _selector: string): Promise<Record<string, string>> {
		assertSafeProviderHost(config.vaultUri, 'Azure Key Vault');
		const token = await getAccessToken(config);
		const names = await listSecretNames(config, token);
		const result: Record<string, string> = {};
		await Promise.all(
			names.map(async (name) => {
				const v = await readSecret(config, token, name);
				if (v !== null) result[name] = v;
			})
		);
		return result;
	}
};
