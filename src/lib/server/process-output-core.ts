/**
 * Pure child-process output collector. No imports, so it is unit-testable in
 * the bun runner without dragging in better-sqlite3 via stacks.ts -> ./db ->
 * ./db/drizzle (top-level `await seedDatabase()`, unsupported under Bun --
 * see tests/stacks-collect-process.test.ts for the reproduction).
 */
import type { ChildProcess } from 'node:child_process';

export type LineCallback = (line: string) => void;

/**
 * Collect stdout/stderr from a child process and wait for it to exit.
 * When `onLine` is provided, it is called for each complete line (split on '\n')
 * seen on either stdout or stderr, in arrival order, as the process runs — plus
 * once more for a trailing partial line (no terminating '\n') once the process closes.
 * Without `onLine`, behavior is unchanged.
 */
export function collectProcess(
	proc: ChildProcess,
	onLine?: LineCallback
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		// One buffer PER stream. A single shared buffer would splice a partial
		// stdout line (no trailing '\n') onto the next stderr chunk (and vice
		// versa) when the two streams interleave, producing corrupted lines.
		let stdoutBuffer = '';
		let stderrBuffer = '';

		// Emit each complete line in `buf + chunk`, return the trailing partial.
		const emitLines = (buf: string, chunk: string): string => {
			if (!onLine) return buf;
			const parts = (buf + chunk).split('\n');
			const rest = parts.pop() ?? ''; // last part may be incomplete
			for (const line of parts) onLine(line);
			return rest;
		};

		proc.stdout?.on('data', (chunk: Buffer) => {
			stdoutChunks.push(chunk);
			stdoutBuffer = emitLines(stdoutBuffer, chunk.toString());
		});
		proc.stderr?.on('data', (chunk: Buffer) => {
			stderrChunks.push(chunk);
			stderrBuffer = emitLines(stderrBuffer, chunk.toString());
		});
		proc.on('error', reject);
		proc.on('close', (code) => {
			// Flush each stream's trailing partial line (stdout before stderr for a
			// deterministic order).
			if (onLine && stdoutBuffer.length > 0) {
				onLine(stdoutBuffer);
				stdoutBuffer = '';
			}
			if (onLine && stderrBuffer.length > 0) {
				onLine(stderrBuffer);
				stderrBuffer = '';
			}
			resolve({
				exitCode: code ?? 1,
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString()
			});
		});
	});
}
