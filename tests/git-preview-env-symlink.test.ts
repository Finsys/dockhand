/**
 * The env preview reads the base .env and a user-named env file from a fresh clone. Both
 * are checked against the clone on disk, so a committed symlink cannot lead out of it.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepoFile, repoBaseEnvPath } from '../src/lib/server/git-url-safety';

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'preview-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')));
writeFileSync(join(outside, 'secret.env'), 'TOKEN=outside\n');
writeFileSync(join(repo, 'app.env'), 'A=1\n');
symlinkSync(join(outside, 'secret.env'), join(repo, 'leak.env'));
symlinkSync('app.env', join(repo, 'alias.env'));

const linked = realpathSync(mkdtempSync(join(tmpdir(), 'preview-base-')));
writeFileSync(join(linked, 'compose.yml'), 'services: {}\n');
symlinkSync(join(outside, 'secret.env'), join(linked, '.env'));

afterAll(() => {
	rmSync(linked, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe('readRepoFile', () => {
	test('reads a plain file inside the clone', () => {
		expect(readRepoFile(repo, 'app.env', 'Env file path')).toBe('A=1\n');
	});

	test('a symlink that stays inside the clone is read', () => {
		expect(readRepoFile(repo, 'alias.env', 'Env file path')).toBe('A=1\n');
	});

	test('a committed symlink leading out of the clone is refused', () => {
		expect(() => readRepoFile(repo, 'leak.env', 'Env file path')).toThrow(/outside the repository/);
	});

	test('a missing file gives null', () => {
		expect(readRepoFile(repo, 'nope.env', 'Env file path')).toBeNull();
	});
});

describe('repoBaseEnvPath', () => {
	test('a plain .env beside the compose file is returned', () => {
		writeFileSync(join(repo, 'compose.yml'), 'services: {}\n');
		writeFileSync(join(repo, '.env'), 'B=2\n');
		expect(repoBaseEnvPath(repo, 'compose.yml')).toBe(join(repo, '.env'));
	});

	test('a committed .env symlink leading out of the clone is refused', () => {
		expect(() => repoBaseEnvPath(linked, 'compose.yml')).toThrow(/outside the repository/);
	});
});
