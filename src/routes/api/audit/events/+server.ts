import type { RequestHandler } from './$types';
import { authorize, enterpriseRequired } from '$lib/server/authorize';
import { auditEvents, type AuditEventData } from '$lib/server/audit-events';

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	// Audit log is Enterprise-only
	if (!auth.isEnterprise) {
		return new Response(JSON.stringify(enterpriseRequired()), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Check permission
	if (!await auth.canViewAuditLog()) {
		return new Response(JSON.stringify({ error: 'Permission denied' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	let heartbeatInterval: ReturnType<typeof setInterval>;
	let onAuditEvent: (data: AuditEventData) => void;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const sendEvent = (type: string, data: any) => {
				const event = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
				try {
					controller.enqueue(encoder.encode(event));
				} catch (e) {
					// Client disconnected
				}
			};

			sendEvent('connected', { timestamp: new Date().toISOString() });

			heartbeatInterval = setInterval(() => {
				try {
					sendEvent('heartbeat', { timestamp: new Date().toISOString() });
				} catch {
					clearInterval(heartbeatInterval);
				}
			}, 5000);

			onAuditEvent = (data: AuditEventData) => {
				sendEvent('audit', data);
			};

			auditEvents.on('audit', onAuditEvent);
		},
		cancel() {
			clearInterval(heartbeatInterval);
			auditEvents.off('audit', onAuditEvent);
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
