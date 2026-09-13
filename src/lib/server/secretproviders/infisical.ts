/**
 * Infisical provider.
 *
 * Talks to an Infisical instance (Infisical Cloud or self-hosted) over its
 * public REST API to bulk-pull every secret under a project / environment /
 * path. Infisical has no inline compose-reference syntax (no op://-style
 * marker), so this provider is bulk-only: `resolveSecretReferences` is
 * unsupported and `isReference` is always false.
 *
 * Two auth shapes are supported (see InfisicalConfig):
 *   - a static `token`, sent as-is as `Authorization: Bearer <token>`.
 *   - a Machine Identity (`clientId` + `clientSecret`), exchanged for a
 *     short-lived access token via Universal Auth
 *     (POST /api/v1/auth/universal-auth/login). The access token is cached per
 *     host+clientId until shortly before it expires, so a batch of calls against
 *     the same identity logs in once, not per call.
 *
 * Decrypted tokens/credentials stay inside this module for the duration of a
 * call (or, for Universal Auth access tokens, inside the in-memory cache below).
 * Nothing here writes to disk or to the database.
 */

import { request } from 'undici';
import type { InfisicalConfig, SecretProvider, TestConnectionResult } from './shared';
import { assertSafeProviderHost, parseProviderError, isJsonResponse } from './shared';
import { UnsupportedOperationError } from './shared';

/** Shape of a single secret in the /api/v3/secrets/raw response. */
interface RawSecret {
	secretKey: string;
	secretValue: string;
}

/** The parts of the /api/v3/secrets/raw response Dockhand consumes. */
interface RawSecretsResponse {
	secrets?: RawSecret[];
}

/** Strips a trailing slash so `${base}${path}` never doubles up. */
function baseUrl(host: string): string {
	assertSafeProviderHost(host, 'Infisical');
	return host.replace(/\/$/, '');
}

/**
 * A service token (`st.<id>.<secret>`) carries its own project, environment and
 * secretPath (single non-glob scope), so `/secrets/raw` infers them from the token
 * and workspaceId/environment are optional. Every other auth shape (Universal Auth
 * access token, static non-`st.` token) requires workspaceId.
 */
function isServiceToken(token: string | undefined): boolean {
	return !!token && token.trim().startsWith('st.');
}

/**
 * Infisical infers project + environment from a service token only when its scope is
 * single and non-glob. A multi-scope or glob-path token still needs an explicit
 * workspaceId, and Infisical answers a bare 400 - so when a service-token config with no
 * projectId gets a 4xx, point the user at the real cause.
 */
function multiScopeHint(statusCode: number, config: InfisicalConfig): string {
	if (statusCode === 400 && isServiceToken(config.token) && !config.projectId?.trim()) {
		return ' - a multi-scope or glob-path service token still needs a Project ID; set it in the provider config';
	}
	return '';
}

/**
 * Builds the /api/v3/secrets/raw URL. The secret path defaults to `/` (Infisical's
 * root). workspaceId/environment are omitted when empty so a service token can infer
 * them from its own scope. `expandSecretReferences=true` makes Infisical resolve
 * native secret references (a value like `${OTHER}`) to their final value server-side;
 * this endpoint leaves them raw by default, which would inject the literal reference.
 */
function rawSecretsUrl(
	host: string,
	workspaceId: string | undefined,
	environment: string | undefined,
	secretPath: string
): string {
	const params = new URLSearchParams({
		secretPath: secretPath || '/',
		expandSecretReferences: 'true'
	});
	if (workspaceId) params.set('workspaceId', workspaceId);
	if (environment) params.set('environment', environment);
	return `${baseUrl(host)}/api/v3/secrets/raw?${params.toString()}`;
}

/** The parts of the Universal Auth login response Dockhand consumes. */
interface UniversalAuthLoginResponse {
	accessToken?: string;
	expiresIn?: number;
	accessTokenMaxTTL?: number;
}

/** Builds the Universal Auth login URL for a host. */
function universalAuthLoginUrl(host: string): string {
	return `${baseUrl(host)}/api/v1/auth/universal-auth/login`;
}

/**
 * In-memory cache of Universal Auth access tokens, keyed by `${host}::${clientId}`
 * so distinct identities (or the same identity against distinct hosts, e.g. a
 * self-hosted staging vs. prod instance) never share a token. Module-scoped and
 * process-lifetime: a batch of calls against the same identity logs in once.
 */
interface CachedAccessToken {
	accessToken: string;
	/** Epoch ms after which the cached token is treated as expired. */
	expiresAt: number;
}
const universalAuthTokenCache = new Map<string, CachedAccessToken>();

/** Cache key for a Universal Auth identity: host + client ID. */
function tokenCacheKey(host: string, clientId: string): string {
	return `${baseUrl(host)}::${clientId}`;
}

/**
 * Refresh margin subtracted from the reported TTL so a token already close to
 * expiry is not handed out and immediately rejected by the next call.
 */
const TOKEN_REFRESH_MARGIN_SECONDS = 60;
/**
 * Fallback TTL when Infisical's response omits both `expiresIn` and
 * `accessTokenMaxTTL` - short enough that a mis-parsed response degrades to
 * "log in almost every time" rather than "cache a token indefinitely".
 */
const DEFAULT_TOKEN_TTL_SECONDS = 300;

/**
 * Exchanges a Machine Identity's client ID + client secret for a short-lived
 * access token via Universal Auth. Throws on any non-2xx response or a response
 * missing `accessToken` - both are auth/config failures, not cases to silently
 * fall back from.
 */
async function universalAuthLogin(
	host: string,
	clientId: string,
	clientSecret: string
): Promise<CachedAccessToken> {
	const { statusCode, body } = await request(universalAuthLoginUrl(host), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ clientId, clientSecret })
	});

	if (statusCode < 200 || statusCode >= 300) {
		const detail = await body.text().catch(() => '');
		throw new Error(
			`[Infisical] Universal Auth login failed with HTTP ${statusCode}${detail ? `: ${parseProviderError(detail) ?? ''}` : ''}`
		);
	}

	const payload = (await body.json()) as UniversalAuthLoginResponse;
	if (!payload.accessToken) {
		throw new Error('[Infisical] Universal Auth login response did not include an accessToken');
	}

	const ttlSeconds = payload.expiresIn ?? payload.accessTokenMaxTTL ?? DEFAULT_TOKEN_TTL_SECONDS;
	const safeTtlSeconds = Math.max(ttlSeconds - TOKEN_REFRESH_MARGIN_SECONDS, 0);
	return {
		accessToken: payload.accessToken,
		expiresAt: Date.now() + safeTtlSeconds * 1000
	};
}

/**
 * Resolves the bearer token to use for a request: a cached (or freshly fetched)
 * Universal Auth access token when `clientId`/`clientSecret` are configured,
 * otherwise the static `token`. Assumes the caller already ran authConfigError
 * so at least one auth shape is present and complete.
 */
async function resolveAccessToken(config: InfisicalConfig): Promise<string> {
	const host = config.host?.trim() ?? '';
	const clientId = config.clientId?.trim();
	const clientSecret = config.clientSecret?.trim();

	if (clientId && clientSecret) {
		const key = tokenCacheKey(host, clientId);
		const cached = universalAuthTokenCache.get(key);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.accessToken;
		}
		const fresh = await universalAuthLogin(host, clientId, clientSecret);
		universalAuthTokenCache.set(key, fresh);
		return fresh.accessToken;
	}

	// authConfigError guarantees a non-empty token reaches this branch.
	return config.token!.trim();
}

/**
 * Validates that the config carries exactly one complete auth shape (static
 * token, or a Universal Auth clientId+clientSecret pair). Returns a
 * human-readable error, or null when the config is usable. No network call.
 */
function authConfigError(config: InfisicalConfig): string | null {
	const token = config.token?.trim();
	const clientId = config.clientId?.trim();
	const clientSecret = config.clientSecret?.trim();

	if (clientId && !clientSecret) {
		return 'Client secret is required when a client ID is set';
	}
	if (clientSecret && !clientId) {
		return 'Client ID is required when a client secret is set';
	}
	if (!token && !(clientId && clientSecret)) {
		return 'Provide either an access token or a Universal Auth client ID and client secret';
	}
	return null;
}

/**
 * Test-only escape hatch: clears the Universal Auth access-token cache so tests
 * can assert a login happens exactly once/twice without bleed from a previous
 * test that used the same host+clientId. Not used by production code paths.
 */
export function __resetInfisicalUniversalAuthCacheForTests(): void {
	universalAuthTokenCache.clear();
}

export const infisicalProvider: SecretProvider<InfisicalConfig> = {
	type: 'infisical',
	label: 'Infisical',
	supportsReferences: false,
	supportsBulk: true,

	isReference(_value: unknown): _value is string {
		return false;
	},

	async testConnection(config: InfisicalConfig): Promise<TestConnectionResult> {
		const host = config.host?.trim();
		const projectId = config.projectId?.trim();
		const environment = config.environment?.trim();

		if (!host) {
			return { ok: false, error: 'Host is empty' };
		}
		const authError = authConfigError(config);
		if (authError) {
			return { ok: false, error: authError };
		}
		// A service token carries its own project + environment, so they are optional
		// for it; every other auth shape still requires them.
		const serviceToken = isServiceToken(config.token);
		if (!projectId && !serviceToken) {
			return { ok: false, error: 'Project ID is empty' };
		}
		if (!environment && !serviceToken) {
			return { ok: false, error: 'Environment is empty' };
		}

		try {
			const token = await resolveAccessToken(config);
			const { statusCode, body } = await request(
				rawSecretsUrl(host, projectId, environment, '/'),
				{
					method: 'GET',
					headers: { authorization: `Bearer ${token}` }
				}
			);
			// Drain the body; on failure log it server-side and show the client only a
			// message parsed from Infisical's own {message}/{messages} shape.
			const rawBody = await body.text().catch(() => '');
			if (statusCode >= 200 && statusCode < 300) {
				if (!isJsonResponse(rawBody)) {
					return { ok: false, error: 'Infisical did not return a JSON response - the host may not be an Infisical server' };
				}
				return { ok: true };
			}
			if (rawBody) console.warn(`[Infisical] testConnection ${statusCode}: ${rawBody}`);
			const safe = parseProviderError(rawBody);
			return { ok: false, error: `Infisical returned HTTP ${statusCode}${safe ? `: ${safe}` : ''}${multiScopeHint(statusCode, config)}` };
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			return { ok: false, error: message || 'Connection failed' };
		}
	},

	async resolveSecretReferences(): Promise<Map<string, string>> {
		throw new UnsupportedOperationError(
			'Infisical does not support inline references; use bulk pull (project/environment/path).'
		);
	},

	async resolveBulk(config: InfisicalConfig, selector: string): Promise<Record<string, string>> {
		const host = config.host?.trim();
		const projectId = config.projectId?.trim();
		const environment = config.environment?.trim();
		const secretPath = selector?.trim() || config.path?.trim() || '/';

		if (!host) {
			throw new Error('[Infisical] Host is required for a bulk pull');
		}
		const authError = authConfigError(config);
		if (authError) {
			throw new Error(`[Infisical] ${authError}`);
		}
		// A service token carries its own project + environment; every other auth shape
		// still requires them.
		const serviceToken = isServiceToken(config.token);
		if (!projectId && !serviceToken) {
			throw new Error('[Infisical] Project ID is required for a bulk pull');
		}
		if (!environment && !serviceToken) {
			throw new Error('[Infisical] Environment is required for a bulk pull');
		}

		const token = await resolveAccessToken(config);
		const { statusCode, body } = await request(
			rawSecretsUrl(host, projectId, environment, secretPath),
			{
				method: 'GET',
				headers: { authorization: `Bearer ${token}` }
			}
		);

		if (statusCode < 200 || statusCode >= 300) {
			// Drain the body, log it server-side, but never reflect it to the client.
			const detail = await body.text().catch(() => '');
			if (detail) console.warn(`[Infisical] bulk pull ${statusCode}: ${detail}`);
			throw new Error(`[Infisical] Bulk pull failed with HTTP ${statusCode}${multiScopeHint(statusCode, config)}`);
		}

		const payload = (await body.json()) as RawSecretsResponse;
		const result: Record<string, string> = {};
		for (const secret of payload.secrets ?? []) {
			if (secret?.secretKey !== undefined) {
				result[secret.secretKey] = secret.secretValue;
			}
		}
		return result;
	}
};
