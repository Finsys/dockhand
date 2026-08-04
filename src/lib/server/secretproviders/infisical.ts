/**
 * Infisical provider.
 *
 * Talks to an Infisical instance (Infisical Cloud or self-hosted) over its
 * public REST API to bulk-pull every secret under a project / environment /
 * path. Infisical has no inline compose-reference syntax (no op://-style
 * marker), so this provider is bulk-only: `resolveSecretReferences` is
 * unsupported and `isReference` is always false.
 *
 * The `token` is treated as a ready-to-use API access token / service token and
 * sent as `Authorization: Bearer <token>`. Universal Auth (clientId +
 * clientSecret exchanged via POST /api/v1/auth/universal-auth/login) is not
 * modelled by InfisicalConfig and would need a config field plus a login step.
 *
 * Decrypted tokens stay inside this module for the duration of a call. Nothing
 * here writes to disk or to the database.
 */

import { request } from 'undici';
import type { InfisicalConfig, SecretProvider, TestConnectionResult } from './shared';
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
	return host.replace(/\/$/, '');
}

/**
 * Builds the /api/v3/secrets/raw URL for a workspace/environment/path. The
 * secret path defaults to `/` (Infisical's root) when nothing is configured.
 */
function rawSecretsUrl(
	host: string,
	workspaceId: string,
	environment: string,
	secretPath: string
): string {
	const params = new URLSearchParams({
		workspaceId,
		environment,
		secretPath: secretPath || '/'
	});
	return `${baseUrl(host)}/api/v3/secrets/raw?${params.toString()}`;
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
		const token = config.token?.trim();
		const projectId = config.projectId?.trim();
		const environment = config.environment?.trim();

		if (!host) {
			return { ok: false, error: 'Host is empty' };
		}
		if (!token) {
			return { ok: false, error: 'Token is empty' };
		}
		if (!projectId) {
			return { ok: false, error: 'Project ID is empty' };
		}
		if (!environment) {
			return { ok: false, error: 'Environment is empty' };
		}

		try {
			const { statusCode, body } = await request(
				rawSecretsUrl(host, projectId, environment, '/'),
				{
					method: 'GET',
					headers: { authorization: `Bearer ${token}` }
				}
			);
			// Always drain the body so undici can reuse the connection.
			await body.text().catch(() => '');
			if (statusCode >= 200 && statusCode < 300) {
				return { ok: true };
			}
			return { ok: false, error: `Infisical returned HTTP ${statusCode}` };
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
		const token = config.token?.trim();
		const projectId = config.projectId?.trim();
		const environment = config.environment?.trim();
		const secretPath = selector?.trim() || config.path?.trim() || '/';

		if (!host) {
			throw new Error('[Infisical] Host is required for a bulk pull');
		}
		if (!token) {
			throw new Error('[Infisical] Token is required for a bulk pull');
		}
		if (!projectId) {
			throw new Error('[Infisical] Project ID is required for a bulk pull');
		}
		if (!environment) {
			throw new Error('[Infisical] Environment is required for a bulk pull');
		}

		const { statusCode, body } = await request(
			rawSecretsUrl(host, projectId, environment, secretPath),
			{
				method: 'GET',
				headers: { authorization: `Bearer ${token}` }
			}
		);

		if (statusCode < 200 || statusCode >= 300) {
			// Drain the body so the connection can be reused, then surface the status.
			const detail = await body.text().catch(() => '');
			throw new Error(
				`[Infisical] Bulk pull failed with HTTP ${statusCode}${detail ? `: ${detail}` : ''}`
			);
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
