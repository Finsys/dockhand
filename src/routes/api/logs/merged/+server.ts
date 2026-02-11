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
 * Parse Docker log line with timestamp
 * Format: 2024-01-15T10:30:00.123456789Z log content here
 */
function parseTimestampedLog(line: string): { timestamp: Date | null; content: string } {
	// Match RFC3339Nano timestamp at start of line
	const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*/);
	if (match) {
		return {
			timestamp: new Date(match[1]),
			content: line.slice(match[0].length)
		};
	}
	return { timestamp: null, content: line };
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

// Color palette for different containers
const CONTAINER_COLORS = [
	'#60a5fa', // blue
	'#4ade80', // green
	'#f472b6', // pink
	'#facc15', // yellow
	'#a78bfa', // purple
	'#fb923c', // orange
	'#22d3ee', // cyan
	'#f87171', // red
	'#34d399', // emerald
	'#c084fc', // violet
];

interface ContainerLogSource {
	containerId: string;
	containerName: string;
	color: string;
	hasTty: boolean;
	reader: ReadableStreamDefaultReader<Uint8Array> | null;
	buffer: Buffer;
	done: boolean;
}

interface EdgeContainerLogSource {
	containerId: string;
	containerName: string;
	color: string;
	hasTty: boolean;
	buffer: Buffer;
	done: boolean;
	cancel: () => void;
}

/**
 * Handle merged logs streaming for Hawser Edge connections
 */
async function handleEdgeMergedLogs(containerIds: string[], tail: string, environmentId: number): Promise<Response> {
	// Check if edge agent is connected
	if (!isEdgeConnected(environmentId)) {
		return new Response(JSON.stringify({ error: 'Edge agent not connected' }), {
			status: 503,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	let controllerClosed = false;
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	const sources: EdgeContainerLogSource[] = [];

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

			// Send heartbeat to keep connection alive (every 5s to prevent Traefik 10s idle timeout)
			heartbeatInterval = setInterval(() => {
				safeEnqueue(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
			}, 5000);

			// Setup function for a single container via Edge
			const setupEdgeContainer = async (containerId: string, index: number): Promise<EdgeContainerLogSource | null> => {
				try {
					// Get container info (name and TTY status)
					const inspectPath = `/containers/${containerId}/json`;
					const inspectResponse = await sendEdgeRequest(environmentId, 'GET', inspectPath);

					if (inspectResponse.statusCode !== 200) {
						console.log(`[merged-logs-edge] Inspect failed for ${containerId.slice(0, 12)}, skipping`);
						return null;
					}

					const info = JSON.parse(inspectResponse.body as string);
					const containerName = info.Name?.replace(/^\//, '') || containerId.slice(0, 12);
					const hasTty = info.Config?.Tty ?? false;

					const source: EdgeContainerLogSource = {
						containerId,
						containerName,
						color: CONTAINER_COLORS[index % CONTAINER_COLORS.length],
						hasTty,
						buffer: Buffer.alloc(0),
						done: false,
						cancel: () => {}
					};

					// Start log stream for this container via Edge
					const logsPath = `/containers/${containerId}/logs?stdout=true&stderr=true&follow=true&tail=${tail}&timestamps=true`;

					const { cancel } = sendEdgeStreamRequest(
						environmentId,
						'GET',
						logsPath,
						{
							onData: (data: string, streamType?: 'stdout' | 'stderr') => {
								if (controllerClosed || source.done) return;

								if (hasTty) {
									// TTY mode: data is raw text, may be base64 encoded
									let text = data;
									try {
										text = Buffer.from(data, 'base64').toString('utf-8');
									} catch {
										// Not base64, use as-is
									}

									const lines = text.split('\n');
									for (const line of lines) {
										if (line.trim()) {
											const { timestamp, content } = parseTimestampedLog(line);
											safeEnqueue(`event: log\ndata: ${JSON.stringify({
												containerId: source.containerId,
												containerName: source.containerName,
												color: source.color,
												text: content + '\n',
												timestamp: timestamp?.toISOString()
											})}\n\n`);
										}
									}
								} else {
									// Non-TTY mode: data might be base64 encoded Docker multiplexed stream
									let rawData: Buffer;
									try {
										rawData = Buffer.from(data, 'base64');
									} catch {
										rawData = Buffer.from(data, 'utf-8');
									}

									source.buffer = Buffer.concat([source.buffer, rawData]);

									// Process complete frames
									let offset = 0;
									while (true) {
										const frame = parseDockerFrame(source.buffer, offset);
										if (!frame) break;

										if (frame.payload) {
											const lines = frame.payload.split('\n');
											for (const line of lines) {
												if (line.trim()) {
													const { timestamp, content } = parseTimestampedLog(line);
													safeEnqueue(`event: log\ndata: ${JSON.stringify({
														containerId: source.containerId,
														containerName: source.containerName,
														color: source.color,
														text: content + '\n',
														timestamp: timestamp?.toISOString(),
														stream: frame.type === 2 ? 'stderr' : 'stdout'
													})}\n\n`);
												}
											}
										}
										offset += frame.size;
									}

									source.buffer = source.buffer.slice(offset);
								}
							},
							onEnd: (reason?: string) => {
								source.done = true;
								// Check if all sources are done
								if (sources.every(s => s.done)) {
									safeEnqueue(`event: end\ndata: ${JSON.stringify({ reason: 'all streams ended' })}\n\n`);
									if (!controllerClosed) {
										try {
											controller.close();
										} catch {
											// Already closed
										}
									}
								}
							},
							onError: (error: string) => {
								console.error(`[merged-logs-edge] Error from ${containerName}:`, error);
								source.done = true;
							}
						}
					);

					source.cancel = cancel;
					return source;
				} catch (error) {
					console.error(`[merged-logs-edge] Error setting up log source for ${containerId}:`, error);
					return null;
				}
			};

			// Setup all containers in parallel
			console.log(`[merged-logs-edge] Setting up ${containerIds.length} containers in parallel...`);
			const setupStart = Date.now();
			const results = await Promise.all(
				containerIds.map((id, index) => setupEdgeContainer(id, index))
			);
			console.log(`[merged-logs-edge] Parallel setup completed in ${Date.now() - setupStart}ms`);

			// Filter out failed containers
			for (const result of results) {
				if (result) {
					sources.push(result);
				}
			}

			if (sources.length === 0) {
				console.log('[merged-logs-edge] No valid sources, returning error');
				safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: 'No valid containers found' })}\n\n`);
				if (!controllerClosed) controller.close();
				return;
			}

			console.log(`[merged-logs-edge] Sources ready: ${sources.length}, sending connected event`);
			// Send connected event with container info
			safeEnqueue(`event: connected\ndata: ${JSON.stringify({
				containers: sources.map(s => ({
					id: s.containerId,
					name: s.containerName,
					color: s.color
				}))
			})}\n\n`);

			// Edge streaming is handled by callbacks, no polling loop needed
		},
		cancel() {
			controllerClosed = true;
			if (heartbeatInterval) {
				clearInterval(heartbeatInterval);
				heartbeatInterval = null;
			}
			// Cancel all active streams
			for (const source of sources) {
				if (source.cancel) {
					source.cancel();
				}
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

export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	// Parse container IDs from comma-separated list
	const containerIds = url.searchParams.get('containers')?.split(',').filter(Boolean) || [];
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

	if (containerIds.length === 0) {
		return new Response(JSON.stringify({ error: 'No containers specified' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	console.log(`[merged-logs] Request: containers=${containerIds.length}, env=${envId}`);
	const config = await getDockerConfig(envIdNum);
	console.log(`[merged-logs] Config: type=${config.type}, host=${config.host}, port=${config.port}`);

	// Handle Hawser Edge mode separately
	if (config.type === 'hawser-edge') {
		return handleEdgeMergedLogs(containerIds, tail, config.environmentId!);
	}

	let controllerClosed = false;
	const abortControllers: AbortController[] = [];
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

			// Send heartbeat to keep connection alive (every 5s to prevent Traefik 10s idle timeout)
			heartbeatInterval = setInterval(() => {
				safeEnqueue(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
			}, 5000);

			// Initialize log sources for each container - PARALLEL setup for better performance
			const sources: ContainerLogSource[] = [];

			// Setup function for a single container
			const setupContainer = async (containerId: string, index: number): Promise<ContainerLogSource | null> => {
				const abortController = new AbortController();
				abortControllers.push(abortController);

				try {
					// Get container info (name and TTY status)
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

						// Build fetch options - only include tls for HTTPS
						const fetchOptions: any = {
							headers: inspectHeaders,
							signal: AbortSignal.timeout(30000)
						};
						if (config.type === 'https') {
							fetchOptions.tls = {
								sessionTimeout: 0,
								servername: config.host,
								rejectUnauthorized: !config.skipVerify
							};
							if (config.ca) fetchOptions.tls.ca = [config.ca];
							if (config.cert) fetchOptions.tls.cert = [config.cert];
							if (config.key) fetchOptions.tls.key = config.key;
							fetchOptions.keepalive = false;
							if (process.env.DEBUG_TLS) fetchOptions.verbose = true;
						}

						inspectResponse = await fetch(inspectUrl, fetchOptions);
					}

					if (!inspectResponse.ok) {
						console.log(`[merged-logs] Inspect failed for ${containerId.slice(0, 12)}, skipping`);
						return null;
					}

					const info = await inspectResponse.json();
					const containerName = info.Name?.replace(/^\//, '') || containerId.slice(0, 12);
					const hasTty = info.Config?.Tty ?? false;

					// Start log stream for this container
					const logsPath = `/containers/${containerId}/logs?stdout=true&stderr=true&follow=true&tail=${tail}&timestamps=true`;
					let logsResponse: Response;

					if (config.type === 'socket') {
						logsResponse = await fetch(`http://localhost${logsPath}`, {
							// @ts-ignore - Bun supports unix socket
							unix: config.socketPath,
							signal: abortController.signal
						});
					} else {
						const logsUrl = `${config.type}://${config.host}:${config.port}${logsPath}`;
						const logsHeaders: Record<string, string> = {};
						if (config.hawserToken) logsHeaders['X-Hawser-Token'] = config.hawserToken;

						// For logs streaming, use the cleanup abort controller without a timeout
						// (the stream needs to stay open indefinitely)
						const fetchOptions: any = {
							headers: logsHeaders,
							signal: abortController.signal
						};
						if (config.type === 'https') {
							fetchOptions.tls = {
								sessionTimeout: 0,
								servername: config.host,
								rejectUnauthorized: !config.skipVerify
							};
							if (config.ca) fetchOptions.tls.ca = [config.ca];
							if (config.cert) fetchOptions.tls.cert = [config.cert];
							if (config.key) fetchOptions.tls.key = config.key;
							fetchOptions.keepalive = false;
							if (process.env.DEBUG_TLS) fetchOptions.verbose = true;
						}

						logsResponse = await fetch(logsUrl, fetchOptions);
					}

					if (!logsResponse.ok) {
						console.error(`[merged-logs] Failed to get logs for container ${containerId}: ${logsResponse.status}`);
						return null;
					}

					const reader = logsResponse.body?.getReader() || null;

					return {
						containerId,
						containerName,
						color: CONTAINER_COLORS[index % CONTAINER_COLORS.length],
						hasTty,
						reader,
						buffer: Buffer.alloc(0),
						done: false
					};
				} catch (error) {
					console.error(`Error setting up log source for ${containerId}:`, error);
					return null;
				}
			};

			// Setup all containers in parallel
			console.log(`[merged-logs] Setting up ${containerIds.length} containers in parallel...`);
			const setupStart = Date.now();
			const results = await Promise.all(
				containerIds.map((id, index) => setupContainer(id, index))
			);
			console.log(`[merged-logs] Parallel setup completed in ${Date.now() - setupStart}ms`);

			// Filter out failed containers
			for (const result of results) {
				if (result) {
					sources.push(result);
				}
			}

			if (sources.length === 0) {
				console.log('[merged-logs] No valid sources, returning error');
				safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: 'No valid containers found' })}\n\n`);
				if (!controllerClosed) controller.close();
				return;
			}

			console.log(`[merged-logs] Sources ready: ${sources.length}, sending connected event`);
			// Send connected event with container info
			safeEnqueue(`event: connected\ndata: ${JSON.stringify({
				containers: sources.map(s => ({
					id: s.containerId,
					name: s.containerName,
					color: s.color
				}))
			})}\n\n`);

			// Process logs from all sources
			const processSource = async (source: ContainerLogSource) => {
				if (!source.reader || source.done) return;

				try {
					const { done, value } = await source.reader.read();

					if (done) {
						source.done = true;
						return;
					}

					if (value) {
						if (source.hasTty) {
							// TTY mode: raw text
							const text = new TextDecoder().decode(value);
							const lines = text.split('\n');
							for (const line of lines) {
								if (line.trim()) {
									const { timestamp, content } = parseTimestampedLog(line);
									safeEnqueue(`event: log\ndata: ${JSON.stringify({
										containerId: source.containerId,
										containerName: source.containerName,
										color: source.color,
										text: content + '\n',
										timestamp: timestamp?.toISOString()
									})}\n\n`);
								}
							}
						} else {
							// Non-TTY mode: demux Docker stream frames
							source.buffer = Buffer.concat([source.buffer, Buffer.from(value)]);

							let offset = 0;
							while (true) {
								const frame = parseDockerFrame(source.buffer, offset);
								if (!frame) break;

								if (frame.payload) {
									const lines = frame.payload.split('\n');
									for (const line of lines) {
										if (line.trim()) {
											const { timestamp, content } = parseTimestampedLog(line);
											safeEnqueue(`event: log\ndata: ${JSON.stringify({
												containerId: source.containerId,
												containerName: source.containerName,
												color: source.color,
												text: content + '\n',
												timestamp: timestamp?.toISOString(),
												stream: frame.type === 2 ? 'stderr' : 'stdout'
											})}\n\n`);
										}
									}
								}
								offset += frame.size;
							}

							source.buffer = source.buffer.slice(offset);
						}
					}
				} catch (error) {
					if (!String(error).includes('abort')) {
						console.error(`Error reading logs from ${source.containerName}:`, error);
					}
					source.done = true;
				}
			};

			// Continuously process all sources
			console.log('[merged-logs] Starting processing loop');
			let loopCount = 0;
			while (!controllerClosed) {
				const activeSources = sources.filter(s => !s.done && s.reader);
				if (activeSources.length === 0) {
					safeEnqueue(`event: end\ndata: ${JSON.stringify({ reason: 'all streams ended' })}\n\n`);
					break;
				}

				if (loopCount === 0) {
					console.log(`[merged-logs] Processing ${activeSources.length} active sources, first read...`);
				}
				loopCount++;

				await Promise.all(activeSources.map(processSource));

				// Small delay to prevent tight loop
				await new Promise(resolve => setTimeout(resolve, 10));
			}

			// Cleanup readers
			for (const source of sources) {
				if (source.reader) {
					try {
						source.reader.releaseLock();
					} catch {
						// Ignore
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
			for (const ac of abortControllers) {
				ac.abort();
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
};
