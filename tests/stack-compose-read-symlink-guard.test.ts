import { describe, test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { isProtectedPath, isForbiddenStackPath } from '../src/lib/server/fs-guard';
import { isAllowedStackFilename } from '../src/lib/server/stack-filename';

/**
 * getStackComposeFile reads a stack's compose and returns the content to the caller. A
 * stored compose path can be a symlink, and readFileSync follows it, so a stack whose
 * compose points at (or literally is) a host file under /etc or /root would otherwise leak
 * that file through the compose endpoint - the same class as the Portainer git-stack
 * symlink read. The read path matches the write path: isForbiddenStackPath (Dockhand's own
 * secrets, /proc) plus isProtectedPath (/etc, /root, /proc, resolving symlinks first), so a
 * stack under /etc or /root is neither read nor saved through Dockhand. The adopt path adds
 * a filename gate so a non-stack file can never even be stored as a stack.
 *
 * isProtectedPath's own symlink-resolution is proven in fs-guard.test.ts; this file pins
 * that getStackComposeFile applies it (stacks.ts imports better-sqlite3, which bun cannot
 * load, so its body is pinned at the source) and that the guards block the real targets.
 */
describe('isProtectedPath blocks a compose under or symlinked into a protected root', () => {
	test('a compose symlinked out to /etc is refused', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dh-escape-'));
		const link = join(dir, 'compose.yaml');
		symlinkSync('/etc/passwd', link);
		expect(isProtectedPath(link)).toBe(true);
		// isForbiddenStackPath alone does NOT catch this (it omits /etc), which is why
		// isProtectedPath is layered on the read path.
		expect(isForbiddenStackPath(link)).toBe(false);
	});

	test('a literal path under /etc or /root is refused (same as the write path)', () => {
		expect(isProtectedPath('/etc/app/compose.yaml')).toBe(true);
		expect(isProtectedPath('/root/app/compose.yaml')).toBe(true);
		expect(isProtectedPath('/root/.env')).toBe(true);
	});

	test('a real compose under a normal directory is allowed', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dh-ok-'));
		const sub = join(dir, 'app');
		mkdirSync(sub);
		const file = join(sub, 'compose.yaml');
		writeFileSync(file, 'services: {}\n');
		expect(isProtectedPath(file)).toBe(false);
		expect(isForbiddenStackPath(file)).toBe(false);
	});
});

describe('isAllowedStackFilename is the adopt filename gate', () => {
	test('rejects a non-stack host file, allows a compose/.env', () => {
		expect(isAllowedStackFilename(basename('/etc/shadow'))).toBe(false);
		expect(isAllowedStackFilename(basename('/etc/passwd'))).toBe(false);
		expect(isAllowedStackFilename(basename('/root/app/compose.yaml'))).toBe(true);
		expect(isAllowedStackFilename(basename('/root/app/.env'))).toBe(true);
	});
});

const SRC = readFileSync(new URL('../src/lib/server/stacks.ts', import.meta.url), 'utf8');

/** The body of getStackComposeFile, so a match elsewhere cannot satisfy these. */
const FN = (() => {
	const start = SRC.indexOf('export async function getStackComposeFile');
	expect(start).toBeGreaterThan(-1);
	const end = SRC.indexOf('\nexport ', start + 1);
	return SRC.slice(start, end === -1 ? undefined : end);
})();

describe('getStackComposeFile wires the compose/env read guards', () => {
	test('the custom-composePath branch refuses a protected path (and secrets/proc)', () => {
		expect(FN).toContain('isForbiddenStackPath(source.composePath) || isProtectedPath(source.composePath)');
	});

	test('the discovered-compose branch guards both the compose and the .env', () => {
		expect(FN).toContain('!isForbiddenStackPath(actualComposePath) && !isProtectedPath(actualComposePath)');
		expect(FN).toContain('!isForbiddenStackPath(envFilePath) && !isProtectedPath(envFilePath)');
	});

	test('both branches still read only after the guard (readFileSync is present)', () => {
		expect(FN).toContain('readFileSync(source.composePath');
		expect(FN).toContain('readFileSync(actualComposePath');
	});
});
