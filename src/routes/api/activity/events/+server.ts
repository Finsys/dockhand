import type { RequestHandler } from './$types';
import { containerEventEmitter } from '$lib/server/event-collector';
import { authorize } from '$lib/server/authorize';
import { json } from '@sveltejs/kit';


export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// Permission check for activity viewing
	if (auth.authEnabled && !await auth.can('activity', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Get accessible environment IDs for filtering (enterprise only)
	let accessibleEnvIds: number[] | null = null;
	if (auth.isEnterprise && auth.authEnabled && !auth.isAdmin) {
		accessibleEnvIds = await auth.getAccessibleEnvironmentIds();
		// If user has no access to any environment, return empty stream
		if (accessibleEnvIds !== null && accessibleEnvIds.length === 0) {
			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`));
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
	}

	let heartbeatInterval: ReturnType<typeof setInterval>;
	let handleEvent: ((event: any) => void) | null = null;
	let handleEnvStatus: ((status: any) => void) | null = null;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const sendEvent = (type: string, data: any) => {
				try {
					const event = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
					controller.enqueue(encoder.encode(event));
				} catch {
					// Ignore errors when client disconnects
				}
			};

			// Send initial connection event

			sendEvent('connected', { timestamp: new Date().toISOString() });

			// Send heartbeat to keep connection alive (every 5s to prevent Traefik 10s idle timeout)
			heartbeatInterval = setInterval(() => {
				try {
					sendEvent('heartbeat', { timestamp: new Date().toISOString() });
				} catch {
					clearInterval(heartbeatInterval);
				}
			}, 5000);

			// Listen for new container events (filter by accessible environments)
			handleEvent = (event: any) => {
				// If accessibleEnvIds is null, user has access to all environments
				// Otherwise, filter by accessible environment IDs
				if (accessibleEnvIds === null || (event.environmentId && accessibleEnvIds.includes(event.environmentId))) {
					sendEvent('activity', event);
				}
			};

			// Listen for environment status changes (online/offline)
			handleEnvStatus = (status: any) => {
				if (accessibleEnvIds === null || (status.envId && accessibleEnvIds.includes(status.envId))) {
					sendEvent('env_status', status);
				}
			};

			containerEventEmitter.on('event', handleEvent);
			containerEventEmitter.on('env_status', handleEnvStatus);
		},
		cancel() {
			// Cleanup when client disconnects

			clearInterval(heartbeatInterval);
			if (handleEvent) {
				containerEventEmitter.off('event', handleEvent);
				handleEvent = null;
			}
			if (handleEnvStatus) {
				containerEventEmitter.off('env_status', handleEnvStatus);
				handleEnvStatus = null;
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
