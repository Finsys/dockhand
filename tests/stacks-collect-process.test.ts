import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import { EventEmitter } from 'node:events';
import { collectProcess } from '../src/lib/server/process-output-core';

/** A minimal ChildProcess stand-in that lets a test drive the EXACT chunk
 *  boundaries and stdout/stderr interleaving a real spawn can't guarantee. */
function fakeProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.out = (s: string) => proc.stdout.emit('data', Buffer.from(s));
	proc.err = (s: string) => proc.stderr.emit('data', Buffer.from(s));
	proc.close = (code = 0) => proc.emit('close', code);
	return proc;
}

describe('collectProcess with a line callback', () => {
	test('emits each line separately and in order', async () => {
		const lines: string[] = [];
		const child = spawn('sh', ['-c', 'printf "eins\\nzwei\\ndrei\\n" >&2']);
		await collectProcess(child, (line) => lines.push(line));
		expect(lines).toEqual(['eins', 'zwei', 'drei']);
	});

	test('emits a trailing line that has no newline', async () => {
		const lines: string[] = [];
		const child = spawn('sh', ['-c', 'printf "ohne-umbruch" >&2']);
		await collectProcess(child, (line) => lines.push(line));
		expect(lines).toEqual(['ohne-umbruch']);
	});

	test('behaves exactly as before when no callback is given', async () => {
		const child = spawn('sh', ['-c', 'printf "unveraendert\\n" >&2']);
		const result = await collectProcess(child);
		expect(result.stderr).toContain('unveraendert');
	});

	test('does NOT splice a partial stdout line onto an interleaved stderr chunk', async () => {
		// stdout emits a partial line (no newline), stderr chunks arrive before the
		// stdout line is completed. With a shared buffer these would concatenate into
		// one corrupted line ("stdout-partSTDERR ..."); with per-stream buffers they
		// stay separate.
		const proc = fakeProc();
		const lines: string[] = [];
		const done = collectProcess(proc, (line) => lines.push(line));
		proc.out('stdout-part'); // partial, no '\n'
		proc.err('an error line\n'); // complete stderr line arrives mid-stdout-line
		proc.out(' rest\n'); // completes the stdout line
		proc.close(0);
		await done;
		expect(lines).toEqual(['an error line', 'stdout-part rest']);
	});

	test('flushes each stream trailing partial separately (stdout before stderr)', async () => {
		const proc = fakeProc();
		const lines: string[] = [];
		const done = collectProcess(proc, (line) => lines.push(line));
		proc.out('out-tail'); // partial stdout, never newline-terminated
		proc.err('err-tail'); // partial stderr, never newline-terminated
		proc.close(0);
		await done;
		expect(lines).toEqual(['out-tail', 'err-tail']);
	});
});
