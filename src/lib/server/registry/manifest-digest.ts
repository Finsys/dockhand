/**
 * Talking to a registry over HTTP: the auth challenge, the scheme a registry was
 * configured with, and the manifest digest behind a tag.
 *
 * None of this needs a Docker daemon, so it lives outside docker.ts and takes the
 * few things it cannot know - how a stored registry URL parses, which hosts are
 * Docker Hub, and where credentials come from - as injected ports. That keeps the
 * module free of a docker.ts import (which would be a cycle) and lets the tests
 * drive it with a fake fetch instead of a live registry.
 */

import { isSafeRegistryHost, fetchRegistryToken } from '../registry-auth';
import { describeRegistryFailure } from '../registry-failure-core';
import { drainResponse } from '../notifications/shared';
import { parseImageReference } from './image-ref';
import { resolveRegistryScheme, type StoredRegistryScheme } from '../registry-scheme-core';
import { registryRequestSignal } from './request-timeout';
import { authCacheKey, bearerTtlMs, forgetRegistryAuth, NO_TOKEN_TTL_MS, registryAuthCache, type AuthOutcome } from './auth-cache';

export interface RegistryCredentials {
	username: string;
	password: string;
}

/** What this module cannot work out on its own, supplied by the caller. */
export interface RegistryPorts {
	/** Split a stored registry URL into its host and protocol. */
	parseRegistryUrl: (url: string) => { host: string; protocol: string };
	/** The hostnames that mean Docker Hub. */
	hubHosts: ReadonlySet<string>;
	/** Every configured registry, for the scheme lookup. */
	listRegistries: () => Promise<{ url: string }[]>;
	/** Stored credentials for an image's registry host and repo, or null for anonymous access. */
	findCredentials: (registryHost: string, repo: string) => Promise<RegistryCredentials | null>;
	/** Injectable for tests; defaults to global fetch. */
	fetch?: typeof fetch;
	/** Per-request timeout in ms for the challenge, token and HEAD; tests shorten it. */
	requestTimeoutMs?: number;
}

function requestSignal(ports: RegistryPorts, signal?: AbortSignal): AbortSignal {
	return registryRequestSignal(signal, ports.requestTimeoutMs);
}

const USER_AGENT = 'Dockhand/1.0';

const MANIFEST_ACCEPT = [
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
	'application/vnd.oci.image.manifest.v1+json'
].join(', ');

function basicAuth(credentials: RegistryCredentials): string {
	return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

/**
 * Resolve http vs https for a registry host from the stored registries, so the
 * challenge/token request honours a plain-HTTP registry (#1580). Defaults to https.
 */
export async function getRegistrySchemeForHost(
	registryHost: string,
	ports: RegistryPorts
): Promise<'http' | 'https'> {
	try {
		const registries = await ports.listRegistries();
		const stored: StoredRegistryScheme[] = registries.map((reg) => {
			const parsed = ports.parseRegistryUrl(reg.url);
			return { host: parsed.host, protocol: parsed.protocol, isHub: ports.hubHosts.has(parsed.host) };
		});
		const requested = ports.parseRegistryUrl(registryHost);
		return resolveRegistryScheme(requested.host, stored, ports.hubHosts.has(requested.host));
	} catch {
		return 'https';
	}
}

/**
 * Get bearer token from registry using challenge-response flow.
 * This follows the Docker Registry v2 authentication spec:
 * 1. Make request to /v2/ to get WWW-Authenticate challenge
 * 2. Parse realm, service, scope from challenge
 * 3. Request token from realm URL (with credentials if available)
 */
export async function getRegistryBearerToken(
	registry: string,
	repo: string,
	ports: RegistryPorts,
	signal?: AbortSignal
): Promise<string | null> {
	const doFetch = ports.fetch ?? fetch;
	try {
		const hostSafety = isSafeRegistryHost(registry);
		if (!hostSafety.ok) {
			console.error(`[Registry] Refusing token request for ${registry}: ${hostSafety.reason}`);
			return null;
		}
		// Honour the scheme the registry was configured with (#1580): a plain-HTTP local
		// registry must not get an HTTPS challenge. Defaults to https when unconfigured.
		const scheme = await getRegistrySchemeForHost(registry, ports);
		const registryUrl = `${scheme}://${registry}`;

		const credentials = await ports.findCredentials(registry, repo);

		const scope = `repository:${repo}:pull`;
		return await registryAuthCache.get(authCacheKey(registryUrl, scope, credentials), async (shared): Promise<AuthOutcome> => {
			// Step 1: Challenge request to /v2/
			// Do not follow redirects on the challenge; a 3xx is treated as a non-401 below.
			const challengeResponse = await doFetch(`${registryUrl}/v2/`, {
				method: 'GET',
				headers: { 'User-Agent': USER_AGENT },
				signal: requestSignal(ports, shared),
				redirect: 'manual'
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
				await drainResponse(challengeResponse);
				return { header: credentials ? basicAuth(credentials) : null, ttlMs: NO_TOKEN_TTL_MS };
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

			const authHeader = credentials ? basicAuth(credentials) : null;
			const tokenResponse = await fetchRegistryToken(tokenUrl.toString(), authHeader, (url, init) =>
				doFetch(url, { ...init, signal: requestSignal(ports, shared) })
			);

			if (!tokenResponse.ok) {
				// Surface enough to diagnose without leaking the secret: the response
				// body (truncated), the final URL, and the identity (username only).
				const errBody = (await tokenResponse.text()).slice(0, 300).replace(/\s+/g, ' ').trim();
				const finalNote =
					tokenResponse.url && tokenResponse.url !== tokenUrl.toString()
						? ` (final ${new URL(tokenResponse.url).origin})`
						: '';
				const identity = credentials
					? ` as ${credentials.username.slice(0, 4)}...(len=${credentials.username.length})`
					: ' anonymously';
				console.error(
					`[Registry] Token request failed: ${tokenResponse.status} at ${tokenUrl.origin}${finalNote}, sent${identity}` +
						(errBody ? ` - response: ${errBody}` : '')
				);
				return { header: null, ttlMs: 0 };
			}

			const tokenData = (await tokenResponse.json()) as { token?: string; access_token?: string; expires_in?: number };
			const token = tokenData.token || tokenData.access_token || null;

			return token ? { header: `Bearer ${token}`, ttlMs: bearerTtlMs(tokenData.expires_in) } : { header: null, ttlMs: 0 };
		}, signal);
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		const cause = (e as any)?.cause;
		const causeMsg = cause ? ` (cause: ${cause})` : '';
		console.error('[Registry] Failed to get bearer token:', errorMsg + causeMsg);
		const causeStr = String(cause ?? errorMsg);
		if (causeStr.includes('EAI_AGAIN') || causeStr.includes('ENOTFOUND')) {
			console.error('[Registry] DNS resolution failed. If you are on a NAS (Synology, uGreen, QNAP), try adding --dns=8.8.8.8 to your docker run command or set {"dns": ["8.8.8.8"]} in /etc/docker/daemon.json');
		}
		return null;
	}
}

/** Direct registry request with upstream diagnostic details. */
export async function getRegistryManifestDigestDirectDetailed(
	imageName: string,
	ports: RegistryPorts,
	signal?: AbortSignal
): Promise<{ digest: string | null; reason?: string }> {
	const doFetch = ports.fetch ?? fetch;
	let registry = '';
	try {
		const parsed = parseImageReference(imageName);
		registry = parsed.registry;
		const { repo } = parsed;
		const tag = imageName.includes('@') ? imageName.split('@').pop()! : parsed.tag;
		if (!isSafeRegistryHost(registry).ok) {
			return { digest: null, reason: describeRegistryFailure({ kind: 'blocked-host', registry }) };
		}
		const token = await getRegistryBearerToken(registry, repo, ports, signal);
		// Honour the stored registry scheme for the manifest fetch too (#1580), not just
		// the token challenge - otherwise a plain-HTTP registry still gets an HTTPS request.
		const scheme = await getRegistrySchemeForHost(registry, ports);
		const manifestUrl = `${scheme}://${registry}/v2/${repo}/manifests/${tag}`;

		const headers: Record<string, string> = {
			'User-Agent': USER_AGENT,
			'Accept': MANIFEST_ACCEPT
		};
		if (token) headers['Authorization'] = token;

		const response = await doFetch(manifestUrl, { method: 'HEAD', headers, signal: requestSignal(ports, signal) });

		if (!response.ok) {
			await drainResponse(response);
			if (response.status === 401) forgetRegistryAuth(token, registry);
			const retryAfter = response.headers.get('Retry-After');
			if (response.status === 429) {
				console.warn(`[Registry] ${imageName}: rate limited (429)${retryAfter ? `, retry after ${retryAfter}s` : ''}`);
			} else {
				console.error(`[Registry] ${imageName}: ${response.status}`);
			}
			return {
				digest: null,
				reason: describeRegistryFailure({ kind: 'http', status: response.status, retryAfter })
			};
		}

		const digest = response.headers.get('Docker-Content-Digest');
		await drainResponse(response);
		if (!digest) return { digest: null, reason: describeRegistryFailure({ kind: 'no-digest' }) };
		return { digest };
	} catch (e) {
		const causeStr = String((e as any)?.cause ?? e);
		if (causeStr.includes('EAI_AGAIN') || causeStr.includes('ENOTFOUND')) {
			console.error(`[Registry] ${imageName}: DNS resolution failed. If you are on a NAS (Synology, uGreen, QNAP), add --dns=8.8.8.8 to your docker run command.`);
		} else {
			console.error(`[Registry] ${imageName}: ${e}`);
		}
		return {
			digest: null,
			reason: describeRegistryFailure({ kind: 'error', registry: registry || imageName, error: e })
		};
	}
}

/**
 * One manifest read for the multi-arch check. `body: null` means the registry has no index
 * under that reference (404 under an index-only Accept: a single-arch manifest, or a digest
 * that is not an index) - an answer, not a failure. A failure carries its reason and
 * whether a second attempt could change it (network, timeout, unreadable body, 429, 5xx).
 */
export type IndexRead =
	| { ok: true; body: unknown | null }
	| { ok: false; reason: string; retryable: boolean };

/** Read a manifest/index by tag or digest with an index-only Accept. Never throws. */
export async function readManifestIndex(
	registry: string,
	repo: string,
	reference: string,
	token: string | null,
	scheme: string,
	doFetch: typeof fetch = fetch,
	timeoutMs = 8000
): Promise<IndexRead> {
	const headers: Record<string, string> = {
		'User-Agent': USER_AGENT,
		'Accept': [
			'application/vnd.docker.distribution.manifest.list.v2+json',
			'application/vnd.oci.image.index.v1+json'
		].join(', ')
	};
	if (token) headers['Authorization'] = token;
	let response: Response;
	try {
		response = await doFetch(`${scheme}://${registry}/v2/${repo}/manifests/${reference}`, {
			method: 'GET',
			headers,
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (error) {
		return { ok: false, retryable: true, reason: describeRegistryFailure({ kind: 'error', registry, error }) };
	}
	if (!response.ok) {
		const { status } = response;
		const retryAfter = response.headers.get('Retry-After');
		await drainResponse(response);
		if (status === 401) forgetRegistryAuth(token, registry);
		// Under an index-only Accept, ghcr answers a single-arch manifest with 404: not an index, not a failure.
		if (status === 404) return { ok: true, body: null };
		return { ok: false, retryable: status === 429 || status >= 500, reason: describeRegistryFailure({ kind: 'http', status, retryAfter }) };
	}
	try {
		return { ok: true, body: await response.json() };
	} catch (error) {
		return { ok: false, retryable: true, reason: describeRegistryFailure({ kind: 'error', registry, error }) };
	}
}
