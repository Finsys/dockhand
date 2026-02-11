import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getEnvironment } from '$lib/server/db';
import { sendEdgeRequest, sendEdgeStreamRequest, isEdgeConnected } from '$lib/server/hawser';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

// Detect Docker socket path
function detectDockerSocket(): string {
	if (process.env.DOCKER_SOCKET && existsSync(process.env.DOCKER_SOCKET)) {
		return process.env.DOCKER_SOCKET;
	}
	if (process.env.DOCKER_HOST?.startsWith('unix://')) {
		const socketPath = process.env.DOCKER_HOST.replace('unix://', '');
		if (existsSync(socketPath)) return socketPath;
	}
	const possibleSockets = [
		'/var/run/docker.sock',
		`${homedir()}/.docker/run/docker.sock`,
		`${homedir()}/.orbstack/run/docker.sock`,
		'/run/docker.sock'
	];
	for (const socket of possibleSockets) {
		if (existsSync(socket)) return socket;
	}
	return '/var/run/docker.sock';
}

const socketPath = detectDockerSocket();

interface DockerClientConfig {
	type: 'socket' | 'http' | 'https' | 'hawser-edge';
	socketPath?: string;
	host?: string;
	port?: number;
	ca?: string;
	cert?: string;
	key?: string;
	skipVerify?: boolean;
	hawserToken?: string;
	environmentId?: number;
}

async function getDockerConfig(envId?: number | null): Promise<DockerClientConfig | null> {
	if (!envId) {
		return null;
	}
	const env = await getEnvironment(envId);
	if (!env) {
		return null;
	}
	if (env.connectionType === 'socket' || !env.connectionType) {
		return { type: 'socket', socketPath: env.socketPath || socketPath };
	}
	if (env.connectionType === 'hawser-edge') {
		return { type: 'hawser-edge', environmentId: envId };
	}
	const protocol = (env.protocol as 'http' | 'https') || 'http';
	return {
		type: protocol,
		host: env.host || 'localhost',
		port: env.port || 2375,
		ca: env.tlsCa || undefined,
		cert: env.tlsCert || undefined,
		key: env.tlsKey || undefined,
		skipVerify: env.tlsSkipVerify || undefined,
		hawserToken: env.connectionType === 'hawser-standard' ? env.hawserToken || undefined : undefined
	};
}

/**
 * Demultiplex Docker stream frame - returns payload and stream type
 */
function parseDockerFrame(buffer: Buffer, offset: number): { type: number; size: number; payload: string } | null {
	if (buffer.length < offset + 8) return null;

	const streamType = buffer.readUInt8(offset);
	const frameSize = buffer.readUInt32BE(offset + 4);

	if (buffer.length < offset + 8 + frameSize) return null;

	const payload = buffer.slice(offset + 8, offset + 8 + frameSize).toString('utf-8');
	return { type: streamType, size: 8 + frameSize, payload };
}

/**
 * Handle logs streaming for Hawser Edge connections
 */
async function handleEdgeLogsStream(containerId: string, tail: string, environmentId: number): Promise<Response> {
	// Check if edge agent is connected
	if (!isEdgeConnected(environmentId)) {
		return new Response(JSON.stringify({ error: 'Edge agent not connected' }), {
			status: 503,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// First, check if container has TTY enabled and get container name
	let hasTty = false;
	let containerName = containerId.substring(0, 12); // Default to short ID
	try {
		const inspectPath = `/containers/${containerId}/json`;
		const inspectResponse = await sendEdgeRequest(environmentId, 'GET', inspectPath);
		if (inspectResponse.statusCode === 200) {
			const info = JSON.parse(inspectResponse.body as string);
			hasTty = info.Config?.Tty ?? false;
			// Get container name (strip leading /)
			containerName = info.Name?.replace(/^\//, '') || containerName;
		}
	} catch {
		// Ignore - default to demux mode
	}

	const logsPath = `/containers/${containerId}/logs?stdout=true&stderr=true&follow=true&tail=${tail}&timestamps=true`;

	let controllerClosed = false;
	let cancelStream: (() => void) | null = null;
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const safeEnqueue = (data: string) => {
				if (!controllerClosed) {
					try {
						controller.enqueue(encoder.encode(data));
					} catch {
						controllerClosed = true;
					}
				}
			};

			// Send heartbeat to keep connection alive (every 5s for Traefik)
			heartbeatInterval = setInterval(() => {
				safeEnqueue(`: keepalive\n\n`);
			}, 5000);

			// Buffer for non-TTY stream demuxing
			let buffer = Buffer.alloc(0);

			// Send connected event
			safeEnqueue(`event: connected\ndata: ${JSON.stringify({ containerId, containerName, hasTty })}\n\n`);

			// Start streaming logs via Edge
			const { cancel } = sendEdgeStreamRequest(
				environmentId,
				'GET',
				logsPath,
				{
					onData: (data: string, streamType?: 'stdout' | 'stderr') => {
						if (controllerClosed) return;

						if (hasTty) {
							// TTY mode: data is raw text, may be base64 encoded
							let text = data;
							try {
								// Try to decode as base64
								text = Buffer.from(data, 'base64').toString('utf-8');
							} catch {
								// Not base64, use as-is
							}
							if (text) {
								safeEnqueue(`event: log\ndata: ${JSON.stringify({ text, containerName })}\n\n`);
							}
						} else {
							// Non-TTY mode: data might be base64 encoded Docker multiplexed stream
							let rawData: Buffer;
							try {
								rawData = Buffer.from(data, 'base64');
							} catch {
								rawData = Buffer.from(data, 'utf-8');
							}

							buffer = Buffer.concat([buffer, rawData]);

							// Process complete frames
							let offset = 0;
							while (true) {
								const frame = parseDockerFrame(buffer, offset);
								if (!frame) break;

								if (frame.payload) {
									safeEnqueue(`event: log\ndata: ${JSON.stringify({
										text: frame.payload,
										containerName,
										stream: frame.type === 2 ? 'stderr' : 'stdout'
									})}\n\n`);
								}
								offset += frame.size;
							}

							// Keep remaining incomplete frame data
							buffer = buffer.slice(offset);
						}
					},
					onEnd: (reason?: string) => {
						if (buffer.length > 0) {
							const text = buffer.toString('utf-8');
							if (text.trim()) {
								safeEnqueue(`event: log\ndata: ${JSON.stringify({ text, containerName })}\n\n`);
							}
						}
						safeEnqueue(`event: end\ndata: ${JSON.stringify({ reason: reason || 'stream ended' })}\n\n`);
						if (!controllerClosed) {
							try {
								controller.close();
							} catch {
								// Already closed
							}
						}
					},
					onError: (error: string) => {
						safeEnqueue(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
						if (!controllerClosed) {
							try {
								controller.close();
							} catch {
								// Already closed
							}
						}
					}
				}
			);

			cancelStream = cancel;
		},
		cancel() {
			controllerClosed = true;
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
			if (cancelStream) {
				cancelStream();
				cancelStream = null;
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
}

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);

	const containerId = params.id;
	const tail = url.searchParams.get('tail') || '100';
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('containers', 'logs', envIdNum)) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const config = await getDockerConfig(envIdNum);

	// Handle Hawser Edge mode separately
	if (config.type === 'hawser-edge') {
		return handleEdgeLogsStream(containerId, tail, config.environmentId!);
	}

	// First, check if container has TTY enabled and get container name
	let hasTty = false;
	let containerName = containerId.substring(0, 12); // Default to short ID
	try {
		const inspectPath = `/containers/${containerId}/json`;
		let inspectResponse: Response;

		if (config.type === 'socket') {
			inspectResponse = await fetch(`http://localhost${inspectPath}`, {
				// @ts-ignore - Bun supports unix socket
				unix: config.socketPath
			});
		} else {
			const inspectUrl = `${config.type}://${config.host}:${config.port}${inspectPath}`;
			const inspectHeaders: Record<string, string> = {};
			if (config.hawserToken) inspectHeaders['X-Hawser-Token'] = config.hawserToken;
			const fetchOpts: any = { headers: inspectHeaders };
			if (config.type === 'https') {
				fetchOpts.tls = {
					sessionTimeout: 0,
					servername: config.host,
					rejectUnauthorized: !config.skipVerify
				};
				if (config.ca) fetchOpts.tls.ca = [config.ca];
				if (config.cert) fetchOpts.tls.cert = [config.cert];
				if (config.key) fetchOpts.tls.key = config.key;
				fetchOpts.keepalive = false;
				if (process.env.DEBUG_TLS) fetchOpts.verbose = true;
			}
			inspectResponse = await fetch(inspectUrl, fetchOpts);
		}

		if (inspectResponse.ok) {
			const info = await inspectResponse.json();
			hasTty = info.Config?.Tty ?? false;
			// Get container name (strip leading /)
			containerName = info.Name?.replace(/^\//, '') || containerName;
		}
	} catch {
		// Ignore - default to demux mode
	}

	// Build the logs URL with follow=true for streaming
	const logsPath = `/containers/${containerId}/logs?stdout=true&stderr=true&follow=true&tail=${tail}&timestamps=true`;

	let controllerClosed = false;
	let abortController: AbortController | null = new AbortController();
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			const safeEnqueue = (data: string) => {
				if (!controllerClosed) {
					try {
						controller.enqueue(encoder.encode(data));
					} catch {
						controllerClosed = true;
					}
				}
			};

			// Send heartbeat to keep connection alive (every 5s for Traefik)
			heartbeatInterval = setInterval(() => {
				safeEnqueue(`: keepalive\n\n`);
			}, 5000);

			try {
				let response: Response;

				if (config.type === 'socket') {
					response = await fetch(`http://localhost${logsPath}`, {
						// @ts-ignore - Bun supports unix socket
						unix: config.socketPath,
						signal: abortController?.signal
					});
				} else {
					const logsUrl = `${config.type}://${config.host}:${config.port}${logsPath}`;
					const logsHeaders: Record<string, string> = {};
					if (config.hawserToken) logsHeaders['X-Hawser-Token'] = config.hawserToken;
					const fetchOpts: any = {
						headers: logsHeaders,
						signal: abortController?.signal
					};
					if (config.type === 'https') {
						fetchOpts.tls = {
							sessionTimeout: 0,
							servername: config.host,
							rejectUnauthorized: !config.skipVerify
						};
						if (config.ca) fetchOpts.tls.ca = [config.ca];
						if (config.cert) fetchOpts.tls.cert = [config.cert];
						if (config.key) fetchOpts.tls.key = config.key;
						fetchOpts.keepalive = false;
						if (process.env.DEBUG_TLS) fetchOpts.verbose = true;
					}
					response = await fetch(logsUrl, fetchOpts);
				}

				if (!response.ok) {
					safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: `Docker API error: ${response.status}` })}\n\n`);
					if (!controllerClosed) controller.close();
					return;
				}

				// Send connected event
				safeEnqueue(`event: connected\ndata: ${JSON.stringify({ containerId, containerName, hasTty })}\n\n`);

				const reader = response.body?.getReader();
				if (!reader) {
					safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: 'No response body' })}\n\n`);
					if (!controllerClosed) controller.close();
					return;
				}

				let buffer = Buffer.alloc(0);

				while (!controllerClosed) {
					const { done, value } = await reader.read();

					if (done) {
						// Send any remaining buffer content
						if (buffer.length > 0) {
							const text = buffer.toString('utf-8');
							if (text.trim()) {
								safeEnqueue(`event: log\ndata: ${JSON.stringify({ text, containerName })}\n\n`);
							}
						}
						safeEnqueue(`event: end\ndata: ${JSON.stringify({ reason: 'stream ended' })}\n\n`);
						break;
					}

					if (value) {
						if (hasTty) {
							// TTY mode: raw text, no demux needed
							const text = new TextDecoder().decode(value);
							if (text) {
								safeEnqueue(`event: log\ndata: ${JSON.stringify({ text, containerName })}\n\n`);
							}
						} else {
							// Non-TTY mode: demux Docker stream frames
							buffer = Buffer.concat([buffer, Buffer.from(value)]);

							// Process complete frames
							let offset = 0;
							while (true) {
								const frame = parseDockerFrame(buffer, offset);
								if (!frame) break;

								// Stream type 1 = stdout, 2 = stderr
								if (frame.payload) {
									safeEnqueue(`event: log\ndata: ${JSON.stringify({ text: frame.payload, containerName, stream: frame.type === 2 ? 'stderr' : 'stdout' })}\n\n`);
								}
								offset += frame.size;
							}

							// Keep remaining incomplete frame data
							buffer = buffer.slice(offset);
						}
					}
				}

				reader.releaseLock();
			} catch (error) {
				if (!controllerClosed) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					if (!errorMsg.includes('abort')) {
						safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: errorMsg })}\n\n`);
					}
				}
			}

			if (!controllerClosed) {
				try {
					controller.close();
				} catch {
					// Already closed
				}
			}
		},
		cancel() {
			controllerClosed = true;
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
			abortController?.abort();
			abortController = null;
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
