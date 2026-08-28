import type { ChildProcess } from 'node:child_process';

/**
 * Collect stdout, stderr and exit code from a spawned process.
 */
export function collectProcess(proc: ChildProcess): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
		proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
		proc.on('error', reject);
		proc.on('close', (code) => {
			resolve({
				exitCode: code ?? 1,
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString()
			});
		});
	});
}
