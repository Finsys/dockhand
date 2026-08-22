/**
 * 1Password Service Account provider.
 *
 * Thin wrapper around the official @1password/sdk that exposes only what
 * Dockhand needs: validating a service account token, reading variables from a
 * 1Password Environment, and interpolating op:// references.
 *
 * Decrypted tokens stay inside this module and the in-memory SDK client.
 * Nothing here writes to disk or to the database.
 *
 * This is the homelab / Families path: service accounts are available on
 * Individual and Families plans. Business users who run a Connect server use
 * ./connect instead.
 */

import { createClient } from '@1password/sdk';
import type { SecretProvider, ServiceAccountConfig, TestConnectionResult } from './shared';

const INTEGRATION_NAME = 'Dockhand';
const INTEGRATION_VERSION = '1.0.0';

// createClient does a ~2s handshake, and one deploy builds a client for the bulk
// pull and again for inline refs. Reuse a client per token for a few seconds so a
// single deploy (and back-to-back retries) pay that cost once, not per call.
const CLIENT_TTL_MS = 30_000;
interface CachedClient {
	client: Awaited<ReturnType<typeof createClient>>;
	expiresAt: number;
}
const clientCache = new Map<string, CachedClient>();

async function makeClient(token: string) {
	const now = Date.now();
	const hit = clientCache.get(token);
	if (hit && hit.expiresAt > now) return hit.client;
	const client = await createClient({
		auth: token,
		integrationName: INTEGRATION_NAME,
		integrationVersion: INTEGRATION_VERSION
	});
	clientCache.set(token, { client, expiresAt: now + CLIENT_TTL_MS });
	return client;
}

export const serviceAccountProvider: SecretProvider<ServiceAccountConfig> = {
	type: 'op-service-account',
	label: '1Password service account',
	supportsReferences: true,
	supportsBulk: true,

	isReference(value: unknown): value is string {
		return typeof value === 'string' && value.trim().startsWith('op://');
	},

	async testConnection({ token }: ServiceAccountConfig): Promise<TestConnectionResult> {
		const trimmed = token?.trim();
		if (!trimmed) {
			return { ok: false, error: 'Token is empty' };
		}
		try {
			await makeClient(trimmed);
			return { ok: true };
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			return { ok: false, error: message || 'Authentication failed' };
		}
	},

	async resolveSecretReferences(
		{ token }: ServiceAccountConfig,
		refs: string[],
		logPrefix = '[1Password]'
	): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		if (refs.length === 0) {
			return result;
		}
		const client = await makeClient(token);
		const response = await client.secrets.resolveAll(refs);
		const skipped: string[] = [];
		for (const [ref, item] of Object.entries(response.individualResponses)) {
			if (item.error) {
				skipped.push(ref);
				continue;
			}
			if (item.content?.secret !== undefined) {
				result.set(ref, item.content.secret);
			}
		}
		// One summary line instead of one warning per bad ref, so a handful of
		// malformed references don't flood the log across repeated deploys.
		if (skipped.length > 0) {
			const total = Object.keys(response.individualResponses).length;
			console.warn(
				`${logPrefix} Skipped ${skipped.length} of ${total} op:// reference(s) - ` +
					`malformed or not found (need op://<vault>/<item>/<field>): ${skipped.join(', ')}`
			);
		}
		return result;
	},

	async resolveBulk(
		{ token }: ServiceAccountConfig,
		selector: string
	): Promise<Record<string, string>> {
		const client = await makeClient(token);
		const response = await client.environments.getVariables(selector);
		const result: Record<string, string> = {};
		for (const variable of response.variables) {
			result[variable.name] = variable.value;
		}
		return result;
	}
};
