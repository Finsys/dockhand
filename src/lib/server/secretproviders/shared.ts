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
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	| (string & {});

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
	token: string;
	projectId: string;
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

/** Persisted (encrypted) config, discriminated by the provider `type`. */
export type SecretProviderConfig =
	| ServiceAccountConfig
	| ConnectConfig
	| InfisicalConfig
	| VaultConfig;

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
