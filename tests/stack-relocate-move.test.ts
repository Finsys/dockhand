/**
 * Relocate's move of a stack directory's entries, on real directories: everything
 * a stack holds moves (a .git working copy, links to /etc), but no move may make an
 * entry lead into a protected location, and the cross-filesystem copy never reads or
 * writes through one.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveDirEntries } from '../src/lib/server/stack-relocate-move';

const previousDataDir = process.env.DATA_DIR;
let root: string;
let data: string;

beforeEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = realpathSync(mkdtempSync(join(tmpdir(), 'relocate-move-')));
	data = join(root, 'data');
	mkdirSync(join(data, 'db'), { recursive: true });
	writeFileSync(join(data, '.encryption_key'), 'KEY');
	process.env.DATA_DIR = data;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	if (previousDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = previousDataDir;
});

const exdev = () => {
	throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
};

describe('moveDirEntries', () => {
	test('a versioned stack moves whole, its .git included', () => {
		const oldDir = join(root, 'stacks', 'app');
		const newDir = join(root, 'stacks', 'app2');
		mkdirSync(join(oldDir, '.git'), { recursive: true });
		writeFileSync(join(oldDir, '.git', 'HEAD'), 'ref: refs/heads/main');
		mkdirSync(join(oldDir, 'data'));
		writeFileSync(join(oldDir, 'compose.yaml'), 'services: {}');
		writeFileSync(join(oldDir, '.env'), 'A=1');
		mkdirSync(newDir);

		const { movedFiles, errors } = moveDirEntries(oldDir, newDir);

		expect(movedFiles.sort()).toEqual(['.env', '.git', 'compose.yaml', 'data']);
		expect(errors).toEqual([]);
		expect(existsSync(join(newDir, '.git', 'HEAD'))).toBe(true);
	});

	test('a link that already led to /etc moves as a link', () => {
		const oldDir = join(root, 'stacks', 'app');
		const newDir = join(root, 'stacks', 'app2');
		mkdirSync(oldDir, { recursive: true });
		mkdirSync(newDir);
		symlinkSync('/etc/hosts', join(oldDir, 'hosts'));

		expect(moveDirEntries(oldDir, newDir)).toEqual({ movedFiles: ['hosts'], errors: [] });
		expect(lstatSync(join(newDir, 'hosts')).isSymbolicLink()).toBe(true);
	});

	test('a relative link that would lead to the key once moved is put back', () => {
		const oldDir = join(data, 'git-repos', 'repo', 'a');
		const newDir = join(data, 'stacks');
		mkdirSync(oldDir, { recursive: true });
		mkdirSync(newDir);
		// From oldDir this leads to a missing file; from newDir, to the key.
		symlinkSync('../.encryption_key', join(oldDir, 'compose.yaml'));

		const { movedFiles, errors } = moveDirEntries(oldDir, newDir);

		expect(movedFiles).toEqual([]);
		expect(errors[0]).toContain('compose.yaml');
		expect(existsSync(join(newDir, 'compose.yaml'))).toBe(false);
		expect(lstatSync(join(oldDir, 'compose.yaml')).isSymbolicLink()).toBe(true);
	});

	test('across filesystems, plain files are copied and links into protected places are not', () => {
		const oldDir = join(root, 'stacks', 'app');
		const newDir = join(root, 'other', 'app');
		mkdirSync(oldDir, { recursive: true });
		mkdirSync(newDir, { recursive: true });
		writeFileSync(join(oldDir, 'compose.yaml'), 'services: {}');
		symlinkSync(join(data, '.encryption_key'), join(oldDir, 'key'));
		// A link at the target would have the copy write through it.
		symlinkSync(join(data, 'db', 'dockhand.db'), join(newDir, '.env'));
		writeFileSync(join(oldDir, '.env'), 'A=1');

		const { movedFiles, errors } = moveDirEntries(oldDir, newDir, exdev);

		expect(movedFiles).toEqual(['compose.yaml']);
		expect(errors.length).toBe(2);
		expect(readFileSync(join(newDir, 'compose.yaml'), 'utf8')).toBe('services: {}');
		expect(existsSync(join(newDir, 'key'))).toBe(false);
		expect(existsSync(join(data, 'db', 'dockhand.db'))).toBe(false);
	});
});
