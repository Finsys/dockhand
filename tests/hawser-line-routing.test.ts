/**
 * Unit tests for dispatchStreamMessage — the PURE 'stream' message routing logic, extracted
 * from hawser.ts's handleHawserWsMessage into hawser-core.ts. No DB import, so it is
 * unit-testable directly (importing hawser.ts pulls in db/drizzle -> better-sqlite3, which
 * bun's test runner can't load — see nav-preferences-core.test.ts for the same pattern).
 * hawser.ts re-exports dispatchStreamMessage so callers get it from one import site.
 *
 * Compose requests are sent with streaming: false and land in connection.pendingRequests
 * only. The message dispatcher's 'stream' case used to look up pendingStreamRequests
 * exclusively, so any line message for a non-streaming request vanished silently -- no error,
 * no warning. dispatchStreamMessage is the fix: it also checks a second, independent registry
 * (lineHandlers) for a matching callback.
 */

import { describe, expect, test } from 'bun:test';
import { dispatchStreamMessage, type StreamDispatchTarget } from '../src/lib/server/hawser-core.js';

describe('dispatchStreamMessage', () => {
	test('decodes a line message and passes it to the callback', () => {
		const seen: string[] = [];
		const conn: StreamDispatchTarget = { pendingStreamRequests: new Map(), lineHandlers: new Map() };
		conn.lineHandlers!.set('req-1', (l: string) => seen.push(l));

		// This is how it really arrives: Go encodes []byte as base64.
		dispatchStreamMessage(conn, { requestId: 'req-1', data: Buffer.from('first line').toString('base64') });

		expect(seen).toEqual(['first line']);
	});

	test('silently drops line messages with no registered callback', () => {
		const conn: StreamDispatchTarget = { pendingStreamRequests: new Map(), lineHandlers: new Map() };
		expect(() => dispatchStreamMessage(conn, { requestId: 'unknown', data: 'eA==' })).not.toThrow();
	});

	test('prefers pendingStreamRequests over lineHandlers for the same requestId', () => {
		const streamSeen: unknown[] = [];
		const lineSeen: string[] = [];
		const conn: StreamDispatchTarget = { pendingStreamRequests: new Map(), lineHandlers: new Map() };
		conn.pendingStreamRequests!.set('req-2', { onData: (d: unknown) => streamSeen.push(d) });
		conn.lineHandlers!.set('req-2', (l: string) => lineSeen.push(l));

		dispatchStreamMessage(conn, { requestId: 'req-2', data: 'raw-not-decoded' });

		expect(streamSeen).toEqual(['raw-not-decoded']);
		expect(lineSeen).toEqual([]);
	});

	test('tolerates a missing lineHandlers map (defensive, matches pendingStreamRequests handling)', () => {
		const conn: StreamDispatchTarget = { pendingStreamRequests: new Map() };
		expect(() =>
			dispatchStreamMessage(conn, { requestId: 'req-3', data: Buffer.from('x').toString('base64') })
		).not.toThrow();
	});
});
