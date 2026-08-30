import { describe, test, expect } from 'bun:test';
import { redactLine } from '../src/lib/server/secret-redaction';

describe('redactLine', () => {
	test('replaces a known value exactly', () => {
		const line = 'Error: connection to postgres://user:sup3rgeheim-passwort-42@db failed';
		expect(redactLine(line, ['sup3rgeheim-passwort-42'])).toBe(
			'Error: connection to postgres://user:***@db failed'
		);
	});

	test('replaces every occurrence, not just the first', () => {
		expect(redactLine('a=tokenwert-lang-genug b=tokenwert-lang-genug', ['tokenwert-lang-genug'])).toBe(
			'a=*** b=***'
		);
	});

	test('withholds the whole line when a secret is too short to replace safely', () => {
		// "test" would match inside "latest", "testing", "attest" -- replacing would be nonsense
		expect(redactLine('Pulling image alpine:latest', ['test'])).toBeNull();
	});

	test('leaves a line without any secret unchanged', () => {
		const line = 'Container app-1  Started';
		expect(redactLine(line, ['sup3rgeheim-passwort-42'])).toBe(line);
	});

	test('ignores empty and blank secrets', () => {
		const line = 'Container app-1  Started';
		expect(redactLine(line, ['', '  '])).toBe(line);
	});
});
