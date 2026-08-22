/**
 * Unit tests for backups/restore-script.ts. The new-location builder is a simple
 * argv check. The in-place builder is verified structurally AND with a real-fs
 * round-trip that models restic (writing into <staging>/volumes/<name>) and
 * proves the flatten + swap lands the restored contents in the live root.
 */
import { describe, it, expect } from 'bun:test';
import { buildInPlaceRestore, buildNewLocationRestore, buildCloneRestore, cloneStagingName } from '../../src/lib/server/backups/restore-script';
import { SWAP_NEW, SWAP_ARTIFACTS } from '../../src/lib/server/backups/swap';

describe('buildNewLocationRestore', () => {
	it('restores the requested includes into the fresh target', () => {
		const a = buildNewLocationRestore('snap', '/restore/here', ['/volumes/data'], []);
		expect(a).toEqual(['restore', '--json', 'snap', '--target', '/restore/here', '--include', '/volumes/data']);
	});
	it('restores the whole snapshot when no includes given, and appends flags', () => {
		const a = buildNewLocationRestore('snap', '/out', [], ['--verbose']);
		expect(a).toEqual(['restore', '--json', 'snap', '--target', '/out', '--verbose']);
	});
});

describe('buildInPlaceRestore — structure', () => {
	it('runs under set -e, restores into the staging dir, and includes the swap', () => {
		const script = buildInPlaceRestore('snap', ['/volumes/data'], []);
		expect(script).toMatch(/^set -e;/);
		expect(script).toContain(SWAP_NEW);
		expect(script).toContain("restic 'restore'");
		expect(script).toContain("'--target'");
	});
	it('references every swap artifact (so the swap + backup exclude stay in sync)', () => {
		const script = buildInPlaceRestore('snap', ['/volumes/data'], []);
		for (const a of SWAP_ARTIFACTS) expect(script).toContain(a);
	});
	it('DIR branch clears the staging dir BEFORE restic (no stale-merge from a killed prior restore)', () => {
		// restic restore has no --delete: without wiping the staging dir first, a marker-less
		// leftover from a previously-killed restore would keep files not in this snapshot and the
		// swap would commit them as "restored". The rm -rf must precede the restic restore.
		const script = buildInPlaceRestore('snap', ['/volumes/data'], []);
		const rmIdx = script.indexOf(`rm -rf '${SWAP_NEW}'`) >= 0
			? script.indexOf(`rm -rf '${SWAP_NEW}'`)
			: script.search(new RegExp(`rm -rf '[^']*${SWAP_NEW}[^']*'`));
		const resticIdx = script.indexOf("restic 'restore'");
		expect(rmIdx).toBeGreaterThanOrEqual(0);
		expect(resticIdx).toBeGreaterThanOrEqual(0);
		expect(rmIdx).toBeLessThan(resticIdx); // staging wiped before restore
	});
	it('single-file branch guards existence BEFORE overwriting the live file (never truncate on empty restore)', () => {
		// `cat X > live` truncates `live` before cat runs; if the restored file is missing
		// (restic exit 0 but nothing extracted) the live user file would be zeroed then the
		// command fails - destroying data. The file branch must check `[ -f <restored> ]`
		// first and refuse, leaving the live file untouched.
		const script = buildInPlaceRestore('snap', ['/volumes/etc_app_cfg.yaml'], []);
		expect(script).toMatch(/if \[ -f [^\]]+ \]; then cat .+ > /);
		expect(script).toContain('refusing to truncate live file');
	});
});

describe('buildCloneRestore — structure', () => {
	it('runs under set -e, extracts into an isolated staging dir (never rm -rf a user dir at the mount)', () => {
		const script = buildCloneRestore('snap', ['/volumes/data'], []);
		expect(script).toMatch(/^set -e;/);
		expect(script).toContain("restic 'restore'");
		// restic targets the staging dir INSIDE the mount, not the mount root itself.
		expect(script).toContain("'--target' '/volumes/data/.dockhand-clone-snap'");
		expect(script).toContain("'--include' '/volumes/data'");
		// The ONLY rm is of our own staging dir — NEVER '<mount>/volumes' (which could
		// be a user's own directory at a bind destination).
		expect(script).toContain("rm -rf '/volumes/data/.dockhand-clone-snap'");
		expect(script).not.toContain("rm -rf '/volumes/data/volumes'");
		// Not the in-place swap machinery.
		expect(script).not.toContain(SWAP_NEW);
		for (const a of SWAP_ARTIFACTS) expect(script).not.toContain(a);
	});
	it('handles multiple mount roots', () => {
		const script = buildCloneRestore('snap', ['/volumes/a', '/volumes/b'], ['--verbose']);
		expect(script).toContain("'--target' '/volumes/a/.dockhand-clone-snap'");
		expect(script).toContain("'--target' '/volumes/b/.dockhand-clone-snap'");
		expect(script).toContain("'--verbose'");
	});
	it('NEVER passes restic --delete — a restore ADDS to the destination, never wipes it', () => {
		// Data-safety guard: when a bind destination points at a host path that
		// already has the user's files, restic must overlay the snapshot's files on
		// top, not delete anything that isn't in the snapshot. `restic restore`
		// without --delete does exactly that; assert we never add the flag.
		const script = buildCloneRestore('snap', ['/volumes/data'], []);
		expect(script).not.toContain('--delete');
	});
	it('gives DIFFERENT snapshots DIFFERENT staging dirs (concurrent clones to one path never collide)', () => {
		// Two clones into the same host path from different snapshots would otherwise
		// share one staging dir, and one's cleanup would wipe the other's files.
		const a = cloneStagingName('aaaaaaaaaaaa1111');
		const b = cloneStagingName('bbbbbbbbbbbb2222');
		expect(a).not.toBe(b);
		expect(a.startsWith('.dockhand-clone-')).toBe(true);
		// It's inert to path traversal / shell metachars in the snapshot id.
		expect(cloneStagingName('../../etc/passwd')).toBe('.dockhand-clone-etcpasswd');
	});
});

// A single-FILE bind (./cfg.yaml:/x) mounts file-on-file, so the live volume root is a
// FILE and an ACTIVE mount point — it can be written through but NOT renamed over (`mv`
// -> "Device or resource busy"). The old script mkdir'd a staging dir INSIDE it (`mkdir
// <file>: not a directory`) and the restore FAILED (found by the data-in-stack-folder
// matrix). The builder now branches at runtime: a file restores into a sibling temp and
// overwrites the live file's CONTENT via `cat` (writes through the mount).
describe('buildInPlaceRestore — single-file bind', () => {
	it('emits a file branch that does not mkdir a staging dir inside the live path', () => {
		const script = buildInPlaceRestore('snap', ['/volumes/etc_cfg.yaml'], []);
		// Runtime dir/file branch.
		expect(script).toContain("if [ -d '/volumes/etc_cfg.yaml' ]; then");
		// The file branch restores into a SIBLING temp under /volumes, never inside the file.
		expect(script).toContain("'--target' '/volumes/.dockhand-restore-file-etc_cfg.yaml'");
		// And commits by writing content THROUGH the mount (cat), NOT renaming (which is busy).
		expect(script).toContain("cat '/volumes/.dockhand-restore-file-etc_cfg.yaml/volumes/etc_cfg.yaml' > '/volumes/etc_cfg.yaml'");
		expect(script).not.toContain("mv -f '/volumes/.dockhand-restore-file");
	});

	it('real-fs round-trip: replaces a live FILE with the restored one, no leftovers', () => {
		const { execFileSync } = require('child_process');
		const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = require('fs');
		const { tmpdir } = require('os');
		const { join } = require('path');

		// Sandbox: a /volumes dir with the live file to be replaced.
		const root = mkdtempSync(join(tmpdir(), 'filebind-'));
		const volumes = join(root, 'volumes');
		mkdirSync(volumes, { recursive: true });
		const live = join(volumes, 'cfg');
		writeFileSync(live, 'LIVE-OLD\n');

		// Build for the sandbox path, then stub restic. Real restic recreates the include's
		// FULL path under --target, i.e. writes to <target><live>. Model that faithfully so
		// the script's `cat <target><live> > <live>` finds the file where it expects it.
		const script = buildInPlaceRestore('snap', [live], []);
		const stagingTarget = `${volumes}/.dockhand-restore-file-cfg`;
		const mockRestic = `mkdir -p "$(dirname '${stagingTarget}${live}')"; printf 'RESTORED-NEW' > '${stagingTarget}${live}'`;
		const runnable = script.replace(/restic 'restore'[^;]*/g, mockRestic);

		const file = join(root, 'run.sh');
		writeFileSync(file, runnable);
		try {
			execFileSync('sh', [file], { stdio: 'pipe' });
			// The live file now holds the restored content...
			expect(readFileSync(live, 'utf8')).toBe('RESTORED-NEW');
			// ...and nothing but `cfg` remains in /volumes (temp dir cleaned up).
			expect(readdirSync(volumes)).toEqual(['cfg']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('buildCloneRestore — real-fs round-trip (models restic writing to <root>/volumes/<name>)', () => {
	const { execFileSync } = require('child_process');
	const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } = require('fs');
	const { tmpdir } = require('os');
	const { join } = require('path');

	it('flattens the restic output up to the mount root (no swap, fresh volume)', () => {
		// The mount root in production is `/volumes/<name>` (the helper bind dest).
		// Model a sandbox whose mount root ends in /volumes/data.
		const root = mkdtempSync(join(tmpdir(), 'clone-'));
		const mount = join(root, 'volumes', 'data');
		mkdirSync(mount, { recursive: true });

		const script = buildCloneRestore('snap', [mount], []);
		// Model restic `restore --target <mount>/.dockhand-clone-snap --include <mount>`:
		// it recreates the include path under the target, i.e. writes to
		// <staging><mount>. The script moves <staging><mount>/* up to <mount>/ then
		// removes the staging dir.
		const staging = `${mount}/.dockhand-clone-snap`;
		const mockRestic =
			`mkdir -p '${staging}${mount}'; printf DATA > '${staging}${mount}/file.txt'`;
		const runnable = script.replace(/restic 'restore'[^;]*/, mockRestic);

		const file = join(root, 'run.sh');
		writeFileSync(file, runnable);
		try {
			execFileSync('sh', [file], { stdio: 'pipe' });
			const names = readdirSync(mount);
			expect(names).toEqual(['file.txt']);
			expect(readFileSync(join(mount, 'file.txt'), 'utf8')).toBe('DATA');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('KEEPS the user\'s pre-existing files at the destination — restore only adds', () => {
		// The exact data-safety property the user cares about: restoring a bind into a
		// host path that already holds the user's files must PRESERVE them and add the
		// snapshot's files alongside. Seed the mount root with a user file, run the
		// clone restore (modelling restic writing one new file), assert both survive.
		const root = mkdtempSync(join(tmpdir(), 'clone-keep-'));
		const mount = join(root, 'volumes', 'data');
		mkdirSync(mount, { recursive: true });
		// The user's pre-existing data on the host path.
		writeFileSync(join(mount, 'user-keep.txt'), 'USER_DATA');
		mkdirSync(join(mount, 'user-dir'), { recursive: true });
		writeFileSync(join(mount, 'user-dir', 'nested.txt'), 'USER_NESTED');
		// THE edge case that motivated the staging-dir rewrite: the user has their OWN
		// directory literally named `volumes` at the bind destination. The old code did
		// `rm -rf <mount>/volumes` and would have wiped it. It must survive.
		mkdirSync(join(mount, 'volumes'), { recursive: true });
		writeFileSync(join(mount, 'volumes', 'mine.txt'), 'USER_VOLUMES_DIR');

		const script = buildCloneRestore('snap', [mount], []);
		// restic (no --delete) writes the snapshot's file under <staging><mount>.
		const staging = `${mount}/.dockhand-clone-snap`;
		const mockRestic =
			`mkdir -p '${staging}${mount}'; printf FROM_BACKUP > '${staging}${mount}/restored.txt'`;
		const runnable = script.replace(/restic 'restore'[^;]*/, mockRestic);

		const file = join(root, 'run.sh');
		writeFileSync(file, runnable);
		try {
			execFileSync('sh', [file], { stdio: 'pipe' });
			const names = readdirSync(mount).sort();
			// The user's files AND their `volumes/` dir AND the restored file all
			// present; the staging dir is gone. Nothing of the user's was wiped.
			expect(names).toEqual(['restored.txt', 'user-dir', 'user-keep.txt', 'volumes']);
			expect(readFileSync(join(mount, 'user-keep.txt'), 'utf8')).toBe('USER_DATA');
			expect(readFileSync(join(mount, 'user-dir', 'nested.txt'), 'utf8')).toBe('USER_NESTED');
			expect(readFileSync(join(mount, 'volumes', 'mine.txt'), 'utf8')).toBe('USER_VOLUMES_DIR');
			expect(readFileSync(join(mount, 'restored.txt'), 'utf8')).toBe('FROM_BACKUP');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('MERGES the restored tree into a pre-existing NON-EMPTY dir (the mv "Directory not empty" bug)', () => {
		// Cross-env restore where the destination already has the same subdirectory
		// with contents (e.g. Home Assistant `config/blueprints`). Plain `mv` refuses
		// with "can't rename 'blueprints': Directory not empty"; cp -a must merge:
		// keep the user's existing file, add the restored one, overwrite collisions.
		const root = mkdtempSync(join(tmpdir(), 'clone-merge-'));
		const mount = join(root, 'volumes', 'config');
		mkdirSync(join(mount, 'blueprints'), { recursive: true });
		writeFileSync(join(mount, 'blueprints', 'existing.yaml'), 'OLD');
		writeFileSync(join(mount, 'blueprints', 'shared.yaml'), 'OLD_SHARED');

		const script = buildCloneRestore('snap', [mount], []);
		const staging = `${mount}/.dockhand-clone-snap`;
		// restic restores a blueprints/ dir with a NEW file + an OVERWRITE of shared.yaml.
		const mockRestic =
			`mkdir -p '${staging}${mount}/blueprints'; ` +
			`printf NEW > '${staging}${mount}/blueprints/restored.yaml'; ` +
			`printf NEW_SHARED > '${staging}${mount}/blueprints/shared.yaml'`;
		const runnable = script.replace(/restic 'restore'[^;]*/, mockRestic);
		const file = join(root, 'run.sh');
		writeFileSync(file, runnable);
		try {
			execFileSync('sh', [file], { stdio: 'pipe' }); // must NOT throw
			const bp = readdirSync(join(mount, 'blueprints')).sort();
			expect(bp).toEqual(['existing.yaml', 'restored.yaml', 'shared.yaml']);
			expect(readFileSync(join(mount, 'blueprints', 'existing.yaml'), 'utf8')).toBe('OLD'); // kept
			expect(readFileSync(join(mount, 'blueprints', 'restored.yaml'), 'utf8')).toBe('NEW'); // added
			expect(readFileSync(join(mount, 'blueprints', 'shared.yaml'), 'utf8')).toBe('NEW_SHARED'); // overwritten
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('buildInPlaceRestore — real-fs round-trip (models restic writing to staging/volumes/<name>)', () => {
	const { execFileSync } = require('child_process');
	const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } = require('fs');
	const { tmpdir } = require('os');
	const { join } = require('path');

	it('flattens the restic output and swaps it into the live root', () => {
		// The live root is always a `/volumes/<name>` path in production; the
		// script's scaffold cleanup (`rm -rf <staging>/volumes`) depends on that.
		// Build a sandbox whose live dir ends in /volumes/data and drive the script
		// with `live` = that absolute path.
		const root = mkdtempSync(join(tmpdir(), 'restore-'));
		const live = join(root, 'volumes', 'data');
		mkdirSync(live, { recursive: true });
		writeFileSync(join(live, 'old.txt'), 'OLD');

		const script = buildInPlaceRestore('snap', [live], []);
		const staging = `${live}/${SWAP_NEW}`;
		// Model restic `restore --target <staging> --include <live>`: it writes to
		// <staging><live> (i.e. <staging>/<root>/volumes/data). The script flattens
		// <staging><live>/* up to <staging> and removes the <staging>/volumes
		// scaffold. Reproduce restic's output layout exactly.
		const mockRestic =
			`mkdir -p '${staging}${live}'; printf NEW > '${staging}${live}/restored.txt'`;
		const runnable = script.replace(/restic 'restore'[^;]*/, mockRestic);

		const file = join(root, 'run.sh');
		writeFileSync(file, runnable);
		try {
			execFileSync('sh', [file], { stdio: 'pipe' });
			const names = readdirSync(live).filter((n: string) => !(SWAP_ARTIFACTS as readonly string[]).includes(n));
			expect(names).toEqual(['restored.txt']);
			expect(readFileSync(join(live, 'restored.txt'), 'utf8')).toBe('NEW');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
