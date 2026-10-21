/**
 * A single-file bind (`./config.yaml:/x`) restored as a FILE into its host directory: a missing
 * destination (Docker creates a missing bind source as a directory), an existing file, and an
 * empty directory left by Docker all end as the restored file; a non-empty directory is refused.
 */
import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileRestores } from '../../src/lib/server/backups/restore-script';
import { snapshotVolumeNodes } from '../../src/lib/server/backups/snapshot-volumes-core';

/** Run the script with restic replaced by a stub that writes the file where restic would:
 *  `<target><include>`. */
function run(before: (dst: string) => void, extract = true): { ok: boolean; stderr: string } {
	const root = mkdtempSync(join(tmpdir(), 'file-restore-'));
	try {
		const mount = join(root, 'stack');
		mkdirSync(mount, { recursive: true });
		before(join(mount, 'config.yaml'));
		const include = '/volumes/cfg_key';
		let script = buildFileRestores('snap', [{ include, mountDir: mount, name: 'config.yaml' }], []);
		// The stage lives under the helper's /tmp; keep the test inside its sandbox.
		script = script.replaceAll('/tmp/dockhand-file-cfg_key', join(root, 'stage'));
		const target = join(root, 'stage');
		script = script.replace(/restic 'restore'[^;]*/, extract ? `mkdir -p '${target}/volumes'; printf 'RESTORED' > '${target}${include}'` : 'true');
		const file = join(root, 'run.sh');
		writeFileSync(file, `set -e; ${script}`);
		try {
			execFileSync('sh', [file], { stdio: 'pipe' });
			return { ok: true, stderr: '' };
		} catch (e: any) {
			return { ok: false, stderr: String(e.stderr) };
		} finally {
			const dst = join(mount, 'config.yaml');
			lastResult = { content: safeRead(dst), isDir: safeIsDir(dst), entries: readdirSync(mount), stageLeft: readdirSync(root).includes('stage') };
			lastResult.isLink = (() => { try { return lstatSync(dst).isSymbolicLink(); } catch { return false; } })();
			lastResult.shared = safeRead(join(root, 'shared.yaml'));
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
let lastResult: { content: string | null; isDir: boolean; entries: string[]; stageLeft: boolean; isLink?: boolean; shared?: string | null };
const safeRead = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const safeIsDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

describe('buildFileRestores on a real filesystem', () => {
	it('writes the file where there was none', () => {
		expect(run(() => {}).ok).toBe(true);
		expect(lastResult).toMatchObject({ content: 'RESTORED', isDir: false, entries: ['config.yaml'], stageLeft: false });
	});

	it('replaces an existing file', () => {
		expect(run((dst) => writeFileSync(dst, 'OLD')).ok).toBe(true);
		expect(lastResult.content).toBe('RESTORED');
		expect(lastResult.entries).toEqual(['config.yaml']);
	});

	it('replaces the empty directory Docker creates for a missing bind source', () => {
		expect(run((dst) => mkdirSync(dst)).ok).toBe(true);
		expect(lastResult).toMatchObject({ content: 'RESTORED', isDir: false, entries: ['config.yaml'], stageLeft: false });
	});

	it('a restore that extracted nothing leaves the existing file untouched and says why', () => {
		const r = run((dst) => writeFileSync(dst, 'OLD'), false);
		expect(r.ok).toBe(false);
		expect(r.stderr).toContain('is not a file in the snapshot');
		expect(lastResult.content).toBe('OLD');
	});

	it('a destination that is a link to a file is written through, so the shared file gets the content', () => {
		const r = run((dst) => {
			const shared = join(dst, '..', '..', 'shared.yaml');
			writeFileSync(shared, 'OLD');
			symlinkSync(shared, dst);
		});
		expect(r.ok).toBe(true);
		expect(lastResult.isLink).toBe(true);
		expect(lastResult.shared).toBe('RESTORED');
	});

	it('a destination that is a link to a directory fails, rather than the file landing inside it', () => {
		const r = run((dst) => {
			const dir = join(dst, '..', '..', 'confdir');
			mkdirSync(dir);
			symlinkSync(dir, dst);
		});
		expect(r.ok).toBe(false);
	});

	it('the restic command restores only this file, into the helper stage, with the restore flags', () => {
		const script = buildFileRestores('snap', [{ include: '/volumes/cfg_key', mountDir: '/restore-files/cfg_key', name: 'config.yaml' }], ['--exclude-xattr']);
		expect(script).toContain("restic 'restore' '--json' 'snap' '--target' '/tmp/dockhand-file-cfg_key' '--include' '/volumes/cfg_key' '--exclude-xattr'");
	});

	it('refuses a non-empty directory and leaves it untouched', () => {
		const r = run((dst) => { mkdirSync(dst); writeFileSync(join(dst, 'keep'), 'x'); });
		expect(r.ok).toBe(false);
		expect(r.stderr).toContain('non-empty directory');
		expect(lastResult.isDir).toBe(true);
	});
});

describe('snapshotVolumeNodes', () => {
	const ls = [
		{ message_type: 'snapshot', id: 'x' },
		{ message_type: 'node', path: '/volumes', type: 'dir' },
		{ message_type: 'node', path: '/volumes/data', type: 'dir' },
		{ message_type: 'node', path: '/volumes/data/inner.txt', type: 'file' },
		{ message_type: 'node', path: '/volumes/etc_app_config.yaml', type: 'file' },
		{ struct_type: 'node', path: '/volumes/old_style.conf', type: 'file' },
		{ message_type: 'node', path: '/volumes/__dockhand_stackdir__', type: 'dir' }
	].map((e) => JSON.stringify(e)).join('\n');
	const reserved = (k: string) => k === '__dockhand_stackdir__';

	it('names every volume and marks only a top-level file as a single-file volume', () => {
		const { names, files } = snapshotVolumeNodes(ls, reserved);
		expect(names.sort()).toEqual(['data', 'etc_app_config.yaml', 'old_style.conf']);
		expect(files.sort()).toEqual(['etc_app_config.yaml', 'old_style.conf']);
	});
});

describe('the restore preview probe on a single-file target', () => {
	const { probeListScript, classifyProbeListing, PROBE_MISSING_SENTINEL } = require('../../src/lib/server/backups/stackdir-plan');
	const probe = (setup: (p: string) => void) => {
		const root = mkdtempSync(join(tmpdir(), 'probe-'));
		try {
			const target = join(root, 'target');
			setup(target);
			const out = execFileSync('sh', ['-c', probeListScript(PROBE_MISSING_SENTINEL, target)], { encoding: 'utf8' });
			return classifyProbeListing(out);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	};

	it('an existing file holds data, so the dialog asks before overwriting it', () => {
		expect(probe((p) => writeFileSync(p, 'x'))).toBe('has-data');
	});

	it('a missing target is missing, an empty directory is empty', () => {
		expect(probe(() => {})).toBe('missing');
		expect(probe((p) => mkdirSync(p))).toBe('empty');
	});
});
