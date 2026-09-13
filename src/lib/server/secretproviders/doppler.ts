/**
 * Doppler provider.
 *
 * Talks to Doppler's REST API to bulk-pull every secret in a config. Doppler has
 * no inline compose-reference syntax, so this provider is bulk-only:
 * `resolveSecretReferences` is unsupported and `isReference` is always false. A
 * SERVICE token (dp.st.) already identifies the project + config; a PERSONAL token
 * (dp.pt.) is account-wide and needs project/config supplied in the config. Either
 * way the DOCKHAND_SECRET_SELECTOR is ignored (the config, not the selector, is
 * the scope).
 *
 * Auth is a Doppler service token sent as `Authorization: Bearer <token>`. The
 * download endpoint returns a flat `{ KEY: value }` JSON map when asked for
 * `format=json`. `host` defaults to Doppler's SaaS API and is overridable only
 * for testing against a stub (Doppler is not self-hostable).
 *
 * Decrypted tokens stay inside this module for the duration of a call. Nothing
 * here writes to disk or to the database.
 */

import { request } from 'undici';
import type { DopplerConfig, SecretProvider, TestConnectionResult } from './shared';
import { assertSafeProviderHost, parseProviderError, isJsonResponse } from './shared';
import { UnsupportedOperationError } from './shared';

const DEFAULT_HOST = 'https://api.doppler.com';

/**
 * Keys Doppler injects into EVERY config's download - its own metadata about the
 * project/config the token is scoped to, not the user's secrets. We drop them so
 * they never leak into the stack's environment. (Confirmed against the live API:
 * every config returns exactly these three alongside the real secrets.)
 */
export const DOPPLER_META_KEYS = new Set(['DOPPLER_PROJECT', 'DOPPLER_CONFIG', 'DOPPLER_ENVIRONMENT']);

/** Strips a trailing slash so `${base}${path}` never doubles up. */
function baseUrl(host: string | undefined): string {
	const resolved = (host?.trim() || DEFAULT_HOST).replace(/\/$/, '');
	assertSafeProviderHost(resolved, 'Doppler');
	return resolved;
}

/**
 * The download URL. `include_dynamic_secrets=false` keeps the response a plain
 * flat map (dynamic secrets would nest). A service token already implies the
 * project/config; a personal token needs them as query params (else the API
 * returns 400). We append whichever were provided and let Doppler decide.
 */
function downloadUrl(config: DopplerConfig): string {
	let url = `${baseUrl(config.host)}/v3/configs/config/secrets/download?format=json&include_dynamic_secrets=false`;
	if (config.project?.trim()) url += `&project=${encodeURIComponent(config.project.trim())}`;
	if (config.config?.trim()) url += `&config=${encodeURIComponent(config.config.trim())}`;
	return url;
}

export const dopplerProvider: SecretProvider<DopplerConfig> = {
	type: 'doppler',
	label: 'Doppler',
	supportsReferences: false,
	supportsBulk: true,

	isReference(_value: unknown): _value is string {
		return false;
	},

	async testConnection(config: DopplerConfig): Promise<TestConnectionResult> {
		const token = config.token?.trim();
		if (!token) {
			return { ok: false, error: 'Token is empty' };
		}
		try {
			const { statusCode, body } = await request(downloadUrl(config), {
				method: 'GET',
				headers: { authorization: `Bearer ${token}` }
			});
			// Drain the body; on failure log it server-side and show the client only a
			// message parsed from Doppler's own {messages:[...]} shape.
			const rawBody = await body.text().catch(() => '');
			if (statusCode >= 200 && statusCode < 300) {
				if (!isJsonResponse(rawBody)) {
					return { ok: false, error: 'Doppler did not return a JSON response - the host may not be a Doppler server' };
				}
				return { ok: true };
			}
			if (rawBody) console.warn(`[Doppler] testConnection ${statusCode}: ${rawBody}`);
			const safe = parseProviderError(rawBody);
			return { ok: false, error: `Doppler returned HTTP ${statusCode}${safe ? `: ${safe}` : ''}` };
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			return { ok: false, error: message || 'Connection failed' };
		}
	},

	async resolveSecretReferences(): Promise<Map<string, string>> {
		throw new UnsupportedOperationError(
			'Doppler does not support inline references; a service token bulk-pulls its whole config.'
		);
	},

	async resolveBulk(config: DopplerConfig, _selector: string): Promise<Record<string, string>> {
		const token = config.token?.trim();
		if (!token) {
			throw new Error('[Doppler] Token is required for a bulk pull');
		}

		const { statusCode, body } = await request(downloadUrl(config), {
			method: 'GET',
			headers: { authorization: `Bearer ${token}` }
		});

		if (statusCode < 200 || statusCode >= 300) {
			const detail = await body.text().catch(() => '');
			throw new Error(`[Doppler] Bulk pull failed with HTTP ${statusCode}${detail ? `: ${detail}` : ''}`);
		}

		// format=json returns a flat { KEY: value } object; coerce non-string values
		// and drop Doppler's own metadata keys (DOPPLER_META_KEYS).
		const payload = (await body.json()) as Record<string, unknown>;
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(payload ?? {})) {
			if (DOPPLER_META_KEYS.has(key)) continue;
			if (value !== null && value !== undefined) {
				result[key] = typeof value === 'string' ? value : String(value);
			}
		}
		return result;
	}
};
