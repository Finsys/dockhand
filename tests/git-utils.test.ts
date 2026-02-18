/**
 * Unit Tests for Git Utility Functions
 *
 * Tests maskSecrets and parseEnvFileContent from the git module.
 */
import { describe, test, expect } from 'bun:test';
import { maskSecrets, parseEnvFileContent } from '../src/lib/server/git';

// =============================================================================
// maskSecrets
// =============================================================================

describe('maskSecrets', () => {
	test('masks password keys', () => {
		const result = maskSecrets({ PASSWORD: 'secret123', DB_PASSWORD: 'dbpass' });
		expect(result.PASSWORD).toBe('***');
		expect(result.DB_PASSWORD).toBe('***');
	});

	test('masks token keys', () => {
		const result = maskSecrets({ API_TOKEN: 'tok_abc', AUTH_TOKEN: 'xyz' });
		expect(result.API_TOKEN).toBe('***');
		expect(result.AUTH_TOKEN).toBe('***');
	});

	test('masks secret keys', () => {
		const result = maskSecrets({ CLIENT_SECRET: 'sec123', MY_SECRET: 'shh' });
		expect(result.CLIENT_SECRET).toBe('***');
		expect(result.MY_SECRET).toBe('***');
	});

	test('masks api_key and apikey keys', () => {
		const result = maskSecrets({ API_KEY: 'key123', APIKEY: 'key456' });
		expect(result.API_KEY).toBe('***');
		expect(result.APIKEY).toBe('***');
	});

	test('masks auth keys', () => {
		const result = maskSecrets({ AUTH_HEADER: 'Bearer xxx' });
		expect(result.AUTH_HEADER).toBe('***');
	});

	test('masks credential keys', () => {
		const result = maskSecrets({ CREDENTIAL: 'cred123' });
		expect(result.CREDENTIAL).toBe('***');
	});

	test('masks private key references', () => {
		const result = maskSecrets({ PRIVATE_KEY: 'key-data' });
		expect(result.PRIVATE_KEY).toBe('***');
	});

	test('leaves normal keys unmasked', () => {
		const result = maskSecrets({
			HOST: 'localhost',
			PORT: '3000',
			NODE_ENV: 'production'
		});
		expect(result.HOST).toBe('localhost');
		expect(result.PORT).toBe('3000');
		expect(result.NODE_ENV).toBe('production');
	});

	test('truncates long values (>50 chars)', () => {
		const longValue = 'a'.repeat(60);
		const result = maskSecrets({ DESCRIPTION: longValue });
		expect(result.DESCRIPTION).toContain('...(truncated)');
		expect(result.DESCRIPTION.length).toBeLessThan(longValue.length);
	});

	test('does not truncate values <= 50 chars', () => {
		const shortValue = 'a'.repeat(50);
		const result = maskSecrets({ DESCRIPTION: shortValue });
		expect(result.DESCRIPTION).toBe(shortValue);
	});

	test('handles empty object', () => {
		const result = maskSecrets({});
		expect(Object.keys(result)).toHaveLength(0);
	});

	test('case insensitive matching', () => {
		const result = maskSecrets({ password: 'lower', Password: 'mixed' });
		expect(result.password).toBe('***');
		expect(result.Password).toBe('***');
	});
});

// =============================================================================
// parseEnvFileContent
// =============================================================================

describe('parseEnvFileContent', () => {
	test('parses simple KEY=value pairs', () => {
		const content = 'HOST=localhost\nPORT=3000';
		const result = parseEnvFileContent(content);
		expect(result.HOST).toBe('localhost');
		expect(result.PORT).toBe('3000');
	});

	test('skips empty lines', () => {
		const content = 'A=1\n\nB=2\n\n';
		const result = parseEnvFileContent(content);
		expect(result.A).toBe('1');
		expect(result.B).toBe('2');
		expect(Object.keys(result)).toHaveLength(2);
	});

	test('skips comment lines', () => {
		const content = '# This is a comment\nHOST=localhost\n# Another comment';
		const result = parseEnvFileContent(content);
		expect(result.HOST).toBe('localhost');
		expect(Object.keys(result)).toHaveLength(1);
	});

	test('handles double-quoted values', () => {
		const content = 'MSG="hello world"';
		const result = parseEnvFileContent(content);
		expect(result.MSG).toBe('hello world');
	});

	test('handles single-quoted values', () => {
		const content = "MSG='hello world'";
		const result = parseEnvFileContent(content);
		expect(result.MSG).toBe('hello world');
	});

	test('handles values with equals signs', () => {
		const content = 'CONNECTION=host=db;port=5432';
		const result = parseEnvFileContent(content);
		expect(result.CONNECTION).toBe('host=db;port=5432');
	});

	test('handles empty values', () => {
		const content = 'EMPTY=';
		const result = parseEnvFileContent(content);
		expect(result.EMPTY).toBe('');
	});

	test('trims whitespace around keys and values', () => {
		const content = '  HOST = localhost  ';
		const result = parseEnvFileContent(content);
		expect(result.HOST).toBe('localhost');
	});

	test('skips lines without equals sign', () => {
		const content = 'VALID=yes\ninvalid-line\nALSO_VALID=yes';
		const result = parseEnvFileContent(content);
		expect(result.VALID).toBe('yes');
		expect(result.ALSO_VALID).toBe('yes');
		expect(Object.keys(result)).toHaveLength(2);
	});

	test('handles empty content', () => {
		const result = parseEnvFileContent('');
		expect(Object.keys(result)).toHaveLength(0);
	});

	test('accepts optional stackName parameter', () => {
		// Should not throw
		const result = parseEnvFileContent('A=1', 'my-stack');
		expect(result.A).toBe('1');
	});
});
