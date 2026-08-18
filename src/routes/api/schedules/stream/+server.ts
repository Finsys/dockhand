/**
 * Schedules Stream API - Real-time schedule updates via SSE
 *
 * GET /api/schedules/stream - Server-Sent Events stream for schedule updates
 */

import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { buildSchedulesList } from '$lib/server/schedules-list';


/**
 * @openapi
 * summary: Server-Sent Events stream that polls and pushes schedule updates (same shape as GET /api/schedules)
 * resp-200: text/event-stream response, periodically emitting the current schedule list as SSE "data:" messages
 * resp-403: Permission denied (RBAC 'schedules:view' missing)
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('schedules', 'view')) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const accessibleEnvIds = await auth.getAccessibleEnvironmentIds();

	const getFilteredSchedules = async () => {
		const schedules = await buildSchedulesList();
		if (accessibleEnvIds === null) return schedules;
		return schedules.filter(s =>
			s.environmentId === null || accessibleEnvIds.includes(s.environmentId));
	};

	let controllerClosed = false;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let isPolling = false;
	let initialDataSent = false;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();
			console.log('[Schedules Stream] New connection opened');

			const safeEnqueue = (data: string): boolean => {
				if (controllerClosed) {
					return false;
				}
				try {
					controller.enqueue(encoder.encode(data));
					return true;
				} catch (err) {
					console.log('[Schedules Stream] Controller closed during enqueue, cleaning up');
					controllerClosed = true;
					if (intervalId) {
						clearInterval(intervalId);
						intervalId = null;
					}
					return false;
				}
			};

			if (!safeEnqueue(`event: connected\ndata: {}\n\n`)) {
				return;
			}

			let retryCount = 0;
			const maxRetries = 2;

			while (!initialDataSent && retryCount <= maxRetries && !controllerClosed) {
				try {
					const schedules = await getFilteredSchedules();

					if (controllerClosed) {
						console.log('[Schedules Stream] Connection closed before initial data could be sent');
						return;
					}

					if (safeEnqueue(`event: schedules\ndata: ${JSON.stringify({ schedules })}\n\n`)) {
						initialDataSent = true;
						console.log('[Schedules Stream] Initial data sent successfully');
					} else {
						console.log('[Schedules Stream] Failed to enqueue initial data, connection closed');
						return;
					}
				} catch (error) {
					console.error(`[Schedules Stream] Failed to get initial schedules (attempt ${retryCount + 1}):`, error);
					retryCount++;

					if (retryCount > maxRetries) {
						safeEnqueue(`event: error\ndata: ${JSON.stringify({ error: String(error), fatal: true })}\n\n`);
						return;
					}

					await new Promise(resolve => setTimeout(resolve, 500));
				}
			}

			if (!initialDataSent) {
				console.log('[Schedules Stream] Initial data was never sent, not starting polling');
				return;
			}

			intervalId = setInterval(async () => {
				if (isPolling || controllerClosed) {
					if (controllerClosed && intervalId) {
						clearInterval(intervalId);
						intervalId = null;
					}
					return;
				}

				isPolling = true;
				try {
					const schedules = await getFilteredSchedules();
					safeEnqueue(`event: schedules\ndata: ${JSON.stringify({ schedules })}\n\n`);
				} catch (error) {
					console.error('[Schedules Stream] Failed to get schedules during poll:', error);
				} finally {
					isPolling = false;
				}
			}, 2000);
		},
		cancel() {
			console.log('[Schedules Stream] Connection cancelled, cleaning up');
			controllerClosed = true;
			if (intervalId) {
				clearInterval(intervalId);
				intervalId = null;
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
