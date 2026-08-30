import { describe, test, expect } from 'bun:test';
import { spawn } from 'child_process';
import { collectProcess } from '../src/lib/server/stacks';

describe('collectProcess mit Zeilen-Rueckruf', () => {
	test('meldet jede Zeile einzeln und in der Reihenfolge', async () => {
		const lines: string[] = [];
		const child = spawn('sh', ['-c', 'printf "eins\\nzwei\\ndrei\\n" >&2']);
		await collectProcess(child, (line) => lines.push(line));
		expect(lines).toEqual(['eins', 'zwei', 'drei']);
	});

	test('meldet eine abschliessende Zeile ohne Zeilenumbruch ebenfalls', async () => {
		const lines: string[] = [];
		const child = spawn('sh', ['-c', 'printf "ohne-umbruch" >&2']);
		await collectProcess(child, (line) => lines.push(line));
		expect(lines).toEqual(['ohne-umbruch']);
	});

	test('verhaelt sich ohne Rueckruf wie bisher', async () => {
		const child = spawn('sh', ['-c', 'printf "unveraendert\\n" >&2']);
		const result = await collectProcess(child);
		expect(result.stderr).toContain('unveraendert');
	});
});
