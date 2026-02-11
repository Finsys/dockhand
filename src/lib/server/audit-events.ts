/**
 * Audit Events Broadcasting
 *
 * Server-side event emitter for broadcasting audit log entries to connected SSE clients.
 */

import { EventEmitter } from 'events';
import type { AuditLogCreateData } from './db';

export interface AuditEventData extends AuditLogCreateData {
	id: number;
	createdAt: string;
	environmentName?: string | null;
	environmentIcon?: string | null;
}

// Create a singleton event emitter for audit events
class AuditEventEmitter extends EventEmitter {
	constructor() {
		super();
		// Allow many listeners (one per connected SSE client)
		this.setMaxListeners(1000);
	}

	emit(event: 'audit', data: AuditEventData): boolean {
		return super.emit(event, data);
	}

	on(event: 'audit', listener: (data: AuditEventData) => void): this {
		return super.on(event, listener);
	}

	off(event: 'audit', listener: (data: AuditEventData) => void): this {
		return super.off(event, listener);
	}
}

export const auditEvents = new AuditEventEmitter();

/**
 * Broadcast a new audit event to all connected clients
 */
export function broadcastAuditEvent(data: AuditEventData): void {
	auditEvents.emit('audit', data);
}
