/**
 * The file-browser guard judges a path the way the OS opens it: a symlink is followed
 * before a `..` after it is applied. `/var/run/../etc/passwd` (with /var/run -> /run,
 * as in the Dockhand image) must be refused like /etc/passwd itself.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync, openSync, closeSync, unlinkSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isProtectedPath, isForbiddenStackPath, holdsForbiddenStackPath } from '../src/lib/server/fs-guard';

let root: string;
const previousDataDir = process.env.DATA_DIR;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'fs-guard-dotdot-')));
	mkdirSync(join(root, 'data', 'db'), { recursive: true });
	writeFileSync(join(root, 'data', 'db', 'dockhand.db'), '');
	writeFileSync(join(root, 'data', '.encryption_key'), '');
	mkdirSync(join(root, 'stacks', 'app'), { recursive: true });
	writeFileSync(join(root, 'stacks', 'app', 'compose.yaml'), '');
	mkdirSync(join(root, 'x', 'y'), { recursive: true });
	mkdirSync(join(root, 'q'));
	// Absolute and relative link targets, one directory below root.
	symlinkSync(join(root, 'q'), join(root, 'x', 'y', 'abs'));
	symlinkSync('../../q', join(root, 'x', 'y', 'rel'));
	// A link into a system tree, the shape of /var/run -> /run in the image.
	symlinkSync('/usr', join(root, 'usr-link'));
	// Dotfile managers keep ~/.ssh as a link to the real key directory.
	mkdirSync(join(root, 'keys'));
	writeFileSync(join(root, 'keys', 'id_rsa'), '');
	mkdirSync(join(root, 'home', 'u'), { recursive: true });
	symlinkSync(join(root, 'keys'), join(root, 'home', 'u', '.ssh'));
	symlinkSync(join(root, 'keys'), join(root, 'home', 'u', '.git'));
	symlinkSync(join(root, 'data'), join(root, 'data-link'));
	symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'));
	symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'));
	process.env.DATA_DIR = join(root, 'data');
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	if (previousDataDir === undefined) delete process.env.DATA_DIR;
	else process.env.DATA_DIR = previousDataDir;
});

describe('a symlink followed by .. resolves as the OS resolves it', () => {
	test('reaching /etc through a link and .. is refused', () => {
		expect(isProtectedPath(join(root, 'usr-link') + '/../etc/passwd')).toBe(true);
		expect(isProtectedPath(join(root, 'usr-link') + '/../etc/shadow')).toBe(true);
		expect(isProtectedPath(join(root, 'usr-link') + '/../proc/self/environ')).toBe(true);
	});

	test("reaching Dockhand's database and key through a link and .. is refused", () => {
		for (const link of ['abs', 'rel']) {
			const via = join(root, 'x', 'y', link) + '/..';
			expect(isProtectedPath(`${via}/data/db/dockhand.db`)).toBe(true);
			expect(isProtectedPath(`${via}/data/.encryption_key`)).toBe(true);
		}
	});

	test('the same .. without a link in front still reads what it names', () => {
		expect(isProtectedPath(join(root, 'x') + '/../stacks/app/compose.yaml')).toBe(false);
		expect(isProtectedPath(join(root, 'x', 'y', 'abs') + '/../stacks/app/compose.yaml')).toBe(false);
		// A relative link resolves against its own directory, as /var/run -> ../run does.
		expect(isProtectedPath(join(root, 'x', 'y', 'rel') + '/../stacks/app/compose.yaml')).toBe(false);
		expect(isProtectedPath(join(root, 'x', 'y', 'rel', 'new', 'compose.yaml'))).toBe(false);
	});

	test('a path that does not exist yet stays allowed outside the protected trees', () => {
		expect(isProtectedPath(join(root, 'stacks', 'new', 'compose.yaml'))).toBe(false);
		expect(isProtectedPath(join(root, 'x', 'y', 'abs', 'new', 'compose.yaml'))).toBe(false);
	});

	test('a .. after a missing component is refused, since only the OS could resolve it', () => {
		expect(isProtectedPath(join(root, 'missing') + '/../data/db/dockhand.db')).toBe(true);
		expect(isProtectedPath(join(root, 'missing') + '/../stacks/app/compose.yaml')).toBe(true);
	});

	test('a path the OS cannot walk (a file used as a directory) is refused', () => {
		expect(isProtectedPath(join(root, 'stacks', 'app', 'compose.yaml', 'x'))).toBe(true);
	});

	test('a symlink loop is refused', () => {
		expect(isProtectedPath(join(root, 'loop-a', 'file'))).toBe(true);
	});
});

describe('.ssh and .git are refused wherever they appear on the way', () => {
	test('a .ssh or .git that is itself a symlink is refused', () => {
		expect(isProtectedPath(join(root, 'home', 'u', '.ssh', 'id_rsa'))).toBe(true);
		expect(isProtectedPath(join(root, 'home', 'u', '.git', 'id_rsa'))).toBe(true);
		// The directory it points to is not secret by name, so it stays browsable.
		expect(isProtectedPath(join(root, 'keys', 'id_rsa'))).toBe(false);
	});

	test('the names are matched without regard to case', () => {
		expect(isProtectedPath(join(root, 'home', 'u', '.SSH', 'id_rsa'))).toBe(true);
		expect(isProtectedPath(join(root, 'stacks', '.Git', 'config'))).toBe(true);
	});
});

describe('/proc is refused as soon as a path enters it', () => {
	test.skipIf(process.platform !== 'linux')('a descriptor of a deleted file, whose link names a path outside /proc', () => {
		const file = join(root, 'secret-tmp');
		writeFileSync(file, 'secret');
		const fd = openSync(file, 'r');
		unlinkSync(file);
		try {
			expect(isProtectedPath(`/proc/self/fd/${fd}`)).toBe(true);
			expect(isProtectedPath(`/proc/${process.pid}/fd/${fd}`)).toBe(true);
			expect(isProtectedPath('/proc/self/root/tmp')).toBe(true);
		} finally {
			closeSync(fd);
		}
	});
});

describe('holdsForbiddenStackPath', () => {
	test("a directory that holds Dockhand's data, or any ancestor of it, is refused", () => {
		expect(holdsForbiddenStackPath(join(root, 'data'))).toBe(true);
		expect(holdsForbiddenStackPath(root)).toBe(true);
		expect(holdsForbiddenStackPath('/')).toBe(true);
		expect(holdsForbiddenStackPath(join(root, 'data-link'))).toBe(true);
	});

	test('the database directory and a symlinked DATA_DIR count as holding protected locations', () => {
		expect(holdsForbiddenStackPath(join(root, 'data', 'db'))).toBe(true);
		const previous = process.env.DATA_DIR;
		process.env.DATA_DIR = join(root, 'data-link');
		try {
			expect(holdsForbiddenStackPath(root)).toBe(true);
			expect(holdsForbiddenStackPath(join(root, 'data'))).toBe(true);
		} finally {
			process.env.DATA_DIR = previous;
		}
	});

	test('a directory holding only the key, or /, counts too', () => {
		const keyOnly = join(root, 'key-only');
		mkdirSync(keyOnly);
		writeFileSync(join(keyOnly, '.encryption_key'), '');
		const previous = process.env.DATA_DIR;
		process.env.DATA_DIR = keyOnly;
		try {
			expect(holdsForbiddenStackPath(keyOnly)).toBe(true);
		} finally {
			process.env.DATA_DIR = previous;
		}
		expect(holdsForbiddenStackPath('/')).toBe(true);
	});

	test('a key kept elsewhere through a symlink makes its real directory count', () => {
		const dataDir = join(root, 'linked-data');
		const secrets = join(root, 'secrets');
		mkdirSync(dataDir);
		mkdirSync(secrets);
		writeFileSync(join(secrets, 'key'), '');
		symlinkSync(join(secrets, 'key'), join(dataDir, '.encryption_key'));
		const previous = process.env.DATA_DIR;
		process.env.DATA_DIR = dataDir;
		try {
			expect(holdsForbiddenStackPath(secrets)).toBe(true);
		} finally {
			process.env.DATA_DIR = previous;
		}
	});

	test('a stack directory is not', () => {
		expect(holdsForbiddenStackPath(join(root, 'stacks', 'app'))).toBe(false);
		expect(holdsForbiddenStackPath(join(root, 'stacks', 'new'))).toBe(false);
	});

	test('a directory inside a forbidden location counts even when it holds nothing listed', () => {
		mkdirSync(join(root, 'data', 'db', 'sub'), { recursive: true });
		mkdirSync(join(root, 'data', 'deploy-logs', 'x'), { recursive: true });
		mkdirSync(join(root, 'repo', '.git', 'x'), { recursive: true });
		expect(holdsForbiddenStackPath(join(root, 'data', 'db', 'sub'))).toBe(true);
		expect(holdsForbiddenStackPath(join(root, 'data', 'deploy-logs', 'x'))).toBe(true);
		expect(holdsForbiddenStackPath(join(root, 'repo', '.git', 'x'))).toBe(true);
	});

	test('a database or deploy-log directory kept elsewhere through a symlink makes its real directory count', () => {
		for (const name of ['db', 'deploy-logs']) {
			const dataDir = join(root, `vol-data-${name}`);
			const mount = join(root, `mnt-${name}`);
			mkdirSync(join(mount, name), { recursive: true });
			mkdirSync(dataDir);
			symlinkSync(join(mount, name), join(dataDir, name));
			const previous = process.env.DATA_DIR;
			process.env.DATA_DIR = dataDir;
			try {
				expect(holdsForbiddenStackPath(mount)).toBe(true);
			} finally {
				process.env.DATA_DIR = previous;
			}
		}
	});

	test('a DATA_DIR that is a link inside a directory makes that directory count', () => {
		const outer = join(root, 'cfg');
		mkdirSync(outer);
		mkdirSync(join(root, 'real-data'));
		symlinkSync(join(root, 'real-data'), join(outer, 'data'));
		const previous = process.env.DATA_DIR;
		process.env.DATA_DIR = join(outer, 'data');
		try {
			expect(holdsForbiddenStackPath(outer)).toBe(true);
		} finally {
			process.env.DATA_DIR = previous;
		}
	});

	test('/root and /etc do not count, since stacks may live there', () => {
		expect(holdsForbiddenStackPath('/root')).toBe(false);
		expect(holdsForbiddenStackPath('/etc')).toBe(false);
	});
});

describe('isForbiddenStackPath - the narrower rule for stack paths', () => {
	test('Dockhand secrets, /proc and .ssh/.git are refused', () => {
		expect(isForbiddenStackPath(join(root, 'data', '.encryption_key'))).toBe(true);
		expect(isForbiddenStackPath(join(root, 'data', 'db', 'dockhand.db'))).toBe(true);
		expect(isForbiddenStackPath('/proc/self/environ')).toBe(true);
		expect(isForbiddenStackPath(join(root, 'home', 'u', '.ssh', 'id_rsa'))).toBe(true);
		expect(isForbiddenStackPath(join(root, 'data', 'deploy-logs', 'stack.log'))).toBe(true);
	});

	test("Dockhand's secrets are matched without regard to case, as a case-insensitive filesystem opens them", () => {
		expect(isForbiddenStackPath(join(root, 'data', '.ENCRYPTION_KEY'))).toBe(true);
		expect(isForbiddenStackPath(join(root, 'data', 'DB', 'dockhand.db'))).toBe(true);
		expect(isForbiddenStackPath(join(root, 'data', 'Deploy-Logs', 'x'))).toBe(true);
		expect(isForbiddenStackPath(join(root, 'DATA', '.encryption_key'))).toBe(true);
		expect(holdsForbiddenStackPath(join(root, 'data', 'DB'))).toBe(true);
		expect(isForbiddenStackPath(join(root, 'data', 'dbx', 'compose.yaml'))).toBe(false);
	});

	test('stacks under /etc or /root are allowed, unlike in the file browser', () => {
		// An unreadable /root (a non-root runner) fails closed, so only judge it when it can be walked.
		const walkable = (dir: string) => { try { accessSync(dir, constants.X_OK); return true; } catch { return false; } };
		const paths = ['/etc/compose/app/compose.yml', ...(walkable('/root') ? ['/root/docker/app/compose.yaml'] : [])];
		for (const p of paths) {
			expect(isForbiddenStackPath(p)).toBe(false);
			expect(isProtectedPath(p)).toBe(true);
		}
	});
});

