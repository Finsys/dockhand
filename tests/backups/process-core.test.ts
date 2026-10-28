import { describe, test, expect } from 'bun:test';
import { runProcess } from '../../src/lib/server/backups/process-core';

const env = { PATH: process.env.PATH };

describe('runProcess', () => {
	test('collects output and the exit code', async () => {
		const run = await runProcess('sh', ['-c', 'echo out; echo err >&2; exit 3'], { env });
		expect(run).toEqual({ exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
	});

	test('an aborted signal kills the child and the run is a failure', async () => {
		const controller = new AbortController();
		const started = Date.now();
		const pending = runProcess('sleep', ['30'], { env, signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		const run = await pending;
		expect(Date.now() - started).toBeLessThan(5000);
		expect(run.exitCode).toBeUndefined();
		expect(run.stderr).toContain('aborted');
	});

	test('a command that cannot be spawned resolves as a failure', async () => {
		const run = await runProcess('dockhand-no-such-binary', [], { env });
		expect(run.exitCode).toBeUndefined();
		expect(run.stderr.trim()).not.toBe('');
	});
});
