/**
 * Tests for line consumption on the Hawser compose path. A new agent sends its output as
 * 'stream' messages while the command runs AND still returns the whole block in its final
 * response. Only one of the two may reach the operator: the lines win, the block is the
 * fallback for an agent that sends none. Without that rule the operator sees everything twice.
 *
 * executeComposeViaHawser cannot be imported here -- stacks.ts pulls in db/drizzle ->
 * better-sqlite3, which bun's test runner cannot load, and a failed import poisons unrelated
 * tests in the same process (see stacks-collect-process.test.ts for the same constraint).
 * What it composes is testable, so this wires those pieces the way stacks.ts wires them: the
 * real message dispatcher, base64 decode included, feeding the real sink.
 */

import { describe, expect, test } from 'bun:test';
import { makeRedactedLineSink } from '../src/lib/server/secret-redaction.js';
import { dispatchStreamMessage, type StreamDispatchTarget } from '../src/lib/server/hawser-core.js';

const REQUEST_ID = 'compose-1';

/**
 * Stands in for a Hawser agent: each line arrives as a 'stream' message carrying base64 data
 * (Go marshals []byte that way), then the response arrives with the final output block.
 */
function runFakeAgent(
	sink: ReturnType<typeof makeRedactedLineSink>,
	agent: { lines: string[]; output?: string }
): void {
	const connection: StreamDispatchTarget = {
		pendingStreamRequests: new Map(),
		lineHandlers: new Map()
	};
	if (sink.forward) connection.lineHandlers!.set(REQUEST_ID, sink.forward);

	for (const line of agent.lines) {
		dispatchStreamMessage(connection, {
			requestId: REQUEST_ID,
			data: Buffer.from(line).toString('base64')
		});
	}

	// The 'response' case in hawser.ts drops the handler once the request is done.
	connection.lineHandlers!.delete(REQUEST_ID);
	sink.surfaceBlock(agent.output);
}

describe('compose lines from a Hawser agent', () => {
	test('forwards lines from a new agent redacted', () => {
		const seen: string[] = [];
		const secret = 'sup3rsecret-password-42';
		const sink = makeRedactedLineSink((l) => seen.push(l), [secret]);

		runFakeAgent(sink, { lines: [`password=${secret}`, 'Container app-1  Started'] });

		expect(seen.join('\n')).not.toContain(secret);
		expect(seen).toEqual(['password=***', 'Container app-1  Started']);
	});

	test('does not append the output block on top of the streamed lines', () => {
		const seen: string[] = [];
		const sink = makeRedactedLineSink((l) => seen.push(l), []);

		// A new agent sends both: the lines as they happen, plus the whole block at the end.
		runFakeAgent(sink, {
			lines: ['Container app-1  Recreate', 'Container app-1  Started'],
			output: 'Container app-1  Recreate\nContainer app-1  Started'
		});

		expect(seen).toEqual(['Container app-1  Recreate', 'Container app-1  Started']);
	});

	test('surfaces the block when an old agent sends no lines at all', () => {
		const seen: string[] = [];
		const sink = makeRedactedLineSink((l) => seen.push(l), []);

		runFakeAgent(sink, { lines: [], output: 'Container app-1  Started' });

		expect(seen).toEqual(['Container app-1  Started']);
	});

	test('surfaces the block when every line was withheld by redaction', () => {
		const seen: string[] = [];
		// Shorter than MIN_REPLACEABLE_LENGTH, so the whole line is withheld rather than patched.
		const sink = makeRedactedLineSink((l) => seen.push(l), ['pw123']);

		runFakeAgent(sink, { lines: ['token=pw123'], output: 'Container app-1  Started' });

		// A withheld line never reached the operator, so it must not count as one seen --
		// otherwise this run would show nothing at all.
		expect(seen).toEqual(['Container app-1  Started']);
	});
});
