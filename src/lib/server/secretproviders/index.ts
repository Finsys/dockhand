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
import { connectProvider } from './connect';
import { infisicalProvider } from './infisical';
import { vaultProvider } from './vault';
import { dopplerProvider } from './doppler';
import { bitwardenProvider } from './bitwarden';
import { protonProvider } from './proton';
import { azureKvProvider } from './azure-kv';
import { keepassProvider } from './keepass';

// Registered providers. Adding a new backend means dropping a file in this
// directory and registering it here; each implements the SecretProvider
// contract in ./shared.
const providers: Record<string, SecretProvider> = {
	[serviceAccountProvider.type]: serviceAccountProvider as SecretProvider,
	[connectProvider.type]: connectProvider as SecretProvider,
	[infisicalProvider.type]: infisicalProvider as SecretProvider,
	[vaultProvider.type]: vaultProvider as SecretProvider,
	[dopplerProvider.type]: dopplerProvider as SecretProvider,
	[bitwardenProvider.type]: bitwardenProvider as SecretProvider,
	[protonProvider.type]: protonProvider as SecretProvider,
	[azureKvProvider.type]: azureKvProvider as SecretProvider,
	[keepassProvider.type]: keepassProvider as SecretProvider
};

/** Returns the provider for a stored type, or undefined if unknown. */
export function getProvider(type: SecretProviderType): SecretProvider | undefined {
	return providers[type];
}

/** True when a provider is registered for the given type. */
export function hasProvider(type: SecretProviderType): boolean {
	return type in providers;
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
