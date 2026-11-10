/**
 * Run a command to completion and hand back its output as data, never throwing.
 * An aborted `signal` kills the child; the run then resolves as a failure.
 */
import { spawn } from 'child_process';
import { classifyProcClose, classifyProcError } from './restic-script';
import type { ResticRun } from './models';

export function runProcess(
	command: string,
	args: string[],
	opts: { env: NodeJS.ProcessEnv; timeout?: number; signal?: AbortSignal },
	stream?: { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }
): Promise<ResticRun> {
	return new Promise<ResticRun>((resolve) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const done = (run: ResticRun) => { if (!settled) { settled = true; resolve(run); } };

		const proc = spawn(command, args, opts);
		proc.stdout.on('data', (d) => { const s = String(d); stdout += s; stream?.onStdout?.(s); });
		proc.stderr.on('data', (d) => { const s = String(d); stderr += s; stream?.onStderr?.(s); });
		proc.on('close', (code, signal) => {
			const { exitCode, stderr: stderrOut } = classifyProcClose(code, signal, stderr);
			done({ exitCode, stdout, stderr: stderrOut });
		});
		proc.on('error', (err) => {
			// Not spawnable, or killed by the caller's signal - a real failure, surfaced as data.
			const { exitCode, stderr: stderrOut } = classifyProcError(err, stderr);
			done({ exitCode, stdout, stderr: stderrOut });
		});
	});
}
