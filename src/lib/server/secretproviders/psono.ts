/**
 * Psono provider (self-hosted or psono.pw).
 *
 * Reads secrets through Psono's SESSIONLESS api-key access with LOCAL decryption:
 * `POST /api-key-access/inspect/` lists what an API key grants, `POST
 * /api-key-access/secret/` returns each secret still encrypted, and the content is
 * decrypted here with xsalsa20-poly1305. The API key's secret key NEVER leaves this
 * server - sending it would be Psono's "remote decryption", which their own
 * documentation discourages and which requires the key to allow insecure access.
 *
 * There is no session login, so nothing to renew and no handshake. The cost is that
 * a key reaches only the secrets it was explicitly given: the bulk selector is the
 * key itself, not a folder. Listing a whole datastore would need a session with an
 * unrestricted key, which is a much wider grant than reading a stack's secrets.
 *
 * Psono has no bulk endpoint, so a pull is one inspect plus one request per secret,
 * bounded by BULK_CONCURRENCY. Every read increments the secret's `read_count`
 * server-side, so reads are visible in Psono's own audit trail.
 */

import { request } from 'undici';
import type { PsonoConfig, SecretProvider, TestConnectionResult } from './shared';
import {
	assertSafeProviderHost,
	parseProviderError,
	isJsonResponse
} from './shared';
import {
	decryptSecret,
	secretToEnvVar,
	envVarsSecretToEntries,
	safeKeyForLog,
	parsePsonoReference,
	isPsonoReference,
	referenceValue,
	keyPermissionWarning,
	inspectedSecretIds,
	type PsonoEncryptedSecret,
	type PsonoKeyInspection
} from './psono-core';

/** Psono has no batch endpoint, so a pull is one request per secret; this bounds them. */
const BULK_CONCURRENCY = 8;

/**
 * The API base. Psono serves its API under `/server`, not at the root, so a URL
 * without it is almost certainly a mistake worth correcting for the user rather
 * than failing on.
 */
function baseUrl(config: PsonoConfig): string {
	const raw = (config.serverUrl ?? '').trim().replace(/\/+$/, '');
	if (!raw) throw new Error('Psono: the server URL is empty');
	assertSafeProviderHost(raw, 'Psono');
	return /\/server$/.test(raw) ? raw : `${raw}/server`;
}

async function psonoPost<T>(
	config: PsonoConfig,
	path: string,
	payload: Record<string, string>
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
	const { statusCode, body } = await request(`${baseUrl(config)}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	const raw = await body.text().catch(() => '');
	if (statusCode >= 200 && statusCode < 300) {
		if (!isJsonResponse(raw)) {
			return {
				ok: false,
				status: statusCode,
				error: 'Psono did not return a JSON response - check that the server URL points at a Psono server'
			};
		}
		return { ok: true, data: JSON.parse(raw) as T };
	}
	if (raw) console.warn(`[Psono] ${path} ${statusCode}: ${raw}`);
	// Only a recognised provider error shape reaches the client. The SSRF guard allows
	// LAN hosts, so a serverUrl pointed at some other internal service would otherwise
	// reflect THAT service's response body into the UI and the deploy log. Psono's own
	// errors are a JSON string or a {field: [msg]} map, both of which parse; anything
	// else is identified by its status alone. The full body is in the server log above.
	const safe = parseProviderError(raw) ?? psonoErrorCode(raw);
	return { ok: false, status: statusCode, error: safe };
}

/**
 * Psono's own error, when it sent one in a shape we recognise.
 *
 * Its sessionless endpoints render errors through a plain renderer, so the body is a
 * JSON-encoded STRING (`"NO_PERMISSION_OR_NOT_EXIST"`) rather than the object
 * parseProviderError looks for. Only an uppercase error CODE is accepted - never
 * arbitrary text - so a non-Psono host on the LAN cannot have its body echoed back.
 */
function psonoErrorCode(raw: string): string {
	const code = (v: unknown): string =>
		typeof v === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(v.trim()) ? v.trim() : '';
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Not JSON at all: accept a bare code, which its plain renderer also emits,
		// but nothing else - that is what keeps a foreign host's body out.
		return code(raw);
	}
	if (typeof parsed === 'string') return code(parsed);
	// Its DRF validation errors arrive as {field: ["CODE", ...]}; take the first code
	// any field carries, so a known refusal is still named.
	if (parsed && typeof parsed === 'object') {
		for (const v of Object.values(parsed as Record<string, unknown>)) {
			const hit = Array.isArray(v) ? v.map(code).find(Boolean) : code(v);
			if (hit) return hit;
		}
	}
	return '';
}

/** Turns a failed call into the message an administrator can act on. */
function readFailure(status: number, error: string): string {
	if (status === 400 && /NO_PERMISSION_OR_NOT_EXIST/i.test(error)) {
		// Psono deliberately conflates "wrong id", "not attached to this key" and
		// "no rights", so the message has to name all three.
		return 'Psono refused the read: the secret is not attached to this API key, the id is wrong, or the key has no rights on it';
	}
	if (status === 400 && /INSECURE_ACCESS_NOT_ALLOWED/i.test(error)) {
		return 'Psono rejected the request as insecure access - this is a bug in Dockhand, which must never send the API key secret';
	}
	return `Psono returned HTTP ${status}${error ? `: ${error}` : ''}`;
}

/** Fetches one secret, still sealed. */
async function fetchSecret(
	config: PsonoConfig,
	secretId: string,
	logPrefix: string
): Promise<{ ok: true; data: PsonoEncryptedSecret } | { ok: false; error: string }> {
	const res = await psonoPost<PsonoEncryptedSecret>(config, '/api-key-access/secret/', {
		api_key_id: config.apiKeyId.trim(),
		secret_id: secretId
	});
	if (res.ok) return { ok: true, data: res.data };
	const error = readFailure(res.status, res.error);
	console.warn(`${logPrefix} ${secretId}: ${error}`);
	return { ok: false, error };
}

/** Fetches and decrypts one secret, or null when it cannot be read. */
async function readSecret(
	config: PsonoConfig,
	secretId: string,
	logPrefix: string
): Promise<unknown | null> {
	const fetched = await fetchSecret(config, secretId, logPrefix);
	if (!fetched.ok) return null;
	try {
		return decryptSecret(fetched.data, config.apiKeySecretKey.trim());
	} catch (e: unknown) {
		// A decryption failure is a configuration problem (wrong secret key), not a
		// transport one, so it is reported per secret and the pull carries on.
		console.warn(`${logPrefix} ${secretId}: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

/** Runs tasks with a bounded number in flight. */
async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}

async function inspect(
	config: PsonoConfig
): Promise<{ ok: true; data: PsonoKeyInspection } | { ok: false; error: string }> {
	const res = await psonoPost<PsonoKeyInspection>(config, '/api-key-access/inspect/', {
		api_key_id: config.apiKeyId.trim()
	});
	if (res.ok) return { ok: true, data: res.data };
	if (res.status === 400) {
		return {
			ok: false,
			error: 'Psono did not recognise the API key id, or the key is inactive'
		};
	}
	return { ok: false, error: `Psono returned HTTP ${res.status}${res.error ? `: ${res.error}` : ''}` };
}

export const psonoProvider: SecretProvider<PsonoConfig> = {
	type: 'psono',
	label: 'Psono',
	supportsReferences: true,
	supportsBulk: true,

	isReference(value: unknown): value is string {
		return isPsonoReference(value);
	},

	async testConnection(config: PsonoConfig): Promise<TestConnectionResult> {
		if (!config.serverUrl?.trim()) return { ok: false, error: 'Server URL is empty' };
		if (!config.apiKeyId?.trim()) return { ok: false, error: 'API key id is empty' };
		if (!config.apiKeySecretKey?.trim()) return { ok: false, error: 'API key secret key is empty' };
		try {
			const res = await inspect(config);
			if (!res.ok) return { ok: false, error: res.error };

			// Proving the key id exists is not enough: a wrong secret key only shows up
			// when something is actually decrypted, which is what deploys depend on.
			const ids = inspectedSecretIds(res.data);
			if (ids.length === 0) {
				return {
					ok: false,
					error: 'The API key grants no secrets. Attach the secrets it should read in Psono.'
				};
			}
			// Reading can fail for two different reasons and they need different advice:
			// the request being refused is a grant problem, while a request that
			// succeeded and then would not open is the secret key.
			const fetched = await fetchSecret(config, ids[0], '[Psono] testConnection');
			if (!fetched.ok) {
				return { ok: false, error: `Connected, but ${fetched.error}` };
			}
			try {
				decryptSecret(fetched.data, config.apiKeySecretKey.trim());
			} catch {
				return {
					ok: false,
					error: 'Connected and the secret was fetched, but it could not be decrypted - check the API key secret key'
				};
			}

			const warning = keyPermissionWarning(res.data);
			return warning ? { ok: true, warning } : { ok: true };
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			return { ok: false, error: message || 'Connection failed' };
		}
	},

	/**
	 * Every secret the API key grants, as env vars.
	 *
	 * The selector is ignored: a restricted key already defines the scope, and Psono
	 * has no server-side folder filter for this access mode. A secret that cannot be
	 * read or named is skipped with a warning rather than failing the deploy, but a
	 * failure to reach the server at all propagates.
	 */
	async resolveBulk(config: PsonoConfig): Promise<Record<string, string>> {
		const res = await inspect(config);
		if (!res.ok) throw new Error(res.error);
		const ids = inspectedSecretIds(res.data);
		if (ids.length === 0) {
			console.warn('[Psono] bulk: the API key grants no secrets');
			return {};
		}
		const decrypted = await mapLimit(ids, BULK_CONCURRENCY, (id) =>
			readSecret(config, id, '[Psono] bulk').then((d) => ({ id, d }))
		);
		// Every single read failing is a configuration fault (a wrong secret key, a key
		// whose grants were revoked), not a vault that happens to be empty. Returning {}
		// would deploy the stack with its secrets missing and report success.
		if (decrypted.every((e) => e.d === null)) {
			throw new Error(
				`Psono: none of the ${ids.length} secret(s) this API key grants could be read - check the API key secret key`
			);
		}
		const out: Record<string, string> = {};
		const take = (name: string, value: string) => {
			if (out[name] !== undefined) {
				console.warn(`[Psono] bulk: ${name} appears more than once, keeping the first`);
				return;
			}
			out[name] = value;
		};
		for (const { id, d } of decrypted) {
			if (d === null) continue;
			// An Environment Variables secret holds many key/value pairs - inject each.
			const envVars = envVarsSecretToEntries(d);
			if (envVars !== null) {
				for (const key of envVars.skipped) {
					console.warn(`[Psono] bulk: ${id} env_vars key ${safeKeyForLog(key)} is not a valid variable name, skipped`);
				}
				for (const { name, value } of envVars.entries) take(name, value);
				continue;
			}
			const pair = secretToEnvVar(d);
			if (!pair) {
				console.warn(`[Psono] bulk: ${id} has no usable name/value pair, skipped`);
				continue;
			}
			take(pair.name, pair.value);
		}
		return out;
	},

	async resolveSecretReferences(
		config: PsonoConfig,
		refs: string[],
		logPrefix = '[Psono]'
	): Promise<Map<string, string>> {
		const parsed = refs
			.map((ref) => ({ ref, parsed: parsePsonoReference(ref) }))
			.filter((e): e is { ref: string; parsed: NonNullable<typeof e.parsed> } => e.parsed !== null);
		if (parsed.length === 0) return new Map();

		// One read per distinct secret, even when several refs name different fields
		// of it - each read is a round trip and bumps Psono's read_count.
		const byId = new Map<string, unknown | null>();
		const ids = [...new Set(parsed.map((e) => e.parsed.secretId))];
		const fetched = await mapLimit(ids, BULK_CONCURRENCY, (id) =>
			readSecret(config, id, logPrefix).then((d) => ({ id, d }))
		);
		for (const { id, d } of fetched) byId.set(id, d);

		const out = new Map<string, string>();
		for (const { ref, parsed: p } of parsed) {
			const decrypted = byId.get(p.secretId);
			if (decrypted === null || decrypted === undefined) continue;
			const value = referenceValue(decrypted, p.field);
			if (value === null) {
				console.warn(
					`${logPrefix} ${ref}: the secret has no ${p.field ?? 'value'} field, left as a literal`
				);
				continue;
			}
			out.set(ref, value);
		}
		return out;
	}
};
