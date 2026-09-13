/**
 * HashiCorp Vault provider (KV v2).
 *
 * Talks to a Vault server's HTTP API to bulk-pull every key stored under a KV
 * v2 path. Vault has no universal inline reference syntax that fits arbitrary
 * Compose variables, so this provider is bulk-only: `supportsReferences` is
 * false and `resolveSecretReferences` throws {@link UnsupportedOperationError}.
 *
 * Auth is a Vault token sent as `X-Vault-Token`. On Vault Enterprise / HCP a
 * namespace may be supplied and is forwarded as `X-Vault-Namespace`. The KV v2
 * mount defaults to `secret` and can be overridden per provider.
 *
 * Decrypted tokens stay inside this module for the duration of a call. Nothing
 * here writes to disk or to the database.
 *
 * Vault OSS is integration-testable against a dev server (`vault server -dev`);
 * the unit tests mock undici's `request`.
 */

import { request } from 'undici';
import { UnsupportedOperationError, assertSafeProviderHost, sanitizeSelectorPath, parseProviderError, isJsonResponse } from './shared';
import type { SecretProvider, TestConnectionResult, VaultConfig } from './shared';

/** Undici response body handle, derived so we don't import undici's types. */
type ResponseBody = Awaited<ReturnType<typeof request>>['body'];

/** Shape of a KV v2 read: the secret map lives at `data.data`. */
interface KvV2ReadResponse {
	data?: {
		data?: Record<string, unknown>;
		metadata?: unknown;
	};
}

/** `${address}/v1`, with any trailing slash on the address removed. */
function apiBase(config: VaultConfig): string {
	assertSafeProviderHost(config.address, 'HashiCorp Vault');
	return `${config.address.replace(/\/$/, '')}/v1`;
}

/** Auth headers, plus the namespace header on Enterprise / HCP. */
function authHeaders(config: VaultConfig): Record<string, string> {
	const headers: Record<string, string> = {
		'X-Vault-Token': config.token
	};
	if (config.namespace) {
		headers['X-Vault-Namespace'] = config.namespace;
	}
	return headers;
}

/**
 * Reads a Vault error body into a short human string. Vault returns
 * `{ "errors": [...] }`; falls back to raw (truncated) text otherwise. Never
 * throws — callers use it only to enrich an already-failing path.
 */
async function readErrorDetail(body: ResponseBody): Promise<string> {
	try {
		const text = await body.text();
		if (!text) {
			return '';
		}
		try {
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
				return parsed.errors.join('; ');
			}
		} catch {
			// Not JSON — fall through to the raw body.
		}
		return text.trim().slice(0, 500);
	} catch {
		return '';
	}
}

export const vaultProvider: SecretProvider<VaultConfig> = {
	type: 'vault',
	label: 'HashiCorp Vault',
	supportsReferences: false,
	supportsBulk: true,

	isReference(_value: unknown): _value is string {
		// Bulk-only backend: nothing is treated as an inline reference.
		return false;
	},

	async testConnection(config: VaultConfig): Promise<TestConnectionResult> {
		if (!config.address?.trim()) {
			return { ok: false, error: 'Address is empty' };
		}
		if (!config.token?.trim()) {
			return { ok: false, error: 'Token is empty' };
		}
		try {
			// Read the KV v2 mount config: validates host + token + the configured mount
			// in one authenticated call - the same properties deploy (resolveBulk) uses. A
			// wrong mount 404s and a bad token 403s, so both fail Test instead of passing.
			const mount = encodeURIComponent(config.mount || 'secret');
			const { statusCode, body } = await request(`${apiBase(config)}/${mount}/config`, {
				method: 'GET',
				headers: authHeaders(config)
			});
			const rawBody = await body.text().catch(() => '');
			if (statusCode >= 200 && statusCode < 300) {
				// A 2xx alone isn't proof: a parked domain / proxy can answer 200 with HTML.
				if (!isJsonResponse(rawBody)) {
					return { ok: false, error: 'Vault did not return a JSON response - the host may not be a Vault server' };
				}
				return { ok: true };
			}
			// Log the full upstream body server-side; show the client only a message
			// parsed from Vault's own {errors:[...]} shape (a non-Vault host probed via
			// SSRF returns other text that won't parse, so nothing leaks).
			if (rawBody) console.warn(`[HashiCorp Vault] mount config ${mount} ${statusCode}: ${rawBody}`);
			const safe = parseProviderError(rawBody);
			return {
				ok: false,
				error: `Vault returned ${statusCode}${safe ? `: ${safe}` : ''}`
			};
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			return { ok: false, error: message || 'Connection failed' };
		}
	},

	async resolveSecretReferences(
		_config: VaultConfig,
		_refs: string[],
		_logPrefix?: string
	): Promise<Map<string, string>> {
		throw new UnsupportedOperationError(
			'HashiCorp Vault does not support inline references; use bulk pull (KV v2 path).'
		);
	},

	async resolveBulk(config: VaultConfig, selector: string): Promise<Record<string, string>> {
		const mount = encodeURIComponent(config.mount || 'secret');
		const path = sanitizeSelectorPath(selector, 'HashiCorp Vault');
		const { statusCode, body } = await request(`${apiBase(config)}/${mount}/data/${path}`, {
			method: 'GET',
			headers: authHeaders(config)
		});

		// A missing bulk selector is a real failure (unlike a single skipped ref).
		if (statusCode === 404) {
			await body.dump();
			throw new Error(`HashiCorp Vault: KV v2 path not found: ${mount}/${path}`);
		}
		if (statusCode < 200 || statusCode >= 300) {
			const detail = await readErrorDetail(body);
			if (detail) console.warn(`[HashiCorp Vault] read ${mount}/${path} ${statusCode}: ${detail}`);
			throw new Error(
				`HashiCorp Vault: read failed for ${mount}/${path} (status ${statusCode})${detail ? `: ${detail}` : ''}`
			);
		}

		const payload = (await body.json()) as KvV2ReadResponse;
		const data = payload.data?.data ?? {};
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(data)) {
			result[key] = typeof value === 'string' ? value : String(value);
		}
		return result;
	}
};
