import { describe, test, expect } from 'bun:test';
import { parseEnvVars } from '../src/lib/server/env-parser';

describe('parseEnvVars', () => {
	test('parses simple key=value pairs', () => {
		const content = 'FOO=bar\nBAZ=qux';
		expect(parseEnvVars(content)).toEqual({ FOO: 'bar', BAZ: 'qux' });
	});

	test('skips empty lines', () => {
		const content = 'FOO=bar\n\nBAZ=qux\n\n';
		expect(parseEnvVars(content)).toEqual({ FOO: 'bar', BAZ: 'qux' });
	});

	test('skips comment lines', () => {
		const content = '# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux';
		expect(parseEnvVars(content)).toEqual({ FOO: 'bar', BAZ: 'qux' });
	});

	test('preserves double-quoted values', () => {
		const content = 'FOO="hello world"';
		expect(parseEnvVars(content)).toEqual({ FOO: '"hello world"' });
	});

	test('preserves single-quoted values', () => {
		const content = "FOO='hello world'";
		expect(parseEnvVars(content)).toEqual({ FOO: "'hello world'" });
	});

	test('handles values with equals signs', () => {
		const content = 'DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=require';
		expect(parseEnvVars(content)).toEqual({
			DATABASE_URL: 'postgres://user:pass@host:5432/db?sslmode=require'
		});
	});

	test('handles empty values', () => {
		const content = 'EMPTY=\nFOO=bar';
		expect(parseEnvVars(content)).toEqual({ EMPTY: '', FOO: 'bar' });
	});

	test('skips lines without equals sign', () => {
		const content = 'FOO=bar\ninvalid line\nBAZ=qux';
		expect(parseEnvVars(content)).toEqual({ FOO: 'bar', BAZ: 'qux' });
	});

	test('skips invalid key names', () => {
		const content = '123BAD=value\nGOOD_KEY=value\n-invalid=value';
		expect(parseEnvVars(content)).toEqual({ GOOD_KEY: 'value' });
	});

	test('trims whitespace around keys and values', () => {
		const content = '  FOO  =  bar  ';
		expect(parseEnvVars(content)).toEqual({ FOO: 'bar' });
	});

	test('preserves nested quotes (#1036)', () => {
		const content = `HOSTNAMES='"sub1.com","sub2.com"'`;
		expect(parseEnvVars(content)).toEqual({ HOSTNAMES: `'"sub1.com","sub2.com"'` });
	});

	test('preserves double-quoted CSV values', () => {
		const content = 'SCOPES="app","auth"';
		expect(parseEnvVars(content)).toEqual({ SCOPES: '"app","auth"' });
	});

	test('round-trip stability — parse serialize parse gives same result', () => {
		const original = `SIMPLE=value
QUOTED="hello world"
NESTED='"a","b"'
SPECIAL='password$123#!'
EMPTY=`;
		const parsed = parseEnvVars(original);
		const serialized = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('\n');
		const reparsed = parseEnvVars(serialized);
		expect(reparsed).toEqual(parsed);
	});

	test('preserves values with special chars in quotes', () => {
		const content = "PASS='password$123#!'";
		expect(parseEnvVars(content)).toEqual({ PASS: "'password$123#!'" });
	});
});
