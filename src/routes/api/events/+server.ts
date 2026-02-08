import type { RequestHandler } from './$types';
import { getDockerEvents, EnvironmentNotFoundError } from '$lib/server/docker';
import { getEnvironment } from '$lib/server/db';

export const GET: RequestHandler = async ({ url }) => {
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Early return if no environment specified
	if (!envIdNum) {
		return new Response(
			`event: info\ndata: ${JSON.stringify({ message: 'No environment selected' })}\n\n`,
			{
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache'
				}
			}
		);
	}

	// Check if this is an edge mode environment - events are pushed by the agent, not pulled
	const env = await getEnvironment(envIdNum);
	if (env?.connectionType === 'hawser-edge') {
		return new Response(
			`event: error\ndata: ${JSON.stringify({ message: 'Edge environments receive events via agent push, not this endpoint' })}\n\n`,
			{
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache'
				}
			}
		);
	}

	let heartbeatInterval: ReturnType<typeof setInterval>;
	let controllerClosed = false;
	let eventReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			// Safe close helper - prevents "Controller is already closed" errors
			const safeClose = () => {
				if (controllerClosed) return;
				try {
					controller.close();
					controllerClosed = true;
				} catch {
					// Controller already closed - ignore
					controllerClosed = true;
				}
			};

			// Send SSE event
			const sendEvent = (type: string, data: any) => {
				if (controllerClosed) return;
				try {
					const event = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(event));
				} catch {
					// Controller closed or errored - mark as closed
					controllerClosed = true;
				}
			};

			// Send heartbeat to keep connection alive (every 5s to prevent Traefik 10s idle timeout)
			heartbeatInterval = setInterval(() => {
				try {
					sendEvent('heartbeat', { timestamp: new Date().toISOString() });
				} catch {
					clearInterval(heartbeatInterval);
				}
			}, 5000);

			// Send initial connection event
			sendEvent('connected', { timestamp: new Date().toISOString(), envId: envIdNum });

			try {
				// Get Docker events stream
				const eventStream = await getDockerEvents(
					{ type: ['container', 'image', 'volume', 'network'] },
					envIdNum
				);

				if (!eventStream) {
					sendEvent('error', { message: 'Failed to connect to Docker events' });
					clearInterval(heartbeatInterval);
					safeClose();
					return;
				}

				eventReader = eventStream.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				const processEvents = async () => {
					try {
						while (true) {
							const { done, value } = await eventReader!.read();
							if (done) break;

							buffer += decoder.decode(value, { stream: true });
							const lines = buffer.split('\n');
							buffer = lines.pop() || '';

							for (const line of lines) {
								if (line.trim()) {
									try {
										const event = JSON.parse(line);

										// Map Docker event to our format
										const mappedEvent = {
											type: event.Type,
											action: event.Action,
											actor: {
												id: event.Actor?.ID,
												name: event.Actor?.Attributes?.name || event.Actor?.Attributes?.image,
												attributes: event.Actor?.Attributes
											},
											time: event.time,
											timeNano: event.timeNano
										};

										sendEvent('docker', mappedEvent);
									} catch {
										// Ignore parse errors for partial chunks
									}
								}
							}
						}
					} catch (error: any) {
						// Don't log full stack trace for expected connection errors
						const isConnectionError = error?.code === 'ECONNRESET' || error?.code === 'ECONNREFUSED';
						if (!isConnectionError) {
							console.error('Docker event stream error:', error?.message || error);
						}
						sendEvent('error', { message: error?.message || 'Stream connection lost' });
					} finally {
						clearInterval(heartbeatInterval);
						safeClose();
					}
				};

				processEvents();
			} catch (error: any) {
				if (error instanceof EnvironmentNotFoundError) {
					// Expected error when environment doesn't exist - don't spam logs
					sendEvent('error', { message: 'Environment not found' });
				} else {
					// Don't log full stack trace for expected connection errors
					const isConnectionError = error?.code === 'ECONNRESET' || error?.code === 'ECONNREFUSED';
					if (!isConnectionError) {
						console.error('Failed to connect to Docker events:', error?.message || error);
					}
					sendEvent('error', { message: error?.message || 'Failed to connect to Docker' });
				}
				clearInterval(heartbeatInterval);
				safeClose();
			}
		},
		cancel() {
			controllerClosed = true;
			clearInterval(heartbeatInterval);
			eventReader?.cancel().catch(() => {});
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			'X-Accel-Buffering': 'no' // Disable nginx buffering
		}
	});
};
