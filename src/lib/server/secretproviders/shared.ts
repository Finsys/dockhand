/**
 * Shared contract for secret providers.
 *
 * Dockhand is provider-agnostic about where secrets come from. A secret
 * provider knows how to authenticate against one backend (1Password, Infisical,
 * HashiCorp Vault, ...), and supports one or both resolution modes:
 *
 *   1. Reference interpolation — a variable's value is an inline reference in
 *      that backend's own syntax (e.g. 1Password's `op://vault/item/field`),
 *      which the provider replaces with the real secret. Detection of what
 *      counts as a reference is provider-specific (see `isReference`).
 *   2. Bulk pull — fetch every secret under a provider-defined selector (a
 *      1Password Environment id, an Infisical project/environment/path, a Vault
 *      kv path, ...) as a flat key/value map.
 *
 * Concrete providers live in sibling files and are registered in ./index.
 * Decrypted config (tokens, hosts) is passed in by the caller and never
 * persisted here — providers hold it only for the duration of a call.
 */

import { isSafeNotificationUrl } from '../url-safety';

/**
 * Identifies which backend a stored provider row talks to. Matches the
 * `secret_providers.type` column and the API. Kept as a widenable string union
 * so new backends can be added without a breaking type change.
 */
export type SecretProviderType =
	| 'op-service-account'
	| 'op-connect'
	| 'infisical'
	| 'vault'
	| 'doppler'
	| 'bitwarden'
	| 'proton'
	| 'azure-kv'
	| 'keepass'
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	| (string & {});

/**
 * SSRF guard for a provider's user-supplied host/address. A provider makes
 * server-side HTTP requests to whatever host the user configured, so an
 * unchecked value lets an authenticated user pivot at Dockhand's network
 * (cloud-metadata 169.254.169.254, loopback, internal services) and read the
 * response back through testConnection / the bulk pull. Same policy as
 * notifications: block loopback + cloud metadata, allow ordinary LAN ranges so a
 * self-hosted Vault/Infisical/Connect on the local network still works. Throws on
 * an unsafe host; call it before the first request in every REST provider.
 */
/**
 * Strip ONE layer of matching surrounding quotes for reference DETECTION only.
 * 1Password's "Copy Secret Reference" puts `"op://Vault/Item/field"` on the clipboard
 * (quotes included), so a pasted value fails a bare `startsWith('op://')` test and the
 * reference is silently skipped (#1521). Providers normalize with this before the prefix
 * test, and the resolver uses it to key the reference - the STORED value is left untouched
 * (so #1086's "stop stripping quotes on save" still holds). Only strips when both ends are
 * the same quote char; leaves a value with mismatched/one-sided quotes as-is.
 */
export function stripSurroundingQuotes(value: string): string {
	// \1 backreference: strip only when the SAME quote char wraps both ends.
	return value.trim().replace(/^(["'])(.*)\1$/s, '$2');
}

export function assertSafeProviderHost(rawUrl: string, label: string): void {
	const safe = isSafeNotificationUrl(rawUrl);
	if (!safe.ok) {
		throw new Error(`${label}: host not allowed (${safe.reason})`);
	}
}

/**
 * Sanitises a user-supplied selector/path before it is concatenated into a
 * provider's API URL (Vault KV path, Infisical secretPath). The selector comes
 * from a stack env var an operator controls, so an unencoded value could inject
 * `..` traversal or `?`/`#`/scheme characters and forge a request to a different
 * endpoint on the same server. Rejects `..` segments and percent-encodes each
 * path segment; a leading slash is stripped by the caller as before.
 */
export function sanitizeSelectorPath(selector: string, label: string): string {
	const trimmed = selector.trim().replace(/^\/+/, '');
	const segments = trimmed.split('/');
	for (const seg of segments) {
		if (seg === '..' || seg === '.') {
			throw new Error(`${label}: selector must not contain path traversal ("${selector}")`);
		}
	}
	return segments.map((s) => encodeURIComponent(s)).join('/');
}

/**
 * Extracts a short, human error message from a provider's error RESPONSE BODY, but
 * only when the body parses as that provider's own documented error JSON shape.
 * Used by testConnection (interactive setup) to show an actionable message like
 * "permission denied" or "Invalid Auth token" WITHOUT reflecting arbitrary upstream
 * bytes: a non-provider host (SSRF probe of a LAN service) returns HTML/other text
 * that does not match the shape, so nothing leaks. Returns null when the body is
 * absent, unparseable, or not the expected shape - the caller then shows status only.
 *
 * Shapes: Vault `{errors:[...]}`, Doppler/Infisical `{messages:[...]}` / `{message}`.
 */
export function parseProviderError(rawBody: string | undefined | null): string | null {
	if (!rawBody) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return null; // not JSON -> not a known provider error shape
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const obj = parsed as Record<string, unknown>;
	const pick = (v: unknown): string | null => {
		if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
		if (Array.isArray(v)) {
			const strs = v.filter((x) => typeof x === 'string' && x.trim()) as string[];
			if (strs.length) return strs.join('; ').slice(0, 200);
		}
		return null;
	};
	return pick(obj.errors) ?? pick(obj.messages) ?? pick(obj.message) ?? null;
}

/**
 * True when `body` parses as a JSON object or array. A 2xx status alone does not prove a
 * host is the expected backend - a parked domain / captive portal / reverse proxy answers
 * 200 with an HTML page. Every provider backend answers JSON, so testConnection requires
 * this before reporting success. Rejects empty bodies and bare scalars (`5`, `true`).
 */
export function isJsonResponse(body: string | undefined | null): boolean {
	if (!body || !body.trim()) return false;
	try {
		const v = JSON.parse(body);
		return typeof v === 'object' && v !== null;
	} catch {
		return false;
	}
}

/** 1Password service account: a single bearer token. */
export interface ServiceAccountConfig {
	token: string;
}

/** 1Password Connect: a self-hosted host URL plus an access token. */
export interface ConnectConfig {
	host: string;
	token: string;
}

/**
 * Infisical: an API host (self-hosted or cloud), a machine-identity or service
 * token, and the project/environment coordinates a bulk pull targets. `path`
 * and `environment` may be overridden per stack via the bulk selector.
 */
export interface InfisicalConfig {
	host: string;
	/** Static service/access token. Supply this OR clientId+clientSecret (Universal Auth). */
	token?: string;
	/** Universal Auth (Machine Identity) client ID. Paired with clientSecret. */
	clientId?: string;
	/** Universal Auth (Machine Identity) client secret. Paired with clientId. */
	clientSecret?: string;
	/** Required for Universal Auth / static non-`st.` tokens; optional for a service
	 *  token (`st.*`), which carries its own project. */
	projectId?: string;
	environment?: string;
	path?: string;
}

/**
 * HashiCorp Vault: a server address and token, plus the KV v2 mount to read
 * from (defaults to `secret`). `namespace` is only meaningful on Enterprise/HCP.
 */
export interface VaultConfig {
	address: string;
	token: string;
	namespace?: string;
	mount?: string;
}

/**
 * Doppler: bulk-only. A SERVICE token (dp.st.) is scoped to one config, so the
 * token alone identifies it and `project`/`config` are not needed. A PERSONAL
 * token (dp.pt.) is account-wide, so it MUST be told which project + config to
 * download (the API returns 400 "You must specify a project" otherwise). `host`
 * defaults to Doppler's SaaS API; it is overridable only for testing against a
 * stub (Doppler has no self-hosted server).
 */
export interface DopplerConfig {
	token: string;
	host?: string;
	/** Required for a personal token (dp.pt.); ignored for a service token. */
	project?: string;
	config?: string;
}

/** Bitwarden Secrets Manager: a Machine Account access token. */
export interface BitwardenConfig {
	token: string;
	/** Optional Bitwarden server base URL for EU or self-hosted instances. */
	serverUrl?: string;
}

/**
 * Proton Pass: a Personal Access Token (`pst_...::...`) authenticates an
 * operator-installed pass-cli client. Bulk pulls one vault (selected by name);
 * inline `pass://SHARE_ID/ITEM_ID[/FIELD]` references resolve a single field.
 */
export interface ProtonConfig {
	token: string;
}

/**
 * Azure Key Vault: authenticates a service principal (app registration) via
 * OAuth2 client-credentials, then reads secrets over the Key Vault REST API.
 * Bulk pulls every secret in the vault; inline `azurekv://<secret-name>`
 * references resolve a single secret.
 */
export interface AzureKvConfig {
	/** Vault URI, e.g. `https://my-vault.vault.azure.net`. */
	vaultUri: string;
	/** Azure AD tenant (directory) ID. */
	tenantId: string;
	/** Service-principal (app registration) client ID. */
	clientId: string;
	/** Service-principal client secret. */
	clientSecret: string;
}

export interface KeePassConfig {
	/** Absolute path to the `.kdbx` database, as seen inside the Dockhand container. */
	databasePath: string;
	/** Master password for the database (encrypted at rest). Optional if a key file is set. */
	password?: string;
	/** Absolute path to an optional key file, as seen inside the container. */
	keyFilePath?: string;
}

/** Persisted (encrypted) config, discriminated by the provider `type`. */
export type SecretProviderConfig =
	| ServiceAccountConfig
	| ConnectConfig
	| InfisicalConfig
	| VaultConfig
	| DopplerConfig
	| BitwardenConfig
	| ProtonConfig
	| AzureKvConfig
	| KeePassConfig;

/**
 * Config keys that hold a SECRET across every provider type. Only these are stripped
 * when a provider config is sent to the client (the edit form); everything else
 * (host, address, projectId, environment, path, namespace, mount, project, config) is
 * a non-secret coordinate the user needs to see and edit. Keep in sync with the
 * `type: 'password'` fields in ProviderModal.svelte's PROVIDER_FIELDS.
 */
export const SECRET_CONFIG_KEYS = new Set(['token', 'clientSecret', 'password']);

/**
 * Every user-overridable connection-destination field across all provider types. If a
 * client-supplied override changes one of these, the request targets a DIFFERENT server than
 * the stored config, so a stored secret must NOT be reattached (that would send the real
 * credential to a caller-chosen host). Must list EVERY provider's destination field:
 *   - `address`  Vault
 *   - `host`     1Password Connect, Infisical
 *   - `serverUrl` Bitwarden Secrets Manager (EU / self-hosted)
 *   - `vaultUri` Azure Key Vault
 * (KeePass `databasePath` is a LOCAL file, not a network destination, so it's out of scope.
 * When you add a provider with an overridable server URL, add its field here.)
 */
export const PROVIDER_DESTINATION_KEYS = ['host', 'address', 'serverUrl', 'vaultUri'] as const;

/**
 * True when the incoming override changes the connection destination (host/address) from the
 * stored value. Used to decide whether a stored secret may follow the request (#secret-exfil):
 * a test whose destination the client changed must not carry the stored credential.
 */
export function destinationOverridesStored(
	incoming: Record<string, unknown>,
	stored: Record<string, unknown>
): boolean {
	for (const key of PROVIDER_DESTINATION_KEYS) {
		if (!(key in incoming)) continue;
		const inVal = incoming[key];
		if (typeof inVal !== 'string') continue;
		if (inVal.trim() === '') continue; // a cleared field isn't a redirect
		if (inVal !== stored[key]) return true;
	}
	return false;
}

/**
 * A masked secret key that only makes sense alongside a non-secret partner field, as a
 * pair the user chooses or abandons together. When the user CLEARS the partner in the edit
 * form (an explicit, visible field), keeping the stored secret would strand it - a secret
 * with no partner - and wedge validation. So clearing the partner drops the orphaned secret
 * instead of merging it back. Today the only such pair is Infisical Universal Auth
 * (clientSecret needs clientId); the mechanism is generic so any future paired secret
 * behaves the same.
 */
const PAIRED_SECRET_PARTNERS: Record<string, string> = { clientSecret: 'clientId' };

/**
 * Merges an incoming (edit-form) config OVER the stored one for a write/test: the incoming
 * non-secret coordinates win, but any SECRET_CONFIG_KEY (the token) that is blank/absent in
 * the incoming falls back to the STORED value - because the edit form leaves the token blank
 * to mean "keep the stored secret". Used by BOTH the update (persist) and the edit-mode Test
 * so a Test validates exactly what a Save would persist. Keep them on this one helper so they
 * can never diverge.
 *
 * Exception: a paired secret (see PAIRED_SECRET_PARTNERS) is NOT carried over when the user
 * explicitly clears its partner field, so switching auth shapes (e.g. Infisical Universal
 * Auth -> static token) actually drops the old secret instead of stranding it.
 */
export function mergeProviderConfigForWrite(
	incoming: Record<string, unknown>,
	stored: Record<string, unknown>
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...incoming };
	for (const key of SECRET_CONFIG_KEYS) {
		const v = incoming[key];
		if (v === undefined || v === '') {
			// If this secret is paired with a partner field the user explicitly cleared,
			// the pair was abandoned - don't resurrect the stored secret.
			const partner = PAIRED_SECRET_PARTNERS[key];
			if (partner !== undefined) {
				const partnerVal = incoming[partner];
				const partnerCleared =
					partner in incoming &&
					(partnerVal === undefined ||
						partnerVal === null ||
						(typeof partnerVal === 'string' && partnerVal.trim() === ''));
				if (partnerCleared) {
					delete merged[key];
					continue;
				}
			}
			if (stored[key] !== undefined) merged[key] = stored[key];
		}
	}
	return merged;
}

/**
 * Returns a copy of a provider config with secret values removed, so the edit form
 * can pre-fill the non-secret coordinates without the token ever leaving the server.
 * A stripped secret is simply absent (the form treats a blank secret field as
 * "keep the stored value").
 */
export function redactProviderConfig(config: SecretProviderConfig): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (!SECRET_CONFIG_KEYS.has(key)) out[key] = value;
	}
	return out;
}

export interface TestConnectionResult {
	ok: boolean;
	error?: string;
}

/**
 * Thrown by a provider when it is asked to do something its backend cannot do
 * (e.g. resolving a 1Password Environment over Connect, or inline reference
 * interpolation on a bulk-only backend). Callers can catch this to surface a
 * precise "not supported on this provider" message instead of a generic failure.
 */
export class UnsupportedOperationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedOperationError';
	}
}

/**
 * The behaviour every provider implements. `C` is the provider's own config
 * shape; the registry in ./index narrows it per type.
 *
 * A provider that does not support a given mode advertises it via
 * `supportsReferences` / `supportsBulk` and throws
 * {@link UnsupportedOperationError} from the corresponding method.
 */
export interface SecretProvider<C extends SecretProviderConfig = SecretProviderConfig> {
	/** Stable type tag matching the `secret_providers.type` column. */
	readonly type: SecretProviderType;

	/** Human-readable name for logs and UI (e.g. "1Password service account"). */
	readonly label: string;

	/** Whether this backend supports inline reference interpolation. */
	readonly supportsReferences: boolean;

	/** Whether this backend supports bulk pull of a selector. */
	readonly supportsBulk: boolean;

	/**
	 * Detects whether a variable value is an inline reference in this backend's
	 * syntax. Bulk-only providers return false for everything.
	 */
	isReference(value: unknown): value is string;

	/**
	 * Validates the config against the backend. Returns `{ ok: true }` on
	 * success, `{ ok: false, error }` otherwise. Must not throw for ordinary
	 * auth failures.
	 */
	testConnection(config: C): Promise<TestConnectionResult>;

	/**
	 * Resolves a batch of inline references. Returns a map containing only the
	 * references that resolved successfully; individual lookup failures are
	 * logged and skipped so the caller can leave those values as literals.
	 * Transport / auth failures propagate as thrown errors. Bulk-only providers
	 * throw {@link UnsupportedOperationError}.
	 */
	resolveSecretReferences(
		config: C,
		refs: string[],
		logPrefix?: string
	): Promise<Map<string, string>>;

	/**
	 * Fetches every secret under a provider-defined selector as a flat key/value
	 * map. The selector is opaque and provider-specific (a 1Password Environment
	 * id, an Infisical path, a Vault kv path, ...). Providers without a bulk
	 * concept throw {@link UnsupportedOperationError}.
	 */
	resolveBulk(config: C, selector: string): Promise<Record<string, string>>;
}
