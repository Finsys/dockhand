/**
 * Pure unit tests for SSE server-side parser (sseToJSON).
 * No server required — builds Response objects from raw strings.
 *
 * Run with: bun test tests/unit/sse-parser.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { sseToJSON } from '../src/lib/server/sse-parser';

// ---------------------------------------------------------------------------
// Helper: build a fake SSE Response from one or more raw string chunks
// ---------------------------------------------------------------------------
function makeSSEResponse(chunks: string[]): Response {
	let i = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(new TextEncoder().encode(chunks[i++]));
			} else {
				controller.close();
			}
		}
	});
	return new Response(stream, {
		headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
	});
}

// ---------------------------------------------------------------------------
// sseToJSON tests
// ---------------------------------------------------------------------------
describe('sseToJSON', () => {
	test('captures result event data', async () => {
		const sse = makeSSEResponse(['event: result\ndata: {"success":true}\n\n']);
		const json = await sseToJSON(sse);
		expect(json.headers.get('content-type')).toBe('application/json');
		expect(await json.json()).toEqual({ success: true });
	});

	test('progress events before result — returns result', async () => {
		const input =
			'event: progress\ndata: {"step":1}\n\n' +
			'event: result\ndata: {"ok":1}\n\n';
		const sse = makeSSEResponse([input]);
		expect(await (await sseToJSON(sse)).json()).toEqual({ ok: 1 });
	});

	test('no result event — returns fallback', async () => {
		const sse = makeSSEResponse(['event: progress\ndata: {"step":1}\n\n']);
		const body = await (await sseToJSON(sse)).json();
		expect(body.success).toBe(false);
		expect(body.error).toBe('No result');
	});

	test('multi-line valid JSON in result event is joined and parsed', async () => {
		// {"a":1,\n"b":2} is valid JSON
		const sse = makeSSEResponse(['event: result\ndata: {"a":1,\ndata: "b":2}\n\n']);
		expect(await (await sseToJSON(sse)).json()).toEqual({ a: 1, b: 2 });
	});

	test('CRLF line endings', async () => {
		const sse = makeSSEResponse(['event: result\r\ndata: {"ok":true}\r\n\r\n']);
		expect(await (await sseToJSON(sse)).json()).toEqual({ ok: true });
	});

	test('no trailing blank line (final flush)', async () => {
		const sse = makeSSEResponse(['event: result\ndata: {"success":true}']);
		expect(await (await sseToJSON(sse)).json()).toEqual({ success: true });
	});

	test('data: without space after colon', async () => {
		const sse = makeSSEResponse(['event: result\ndata:{"ok":1}\n\n']);
		expect(await (await sseToJSON(sse)).json()).toEqual({ ok: 1 });
	});
});
