import { describe, test, expect } from 'bun:test';
import { parseEnvVars, extractEnvPlaceholderReferences } from '../src/lib/server/env-parser';

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

describe('extractEnvPlaceholderReferences', () => {
	test('extracts ${VAR} references', () => {
		expect(extractEnvPlaceholderReferences('${BASE_URL}/api')).toEqual(['BASE_URL']);
	});

	test('extracts $VAR bare references', () => {
		expect(extractEnvPlaceholderReferences('$HOST:8080')).toEqual(['HOST']);
	});

	test('extracts ${VAR:-default} and modifier variants', () => {
		expect(extractEnvPlaceholderReferences('${DOMAIN:-example.com}/${PATH}')).toEqual(['DOMAIN', 'PATH']);
		expect(extractEnvPlaceholderReferences('${ALT+backup}')).toEqual(['ALT']);
	});

	test('ignores escaped $$', () => {
		expect(extractEnvPlaceholderReferences('$$LITERAL')).toEqual([]);
		expect(extractEnvPlaceholderReferences('$${LITERAL}')).toEqual([]);
	});

	test('ignores single-quoted literal values', () => {
		expect(extractEnvPlaceholderReferences("'${BASE_URL}/api'")).toEqual([]);
		expect(extractEnvPlaceholderReferences("'$HOST'")).toEqual([]);
	});

	test('ignores $ followed by digit or non-identifier', () => {
		expect(extractEnvPlaceholderReferences('"1$abcdef1234"')).toEqual([]);
		expect(extractEnvPlaceholderReferences('$100')).toEqual([]);
	});

	test('extracts multiple unique references', () => {
		expect(extractEnvPlaceholderReferences('https://${SUBDOMAIN}.${DOMAIN}:${PORT}/v1')).toEqual(['SUBDOMAIN', 'DOMAIN', 'PORT']);
	});
});
