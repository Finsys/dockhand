// tests/sse-run-recorder.test.ts
import { describe, expect, test } from 'bun:test';
import { createJobResponse, type RunRecorder } from '../src/lib/server/sse';

/** A fake RunRecorder that records every line() call and resolves `ended` when end() fires. */
function createFakeRecorder() {
	const lines: string[] = [];
	let resolveEnded!: (v: { ok: boolean; exitCode?: number; error?: string }) => void;
	const ended = new Promise<{ ok: boolean; exitCode?: number; error?: string }>((resolve) => {
		resolveEnded = resolve;
	});
	const recorder: RunRecorder = {
		line(line: string) {
			lines.push(line);
		},
		addSecrets() {
			// Not exercised by this file's tests -- they cover createJobResponse's own
			// line()/end() plumbing, not the F4 addSecrets() wiring (see
			// deploy-run-record.test.ts and the route-level regression tests for that).
		},
		async end(ok: boolean, exitCode?: number, error?: string) {
			resolveEnded({ ok, exitCode, error });
		}
	};
	return { recorder, lines, ended };
}

/** Sends a status line (not recordable), two progress lines (recordable), and an
 *  unredacted result (never recordable) -- exercises shouldRecord's real filter. */
const runOperation = async (send: (event: string, data: unknown) => void) => {
	send('progress', { status: 'Deploying stack...' });
	send('progress', { type: 'line', line: 'Container web Started' });
	send('progress', { type: 'line', line: 'Container web Healthy' });
	send('result', { success: true, output: 'DB_PASSWORD=hunter2' });
};

describe('createJobResponse RunRecorder hook', () => {
	test('records qualifying lines on the JSON path (Accept: application/json)', async () => {
		const { recorder, lines, ended } = createFakeRecorder();
		const request = new Request('http://x', { headers: { Accept: 'application/json' } });

		const response = createJobResponse(runOperation, request, recorder);
		await response.json();
		const end = await ended;

		expect(lines).toEqual(['Container web Started', 'Container web Healthy']);
		expect(end.ok).toBe(true);
		expect(end.error).toBeUndefined();
	});

	test('records the SAME qualifying lines on the streaming path (no Accept header)', async () => {
		const { recorder, lines, ended } = createFakeRecorder();
		const request = new Request('http://x');

		createJobResponse(runOperation, request, recorder);
		await ended;

		expect(lines).toEqual(['Container web Started', 'Container web Healthy']);
	});

	test('both send() implementations feed the recorder identical lines', async () => {
		const jsonSide = createFakeRecorder();
		const streamSide = createFakeRecorder();

		const jsonResponse = createJobResponse(
			runOperation,
			new Request('http://x', { headers: { Accept: 'application/json' } }),
			jsonSide.recorder
		);
		await jsonResponse.json();
		await jsonSide.ended;

		createJobResponse(runOperation, new Request('http://x'), streamSide.recorder);
		await streamSide.ended;

		expect(streamSide.lines).toEqual(jsonSide.lines);
		expect(jsonSide.lines).toEqual(['Container web Started', 'Container web Healthy']);
	});

	test('streaming path: end() reports ok=false with the error message when the operation throws', async () => {
		const { recorder, ended } = createFakeRecorder();

		createJobResponse(
			async () => {
				throw new Error('boom');
			},
			new Request('http://x'),
			recorder
		);

		const end = await ended;
		expect(end.ok).toBe(false);
		expect(end.error).toBe('boom');
	});

	test('streaming path: end() reports ok=false with the error message on a failed result that RESOLVES (no throw) -- this is the path every browser call takes, since neither +page.svelte nor StackModal.svelte set an Accept header', async () => {
		const { recorder, ended } = createFakeRecorder();
		const request = new Request('http://x'); // no Accept header -> fire-and-forget path

		createJobResponse(
			async (send) => {
				// A failed docker compose up does NOT throw -- it sends a failed result and
				// returns normally. That lands this in the .then() branch below, never .catch().
				send('result', { success: false, error: 'compose up failed: exit 1' });
			},
			request,
			recorder
		);

		const end = await ended;
		expect(end.ok).toBe(false);
		expect(end.error).toBe('compose up failed: exit 1');
	});

	// Companion to the test above: a resolving (non-throwing) SUCCESS must still end up
	// ok=true on the streaming path, so the fix doesn't flip the polarity for the common case.
	test('streaming path: end() reports ok=true on a successful result that resolves (no throw)', async () => {
		const { recorder, ended } = createFakeRecorder();
		const request = new Request('http://x');

		createJobResponse(
			async (send) => {
				send('result', { success: true, output: 'done' });
			},
			request,
			recorder
		);

		const end = await ended;
		expect(end.ok).toBe(true);
		expect(end.error).toBeUndefined();
	});

	test('JSON path: end() reports ok=false with the error message on a failed result', async () => {
		const { recorder, ended } = createFakeRecorder();
		const request = new Request('http://x', { headers: { Accept: 'application/json' } });

		const response = createJobResponse(
			async (send) => {
				send('result', { success: false, error: 'compose failed' });
			},
			request,
			recorder
		);
		await response.json();

		const end = await ended;
		expect(end.ok).toBe(false);
		expect(end.error).toBe('compose failed');
	});

	test('streaming path: a recorder.end() that itself throws is never called twice', async () => {
		// Guards RunRecorder's "end() is called exactly once" contract from sse.ts's own
		// side: if the .then() branch's recorder.end() call throws, that rejection must
		// not cause .catch() to invoke end() again.
		let calls = 0;
		const recorder: RunRecorder = {
			line() {},
			addSecrets() {},
			async end() {
				calls++;
				throw new Error('recorder failure');
			}
		};
		const request = new Request('http://x'); // no Accept header -> fire-and-forget path

		createJobResponse(
			async (send) => {
				send('result', { success: true, output: 'done' });
			},
			request,
			recorder
		);

		// Let the .then()/.catch() microtasks (including the rejected recorder.end() call
		// and its handling) settle before asserting.
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(calls).toBe(1);
	});

	test('omitting the recorder changes nothing (backward compat)', async () => {
		const request = new Request('http://x', { headers: { Accept: 'application/json' } });
		const response = createJobResponse(runOperation, request);
		const body = await response.json();
		expect(body).toEqual({ success: true, output: 'DB_PASSWORD=hunter2' });
	});
});
