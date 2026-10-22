/**
 * A repository's symlinks must survive a deploy twice over.
 *
 * Resolving a relative link on copy rewrites it as an absolute path into the clone; the
 * next deploy then finds the destination link resolving onto its own source and cp
 * refuses it as a copy into a subdirectory of itself, so the stack can never be updated
 * again. Keeping links verbatim fixes that for an ordinary link, but one pointing at its
 * own ancestor still fails - measured below - so that shape is refused outright, as are
 * a link out of the stack and an absolute one.
 *
 * Exercised against the real filesystem with the same cpSync options the deploy uses.
 * The decision comes from the module under test rather than being restated here.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, existsSync, readFileSync, cpSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { judgeSymlink } from '../src/lib/server/stack-symlinks';

let root: string;
let src: string;
let dst: string;

/** The copy deployStack performs, with the symlink decision under test. */
function deployCopy(from: string, to: string): string[] {
	const refused: string[] = [];
	cpSync(from, to, {
		recursive: true,
		force: true,
		verbatimSymlinks: true,
		filter: (s) => {
			if (s.includes(`${sep}.git${sep}`) || s.endsWith(`${sep}.git`)) return false;
			let target: string;
			try {
				if (!lstatSync(s).isSymbolicLink()) return true;
				target = readlinkSync(s);
			} catch {
				return true;
			}
			if (judgeSymlink(s, target, from, existsSync).kind === 'refuse') {
				refused.push(relative(from, s));
				return false;
			}
			return true;
		}
	});
	return refused;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'dh-symlink-'));
	src = join(root, 'clone');
	dst = join(root, 'stack');
	mkdirSync(join(src, 'real-dir'), { recursive: true });
	mkdirSync(join(src, '.agents', 'skills', 'ask-matt'), { recursive: true });
	mkdirSync(join(src, '.claude', 'skills'), { recursive: true });
	mkdirSync(join(root, 'outside'), { recursive: true });
	writeFileSync(join(src, 'real-dir', 'file.txt'), 'hi');
	writeFileSync(join(src, '.agents', 'skills', 'ask-matt', 'SKILL.md'), 'skill');
	writeFileSync(join(root, 'outside', 'secret.txt'), 'SECRET');
	writeFileSync(join(src, 'compose.yaml'), 'services:\n  app:\n    image: busybox\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('copying a git clone that contains symlinks', () => {
	test('a stack with a relative link deploys more than once', () => {
		symlinkSync('real-dir', join(src, 'link-dir'));
		deployCopy(src, dst);
		expect(() => deployCopy(src, dst)).not.toThrow();
		expect(() => deployCopy(src, dst)).not.toThrow();
	});

	test('the link stays relative, so it does not point back into the clone', () => {
		symlinkSync('real-dir', join(src, 'link-dir'));
		deployCopy(src, dst);
		// The absolute-link version of this bug wrote the clone's path here.
		expect(readlinkSync(join(dst, 'link-dir'))).toBe('real-dir');
	});

	test('a link that walks up and back down inside the repo is carried and readable', () => {
		symlinkSync(join('..', '..', '.agents', 'skills', 'ask-matt'), join(src, '.claude', 'skills', 'ask-matt'));
		deployCopy(src, dst);
		expect(readlinkSync(join(dst, '.claude', 'skills', 'ask-matt'))).toBe(join('..', '..', '.agents', 'skills', 'ask-matt'));
		expect(readFileSync(join(dst, '.claude', 'skills', 'ask-matt', 'SKILL.md'), 'utf8')).toBe('skill');
		expect(() => deployCopy(src, dst)).not.toThrow();
	});

	test('a link to its own ancestor is refused, and the deploy repeats without it', () => {
		// The one shape that still breaks the second copy when carried verbatim.
		symlinkSync('..', join(src, 'real-dir', 'up'));
		expect(deployCopy(src, dst)).toContain(join('real-dir', 'up'));
		expect(existsSync(join(dst, 'real-dir', 'up'))).toBe(false);
		expect(() => deployCopy(src, dst)).not.toThrow();
		expect(() => deployCopy(src, dst)).not.toThrow();
	});

	test('a link to the stack root is refused for the same reason', () => {
		symlinkSync('.', join(src, 'self'));
		expect(deployCopy(src, dst)).toContain('self');
		expect(() => deployCopy(src, dst)).not.toThrow();
	});

	test('a link out of the repo is refused, and its target does not reach the stack', () => {
		symlinkSync(join('..', 'outside'), join(src, 'escape'));
		expect(deployCopy(src, dst)).toContain('escape');
		expect(existsSync(join(dst, 'escape'))).toBe(false);
		expect(existsSync(join(dst, 'escape', 'secret.txt'))).toBe(false);
	});

	test('an absolute link is refused', () => {
		symlinkSync('/etc/passwd', join(src, 'abs-link'));
		expect(deployCopy(src, dst)).toContain('abs-link');
		expect(existsSync(join(dst, 'abs-link'))).toBe(false);
	});

	test('a two-hop chain cannot read outside, because its first hop is refused', () => {
		// The second hop looks inside the stack; it resolves to nothing once the first
		// is dropped, so the copy carries no route to the target.
		symlinkSync(join('..', 'outside'), join(src, 'out'));
		symlinkSync(join('out', 'secret.txt'), join(src, 'leak'));
		deployCopy(src, dst);
		expect(existsSync(join(dst, 'out'))).toBe(false);
		expect(() => readFileSync(join(dst, 'leak'), 'utf8')).toThrow();
	});

	test('a link to nothing is refused, so the deploy repeats', () => {
		// cp cannot stat it in the destination next time round; it fails that way with
		// or without verbatim links, so this one is not specific to keeping them.
		symlinkSync('not-here.txt', join(src, 'dangling'));
		expect(deployCopy(src, dst)).toContain('dangling');
		expect(() => deployCopy(src, dst)).not.toThrow();
		expect(() => deployCopy(src, dst)).not.toThrow();
	});

	test('ordinary files are unaffected by the symlink handling', () => {
		symlinkSync('real-dir', join(src, 'link-dir'));
		deployCopy(src, dst);
		expect(readFileSync(join(dst, 'compose.yaml'), 'utf8')).toContain('busybox');
		expect(readFileSync(join(dst, 'real-dir', 'file.txt'), 'utf8')).toBe('hi');
	});
});
