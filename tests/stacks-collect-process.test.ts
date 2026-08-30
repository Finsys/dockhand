import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import { collectProcess } from '../src/lib/server/process-output-core';

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
});
