import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bitwardenProvider } from '../src/lib/server/secretproviders/bitwarden';

const projectId = '11111111-1111-4111-8111-111111111111';
const secretId = '22222222-2222-4222-8222-222222222222';
const invalidKeysProjectId = '44444444-4444-4444-8444-444444444444';
const duplicateKeysProjectId = '55555555-5555-4555-8555-555555555555';
const emptyProjectId = '66666666-6666-4666-8666-666666666666';
const config = { token: 'test-token' };
const previousBwsPath = process.env.DOCKHAND_BWS_PATH;
let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'dockhand-bws-test-'));
	const cli = join(dir, 'bws');
	// The provider runs this stand-in instead of contacting Bitwarden.
	writeFileSync(
		cli,
		`#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'bws 2.1.0'
  exit 0
fi
if [ "$BWS_ACCESS_TOKEN" != "test-token" ]; then
  exit 1
fi
case "$1:$2:$3" in
  project:list:--output)
    printf '%s\\n' '[{"id":"${projectId}"}]'
    ;;
  secret:list:${projectId})
    printf '%s\\n' '[{"id":"${secretId}","key":"API_KEY","value":"bulk-value"},{"key":"DB_PASSWORD","value":"password"}]'
    ;;
  secret:list:${invalidKeysProjectId})
    printf '%s\\n' '[{"key":"KEEP","value":"valid"},{"key":"BAD-KEY","value":"invalid"},{"key":"9INVALID","value":"invalid"},{"key":"__proto__","value":"reserved"},{"key":"prototype","value":"reserved"},{"key":"constructor","value":"reserved"}]'
    ;;
  secret:list:${duplicateKeysProjectId})
    printf '%s\\n' '[{"key":"API_KEY","value":"first"},{"key":"API_KEY","value":"second"},{"key":"OTHER","value":"other"}]'
    ;;
  secret:list:${emptyProjectId})
    printf '%s\\n' '[]'
    ;;
  secret:get:${secretId})
    printf '%s\\n' '{"id":"${secretId}","key":"API_KEY","value":"reference-value"}'
    ;;
  *)
    exit 1
    ;;
esac
`
	);
	chmodSync(cli, 0o755);
	process.env.DOCKHAND_BWS_PATH = cli;
});

afterAll(() => {
	if (previousBwsPath === undefined) delete process.env.DOCKHAND_BWS_PATH;
	else process.env.DOCKHAND_BWS_PATH = previousBwsPath;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('Bitwarden provider with a fake bws executable', () => {
	test('checks the connection using the project list', async () => {
		expect(await bitwardenProvider.testConnection(config)).toEqual({ ok: true });
	});
	test('reports an unsuccessful connection due to wrong token', async () => {
		const badConfig = { token: 'wrong-token' };
		expect(await bitwardenProvider.testConnection(badConfig)).toEqual({ 
			ok: false, 
			error: "Bitwarden bws command failed" });
	});

	test('converts the bulk secret list to environment variables', async () => {
		const result = await bitwardenProvider.resolveBulk(config, projectId);
		expect({ ...result }).toEqual({ API_KEY: 'bulk-value', DB_PASSWORD: 'password' });
	});

	test('skips invalid and reserved bulk secret keys', async () => {
		const result = await bitwardenProvider.resolveBulk(config, invalidKeysProjectId);
		expect({ ...result }).toEqual({ KEEP: 'valid' });
	});

	test('keeps the first value for duplicate bulk secret keys', async () => {
		const result = await bitwardenProvider.resolveBulk(config, duplicateKeysProjectId);
		expect({ ...result }).toEqual({ API_KEY: 'first', OTHER: 'other' });
	});

	test('returns an empty record for an empty bulk secret list', async () => {
		const result = await bitwardenProvider.resolveBulk(config, emptyProjectId);
		expect({ ...result }).toEqual({});
	});

	test('resolves a reference to its secret value', async () => {
		const ref = `bws://${secretId}`;
		expect(bitwardenProvider.isReference(ref)).toBe(true);
		const result = await bitwardenProvider.resolveSecretReferences(config, [ref]);
		expect(result.get(ref)).toBe('reference-value');
		expect(result.size).toBe(1);
	});

	test('returns empty result for a missing secret', async () => {
		const missing = '33333333-3333-4333-8333-333333333333';
		const result = await bitwardenProvider.resolveSecretReferences(config, [`bws://${missing}`])
		expect(result.size).toBe(0);
	});

  test('returns present references and skips missing ones', async () => {
		const ref1 = `bws://${secretId}`;
		const ref2 = `bws://33333333-3333-4333-8333-333333333333`;
		const result = await bitwardenProvider.resolveSecretReferences(config, [ref1, ref2]);
		expect(result.get(ref1)).toBe('reference-value');
		expect(result.has(ref2)).toBe(false);
		expect(result.size).toBe(1);
	});

	test('throws for an invalid project ID', async () => {
		const invalidProjectId = 'invalid-uuid';
		expect(bitwardenProvider.resolveBulk(config, invalidProjectId)).rejects.toThrow(
			'Bitwarden Project selector must be a valid UUID'
		);
	});

	test('skips malformed secret references', async () => {
		const malformed = 'bws://not-a-uuid';
		const result = await bitwardenProvider.resolveSecretReferences(config, [malformed]);
		expect(result.size).toBe(0);
	});

	test('resolving references fails with invalid access token', async () => {
		const invalidConfig = { ...config, token: 'invalid' };
		const ref = `bws://${secretId}`;
		const result = await bitwardenProvider.resolveSecretReferences(invalidConfig, [ref]);
		expect(result.size).toBe(0);
	});

	test('duplicate references resolve once', async () => {
		const ref = `bws://${secretId}`;
		const result = await bitwardenProvider.resolveSecretReferences(config, [ref, ref]);
		expect(result.get(ref)).toBe('reference-value');
		expect(result.size).toBe(1);
	});

});