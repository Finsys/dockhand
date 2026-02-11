import { writable, get } from 'svelte/store';

export interface AuditLogEntry {
	id: number;
	userId: number | null;
	username: string;
	action: string;
	entityType: string;
	entityId: string | null;
	entityName: string | null;
	environmentId: number | null;
	environmentName: string | null;
	environmentIcon: string | null;
	description: string | null;
	details: any | null;
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: string;
}

export type AuditEventCallback = (event: AuditLogEntry) => void;

// Connection state
export const auditSseConnected = writable<boolean>(false);
export const auditSseError = writable<string | null>(null);
export const lastAuditEvent = writable<AuditLogEntry | null>(null);

// Event listeners
const listeners: Set<AuditEventCallback> = new Set();

let eventSource: EventSource | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;

// Subscribe to audit events
export function onAuditEvent(callback: AuditEventCallback): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

// Notify all listeners
function notifyListeners(event: AuditLogEntry) {
	lastAuditEvent.set(event);
	listeners.forEach(callback => {
		try {
			callback(event);
		} catch (e) {
			console.error('Audit event listener error:', e);
		}
	});
}

// Connect to SSE endpoint
export function connectAuditSSE() {
	// Close existing connection
	disconnectAuditSSE();

	try {
		eventSource = new EventSource('/api/audit/events');

		eventSource.addEventListener('connected', (e) => {
			console.log('Audit SSE connected');
			auditSseConnected.set(true);
			auditSseError.set(null);
			reconnectAttempts = 0;
		});

		eventSource.addEventListener('audit', (e) => {
			try {
				const event: AuditLogEntry = JSON.parse(e.data);
				notifyListeners(event);
			} catch (err) {
				console.error('Failed to parse audit event:', err);
			}
		});

		eventSource.addEventListener('heartbeat', () => {
			// Connection is alive
		});

		eventSource.addEventListener('error', (e) => {
			console.error('Audit SSE error:', e);
			auditSseConnected.set(false);

			// Attempt reconnection
			if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
				reconnectAttempts++;
				auditSseError.set(`Connection lost. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
				reconnectTimeout = setTimeout(() => {
					connectAuditSSE();
				}, RECONNECT_DELAY);
			} else {
				auditSseError.set('Connection failed. Refresh the page to retry.');
			}
		});

		eventSource.onerror = () => {
			// Handled by error event listener
		};

	} catch (error: any) {
		console.error('Failed to create Audit EventSource:', error);
		auditSseError.set(error.message || 'Failed to connect');
		auditSseConnected.set(false);
	}
}

// Disconnect from SSE
export function disconnectAuditSSE() {
	if (reconnectTimeout) {
		clearTimeout(reconnectTimeout);
		reconnectTimeout = null;
	}
	if (eventSource) {
		eventSource.close();
		eventSource = null;
	}
	auditSseConnected.set(false);
	auditSseError.set(null);
	reconnectAttempts = 0;
}
