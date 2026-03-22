/**
 * Container Event Emitter
 *
 * Shared EventEmitter for broadcasting container events to SSE clients.
 * Events are emitted by the collection worker when processing Docker events.
 *
 * IMPORTANT: Uses globalThis to ensure a single instance across all module imports.
 * In Vite dev mode and SvelteKit production builds, server modules can be loaded
 * multiple times (HMR, chunking), creating separate EventEmitter instances.
 * Using globalThis guarantees emitters and listeners share the same object.
 */

import { EventEmitter } from 'node:events';

const GLOBAL_KEY = '__dockhand_container_event_emitter__';

// Ensure single instance via globalThis
if (!(globalThis as any)[GLOBAL_KEY]) {
	const emitter = new EventEmitter();
	// Allow up to 100 concurrent SSE listeners (default is 10)
	// This prevents MaxListenersExceededWarning with many dashboard clients
	emitter.setMaxListeners(100);
	(globalThis as any)[GLOBAL_KEY] = emitter;
}

export const containerEventEmitter: EventEmitter = (globalThis as any)[GLOBAL_KEY];
