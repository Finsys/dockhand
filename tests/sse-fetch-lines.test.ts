/**
 * readJobResponse's optional line callback — the "live output" hookup used by the UI.
 * Mocks global fetch to drive watchJob's polling loop through a scripted sequence of
 * job states, without a real server.
 *
 * Run with: bun test tests/sse-fetch-lines.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { readJobResponse } from '../src/lib/utils/sse-fetch';

interface JobLine {
	event?: string;
	data: unknown;
}

interface JobState {
	status: 'running' | 'done' | 'error';
	lines: JobLine[];
	result?: unknown;
}

// Not production code — a small test double for the /api/jobs/{jobId} polling
// endpoint that watchJob() calls. Returns the given states in order, then keeps
// returning the last one if polled again.
function mockJobPolling(states: JobState[]): typeof fetch {
	let call = 0;
	return (async () => {
		const state = states[Math.min(call, states.length - 1)];
		call++;
		return new Response(JSON.stringify({ id: 'x', ...state }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	}) as typeof fetch;
}

describe('readJobResponse with a line callback', () => {
	test('reports line messages to the callback', async () => {
		const seen: string[] = [];
		// Simulate the job poll response: first running with one line, then done with both.
		globalThis.fetch = mockJobPolling([
			{ status: 'running', lines: [{ event: 'progress', data: { type: 'line', line: 'first' } }] },
			{
				status: 'done',
				lines: [
					{ event: 'progress', data: { type: 'line', line: 'first' } },
					{ event: 'progress', data: { type: 'line', line: 'second' } }
				],
				result: { success: true }
			}
		]);

		await readJobResponse(new Response(JSON.stringify({ jobId: 'x' })), (l) => seen.push(l));
		expect(seen).toEqual(['first', 'second']);
	});

	test('stays unchanged without a callback', async () => {
		globalThis.fetch = mockJobPolling([
			{
				status: 'done',
				lines: [{ event: 'progress', data: { type: 'line', line: 'ignored' } }],
				result: { success: true }
			}
		]);
		const result = await readJobResponse(new Response(JSON.stringify({ jobId: 'x' })));
		expect(result.success).toBe(true);
	});
});
