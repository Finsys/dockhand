import { json } from '@sveltejs/kit';
import { unixSocketRequest, httpsAgentRequest } from '$lib/server/docker';
import type { DockerClientConfig } from '$lib/server/docker';
import { getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { resolveTestTarget } from '$lib/server/env-test-target';
import { fillStoredSecrets } from '$lib/server/env-test-secrets';
import { memorySupportFromInfo } from '$lib/utils/memory-support';
import type { RequestHandler } from './$types';

interface TestConnectionRequest {
	connectionType: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
	socketPath?: string;
	host?: string;
	port?: number;
	protocol?: string;
	tlsCa?: string;
	tlsCert?: string;
	tlsKey?: string;
	tlsSkipVerify?: boolean;
	hawserToken?: string;
	/**
	 * When editing an existing environment, secrets (hawserToken, tlsKey) are never sent
	 * back to the client, so an unchanged token comes through empty. Passing the env id lets
	 * the server fall back to the STORED secret for any secret field the body left blank, so
	 * "Test connection" works without re-typing the token (#1483). Non-secret fields still
	 * come from the body, so the test reflects the edited form.
	 */
	environmentId?: number;
}

function cleanPem(pem: string): string {
	return pem
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join('\n');
}

function buildDockerClientConfig(config: TestConnectionRequest): DockerClientConfig | null {
	const protocol = config.protocol || 'http';
	if (protocol !== 'https') return null;

	return {
		type: 'https',
		host: config.host || 'localhost',
		port: config.port || 2376,
		ca: config.tlsCa ? cleanPem(config.tlsCa) || undefined : undefined,
		cert: config.tlsCert ? cleanPem(config.tlsCert) || undefined : undefined,
		key: config.tlsKey ? cleanPem(config.tlsKey) || undefined : undefined,
		skipVerify: config.tlsSkipVerify || false
	};
}

/**
 * Test Docker connection with provided configuration (without saving to database)
 *
 * @openapi
 * summary: Test a Docker/Hawser connection configuration WITHOUT saving it as an environment
 * description: Pass environmentId to fall back to that saved environment's stored secrets (hawserToken, tlsKey) for any secret field left blank in the body, so Test connection works when editing without re-entering the token. Needs environments:edit on that environment, and the stored secrets are only reused while host, port and protocol match the saved ones.
 * body: {connectionType:string!, socketPath:string, host:string, port:integer, protocol:string, tlsCa:string, tlsCert:string, tlsKey:string, tlsSkipVerify:boolean, hawserToken:string, environmentId:integer}
 * body-example: {"connectionType":"socket","socketPath":"/var/run/docker.sock"}
 * resp-200: {success:boolean!, info:{serverVersion:string, containers:integer, images:integer, name:string, memoryLimitSupported:boolean, showMemoryWarning:boolean}, hawser:{}}
 * resp-200-desc: success:false with a human-readable error message is also returned as HTTP 200 (connection failures are not transport errors)
 * resp-400: Host is required for direct/hawser-standard connection types, the protocol is not http or https, the port is out of range, or the host is not a plain hostname or IP address
 * resp-403: The caller lacks environments:create and environments:edit, or cannot access, or lacks environments:edit on, the environment named by environmentId
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	try {
		const config: TestConnectionRequest = await request.json();

		// Testing a connection is part of adding or editing an environment.
		const auth = await authorize(cookies);
		if (auth.authEnabled && !(await auth.can('environments', 'create')) && !(await auth.can('environments', 'edit'))) {
			return json({ success: false, error: 'Access denied' }, { status: 403 });
		}

		// Fill unchanged secrets from the stored environment when editing (#1483): the client
		// never receives hawserToken / tlsKey, so an untouched field arrives empty. Only fall
		// back for a BLANK field, so a freshly typed token/key still wins, and only for the
		// stored host/port/protocol, so the secret cannot be sent anywhere else.
		if (config.environmentId) {
			// Reusing a stored secret is an edit of that environment, not a view of it.
			if (
				!(await auth.canAccessEnvironment(config.environmentId)) ||
				!(await auth.can('environments', 'edit', config.environmentId))
			) {
				return json({ success: false, error: 'Access denied' }, { status: 403 });
			}
			const stored = await getEnvironment(config.environmentId);
			if (stored) fillStoredSecrets(config, stored);
		}

		// Build fetch options based on connection type
		let response: Response;
		let origin = '';

		if (config.connectionType === 'socket') {
			const socketPath = config.socketPath || '/var/run/docker.sock';
			response = await unixSocketRequest(socketPath, '/info');
		} else if (config.connectionType === 'hawser-edge') {
			// Edge mode - cannot test directly, agent connects to us
			return json({
				success: true,
				info: {
					message: 'Edge mode environments are tested when the agent connects'
				},
				isEdgeMode: true
			});
		} else {
			// Direct or Hawser Standard - HTTP/HTTPS connection. Both requests below dial
			// the target judged here.
			const target = await resolveTestTarget(config);
			if (!target.ok) {
				if (target.badRequest) return json({ success: false, error: target.error }, { status: 400 });
				return json({ success: false, error: target.error }, { status: 200 });
			}
			origin = target.origin;

			const headers: Record<string, string> = {
				'Content-Type': 'application/json'
			};

			if (config.connectionType === 'hawser-standard' && config.hawserToken) {
				headers['X-Hawser-Token'] = config.hawserToken;
			}

			const tlsConfig = buildDockerClientConfig(config);
			if (tlsConfig) {
				response = await httpsAgentRequest(tlsConfig, '/info', {}, false, headers);
			} else {
				// A redirect would dial a host nobody checked.
				response = await fetch(`${origin}/info`, {
					headers,
					redirect: 'manual',
					signal: AbortSignal.timeout(10000),
					keepalive: false
				});
			}
		}

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Docker API error: ${response.status} - ${error}`);
		}

		const info = await response.json();

		// For Hawser Standard, also try to fetch Hawser info
		let hawserInfo = null;
		if (config.connectionType === 'hawser-standard' && origin) {
			try {
				const hawserHeaders: Record<string, string> = {};
				if (config.hawserToken) {
					hawserHeaders['X-Hawser-Token'] = config.hawserToken;
				}

				let hawserResp: Response;
				const tlsConfig = buildDockerClientConfig(config);
				if (tlsConfig) {
					hawserResp = await httpsAgentRequest(tlsConfig, '/_hawser/info', {}, false, hawserHeaders);
				} else {
					hawserResp = await fetch(`${origin}/_hawser/info`, {
						headers: hawserHeaders,
						redirect: 'manual',
						signal: AbortSignal.timeout(5000),
						keepalive: false
					});
				}
				if (hawserResp.ok) {
					hawserInfo = await hawserResp.json();
				}
			} catch {
				// Hawser info fetch failed, continue without it
			}
		}

		const memSupport = memorySupportFromInfo(info);
		return json({
			success: true,
			info: {
				serverVersion: info.ServerVersion,
				containers: info.Containers,
				images: info.Images,
				name: info.Name,
				// The kernel's cgroup memory controller: false => per-container memory
				// shows 0 (common on Raspberry Pi). The modal warns on this at create time.
				memoryLimitSupported: memSupport.memoryLimitSupported,
				// Whether to actually show the cgroup-accounting warning. False on a
				// Windows daemon, where MemoryLimit is false but memory reports fine (#1574).
				showMemoryWarning: memSupport.warn
			},
			hawser: hawserInfo
		});
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : 'Connection failed';
		console.error('Failed to test connection:', rawMessage);

		// Provide more helpful error messages
		let message = rawMessage;
		if (rawMessage.includes('401') || rawMessage.toLowerCase().includes('unauthorized')) {
			message = 'Invalid token - check that the Hawser token matches';
		} else if (rawMessage.includes('403') || rawMessage.toLowerCase().includes('forbidden')) {
			message = 'Access forbidden - check token permissions';
		} else if (rawMessage.includes('ECONNREFUSED') || rawMessage.includes('Connection refused')) {
			message = 'Connection refused - is Docker/Hawser running?';
		} else if (rawMessage.includes('ETIMEDOUT') || rawMessage.includes('timeout') || rawMessage.includes('Timeout')) {
			message = 'Connection timed out - check host and port';
		} else if (rawMessage.includes('ENOTFOUND') || rawMessage.includes('getaddrinfo')) {
			message = 'Host not found - check the hostname';
		} else if (rawMessage.includes('EHOSTUNREACH')) {
			message = 'Host unreachable - check network connectivity';
		} else if (rawMessage.includes('ENOENT') || rawMessage.includes('no such file')) {
			message = 'Socket not found - check the socket path';
		} else if (rawMessage.includes('EACCES') || rawMessage.includes('permission denied')) {
			message = 'Permission denied - check socket permissions';
		} else if (rawMessage.includes('typo in the url') || rawMessage.includes('Was there a typo')) {
			message = 'Connection failed - check host and port';
		} else if (rawMessage.includes('self signed certificate') || rawMessage.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
			message = 'TLS certificate error - provide CA certificate for self-signed certs';
		} else if (rawMessage.includes('CERT_ALTNAME_INVALID') || rawMessage.includes('ERR_TLS_CERT_ALTNAME_INVALID')) {
			message = 'Certificate hostname mismatch - your certificate\'s Subject Alternative Name (SAN) doesn\'t match the host. Regenerate with: -addext "subjectAltName=DNS:hostname,IP:x.x.x.x"';
		} else if (rawMessage.includes('certificate') || rawMessage.includes('SSL') || rawMessage.includes('TLS')) {
			message = 'TLS/SSL error - check certificate configuration';
		}

		return json({ success: false, error: message }, { status: 200 });
	}
};
