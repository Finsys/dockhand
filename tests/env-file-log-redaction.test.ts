import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// .env files hold secrets. parseEnvFileContent() runs on every stack deploy and its
// output lands in `docker logs dockhand` and the in-app log viewer, so it may log
// lengths, line numbers, keys and masked values, but never the file or a line of it.
describe('parseEnvFileContent logging', () => {
	const source = readFileSync(new URL('../src/lib/server/git.ts', import.meta.url), 'utf8');
	const start = source.indexOf('export function parseEnvFileContent(');
	const end = source.indexOf('\n}\n', start);
	const body = source.slice(start, end);

	test('the function is found', () => {
		expect(start).toBeGreaterThan(-1);
		expect(body).toContain('redactEnvVarsForLog');
	});

	test('never logs the raw file content', () => {
		expect(body).not.toMatch(/console\.\w+\(\s*content\s*\)/);
		expect(body).not.toMatch(/Raw content:/);
	});

	test('skipped-line notes carry line numbers only, not line text', () => {
		const pushes = body.match(/skippedLines\.push\([^;]*\);/g) ?? [];
		expect(pushes.length).toBeGreaterThan(0);
		for (const push of pushes) {
			expect(push).not.toMatch(/trimmed|line\b|substring/);
		}
	});

	test('parsed values are only logged masked', () => {
		const logs = body.match(/console\.\w+\([^;]*\);/g) ?? [];
		for (const log of logs.filter((l) => l.includes('result'))) {
			expect(log).toMatch(/Object\.keys\(result\)|redactEnvVarsForLog\(result\)/);
		}
	});
});
