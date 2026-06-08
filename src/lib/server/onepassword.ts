/**
 * 1Password Service Account integration.
 *
 * Thin wrapper around the official @1password/sdk that exposes only what
 * Dockhand needs: validating a service account token, reading variables
 * from a 1Password Environment, and interpolating op:// references.
 *
 * Decrypted tokens stay inside this module and the in-memory SDK client.
 * Nothing here writes to disk or to the database.
 */

import { createClient } from '@1password/sdk';

const INTEGRATION_NAME = 'Dockhand';
const INTEGRATION_VERSION = '1.0.0';

async function makeClient(token: string) {
	return createClient({
		auth: token,
		integrationName: INTEGRATION_NAME,
		integrationVersion: INTEGRATION_VERSION
	});
}

export interface TestConnectionResult {
	ok: boolean;
	error?: string;
}

/**
 * Authenticates a service account token. Returns ok: true if the SDK accepts
 * the token, ok: false with an error message otherwise.
 */
export async function testConnection(token: string): Promise<TestConnectionResult> {
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
}

/**
 * Fetches all variables from a 1Password Environment as a plain key/value map.
 * The token is decrypted by the caller and passed in directly.
 */
export async function resolveEnvironment(
	token: string,
	environmentId: string
): Promise<Record<string, string>> {
	const client = await makeClient(token);
	const response = await client.environments.getVariables(environmentId);
	const result: Record<string, string> = {};
	for (const variable of response.variables) {
		result[variable.name] = variable.value;
	}
	return result;
}

/**
 * Returns true when the trimmed value is an op:// secret reference.
 */
export function isOpReference(value: unknown): value is string {
	return typeof value === 'string' && value.trim().startsWith('op://');
}

/**
 * Resolves a list of op:// secret references in a single SDK call.
 * Returns a map of only the successfully resolved refs. Individual failures
 * (ref not found, parsing errors, etc.) are logged as warnings and skipped,
 * leaving the original literal for the caller to handle. The SDK itself may
 * still throw on transport / auth failures — those propagate to the caller.
 */
export async function resolveSecretReferences(
	token: string,
	refs: string[],
	logPrefix = '[1Password]'
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	if (refs.length === 0) {
		return result;
	}
	const client = await makeClient(token);
	const response = await client.secrets.resolveAll(refs);
	for (const [ref, item] of Object.entries(response.individualResponses)) {
		if (item.error) {
			const detail = item.error.message ?? item.error.type ?? 'unknown error';
			console.warn(`${logPrefix} Skipping op:// reference ${ref}: ${detail}`);
			continue;
		}
		if (item.content?.secret !== undefined) {
			result.set(ref, item.content.secret);
		}
	}
	return result;
}
