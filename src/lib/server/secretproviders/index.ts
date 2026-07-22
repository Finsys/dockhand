/**
 * Secret-provider registry.
 *
 * Maps a stored provider `type` to its implementation, and exposes the small
 * surface the deploy path (stacks.ts) and the API routes consume. Adding a new
 * backend means dropping a file in this directory and registering it here — no
 * caller needs to change.
 */

import type {
	SecretProvider,
	SecretProviderConfig,
	SecretProviderType,
	TestConnectionResult
} from './shared';
import { serviceAccountProvider } from './service-account';

// Registered providers. New backends (connect, infisical, vault, ...) are added
// here as they land; each implements the SecretProvider contract in ./shared.
const providers: Record<string, SecretProvider> = {
	[serviceAccountProvider.type]: serviceAccountProvider as SecretProvider
};

/** Returns the provider for a stored type, or undefined if unknown. */
export function getProvider(type: SecretProviderType): SecretProvider | undefined {
	return providers[type];
}

/** True when a provider is registered for the given type. */
export function hasProvider(type: SecretProviderType): boolean {
	return type in providers;
}

/** Lightweight metadata for the settings UI (type + label + capabilities). */
export function listProviderTypes(): Array<{
	type: SecretProviderType;
	label: string;
	supportsReferences: boolean;
	supportsBulk: boolean;
}> {
	return Object.values(providers).map((p) => ({
		type: p.type,
		label: p.label,
		supportsReferences: p.supportsReferences,
		supportsBulk: p.supportsBulk
	}));
}

/**
 * Validates a provider config against its backend. Returns a clear error when
 * the type is not registered.
 */
export async function testProviderConnection(
	type: SecretProviderType,
	config: SecretProviderConfig
): Promise<TestConnectionResult> {
	const provider = getProvider(type);
	if (!provider) {
		return { ok: false, error: `Unknown secret provider type: ${type}` };
	}
	return provider.testConnection(config);
}

export type { SecretProvider, SecretProviderConfig, SecretProviderType, TestConnectionResult };
