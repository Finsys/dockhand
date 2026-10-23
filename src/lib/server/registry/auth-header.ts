/**
 * The Registry V2 auth handshake for registry API requests: the /v2/ challenge, then
 * a token from the realm it names. Kept apart from docker.ts so it can be driven by a
 * fake fetch in tests.
 */
import { fetchRegistryToken, isSafeRegistryHost } from '../registry-auth';
import { drainResponse } from '../notifications/shared';
import { registryRequestSignal } from './request-timeout';
import { authCacheKey, bearerTtlMs, NO_TOKEN_TTL_MS, registryAuthCache, type AuthOutcome } from './auth-cache';

export interface RegistryAuthDeps {
	/** Split a registry URL into its host and protocol. */
	parseRegistryUrl: (url: string) => { host: string; protocol: string };
	/** Injectable for tests; defaults to global fetch. */
	fetch?: typeof fetch;
	/** One deadline for the challenge and the token request together. */
	signal?: AbortSignal;
	/** false: always ask the registry, for callers that do not drop a rejected header. */
	cache?: boolean;
}

/**
 * Authorization header value ('Bearer ...' or 'Basic ...') for a registry, or null
 * when none is needed or none could be obtained.
 */
export async function registryAuthHeader(
	registryUrl: string,
	scope: string,
	credentials: { username: string; password: string } | null | undefined,
	deps: RegistryAuthDeps
): Promise<string | null> {
	const doFetch = deps.fetch ?? fetch;
	try {
		// Parse URL to extract host (V2 API is always at the host root)
		const parsed = deps.parseRegistryUrl(registryUrl);
		const hostSafety = isSafeRegistryHost(parsed.host);
		if (!hostSafety.ok) {
			console.error(`[Registry] Refusing auth challenge for ${parsed.host}: ${hostSafety.reason}`);
			return null;
		}
		const apiBaseUrl = `${parsed.protocol}://${parsed.host}`;

		const handshake = async (signal: AbortSignal | undefined): Promise<AuthOutcome> => {
			// Step 1: Challenge request to /v2/ (always at registry root, not under org path).
			// Do not follow redirects; a 3xx is treated as a non-401 below.
			const challengeResponse = await doFetch(`${apiBaseUrl}/v2/`, {
				method: 'GET',
				headers: { 'User-Agent': 'Dockhand/1.0' },
				redirect: 'manual',
				signal
			});

			// If 200, no auth needed
			if (challengeResponse.ok) {
				await drainResponse(challengeResponse);
				return { header: null, ttlMs: NO_TOKEN_TTL_MS };
			}

			// If not 401, something else is wrong
			if (challengeResponse.status !== 401) {
				await drainResponse(challengeResponse);
				console.error(`Registry challenge failed: ${challengeResponse.status}`);
				return { header: null, ttlMs: 0 };
			}

			// Step 2: Parse WWW-Authenticate header
			const wwwAuth = challengeResponse.headers.get('WWW-Authenticate') || '';
			const challenge = wwwAuth.toLowerCase();

			if (challenge.startsWith('basic')) {
				// Basic auth - use credentials if we have them
				await drainResponse(challengeResponse);
				if (credentials) {
					const basicAuth = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
					return { header: `Basic ${basicAuth}`, ttlMs: NO_TOKEN_TTL_MS };
				}
				return { header: null, ttlMs: NO_TOKEN_TTL_MS };
			}

			if (!challenge.startsWith('bearer')) {
				await drainResponse(challengeResponse);
				console.error(`Unsupported auth type: ${wwwAuth}`);
				return { header: null, ttlMs: 0 };
			}

			// Drain 401 response body before bearer token fetch (required by Node.js/Undici for connection reuse)
			await drainResponse(challengeResponse);

			// Parse bearer challenge: Bearer realm="...",service="...",scope="..."
			const realmMatch = wwwAuth.match(/realm="([^"]+)"/i);
			const serviceMatch = wwwAuth.match(/service="([^"]+)"/i);

			if (!realmMatch) {
				console.error('No realm in WWW-Authenticate header');
				return { header: null, ttlMs: 0 };
			}

			const realm = realmMatch[1];
			const service = serviceMatch ? serviceMatch[1] : '';

			// Step 3: Request token from realm (with credentials if available).
			// Empty scope is allowed - means "no specific resource permission".
			// Useful for credential validation: some registries (Docker Hub)
			// reject privileged scopes like registry:catalog:* even for valid
			// users, so omitting scope is the only reliable login check.
			const tokenUrl = new URL(realm);
			if (service) tokenUrl.searchParams.set('service', service);
			if (scope) tokenUrl.searchParams.set('scope', scope);

			const authHeader = credentials
				? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
				: null;
			const tokenResponse = await fetchRegistryToken(tokenUrl.toString(), authHeader, (url, init) => doFetch(url, { ...init, signal }));

			if (!tokenResponse.ok) {
				const errorBody = (await tokenResponse.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ').trim();
				const finalNote = tokenResponse.url && tokenResponse.url !== tokenUrl.toString()
					? ` (final ${new URL(tokenResponse.url).origin})`
					: '';
				const identity = credentials
					? ` as ${credentials.username.slice(0, 4)}...(len=${credentials.username.length})`
					: ' anonymously';
				console.error(`[Registry] Token request failed: ${tokenResponse.status} at ${tokenUrl.origin}${finalNote}, sent${identity}${errorBody ? ` - response: ${errorBody}` : ''}`);
				return { header: null, ttlMs: 0 };
			}

			const tokenData = await tokenResponse.json() as { token?: string; access_token?: string; expires_in?: number };
			const token = tokenData.token || tokenData.access_token || null;

			return token ? { header: `Bearer ${token}`, ttlMs: bearerTtlMs(tokenData.expires_in) } : { header: null, ttlMs: 0 };
		};
		// An empty scope is a login check (Test connection): always ask the registry.
		if (!scope || deps.cache === false) return (await handshake(deps.signal)).header;
		// The shared handshake gets its own deadline; the caller's signal bounds only its wait.
		return await registryAuthCache.get(
			authCacheKey(apiBaseUrl, scope, credentials),
			(shared) => handshake(registryRequestSignal(shared)),
			deps.signal
		);

	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		const cause = (e as any)?.cause;
		const causeMsg = cause ? ` (cause: ${cause})` : '';
		console.error('[Registry] Failed to get auth header:', errorMsg + causeMsg);
		return null;
	}
}
