/**
 * Unit tests for backups/backup-script.ts — the pure backup session-script and
 * argv builders. Includes real-shell round-trips proving the metadata is written
 * and the restic exit code is surfaced via the marker.
 */
import { describe, it, expect } from 'bun:test';
import { buildBackupScript, buildBackupArgs } from '../../src/lib/server/backups/backup-script';
import { readExitMarker } from '../../src/lib/server/backups/restic-script';

describe('buildBackupArgs', () => {
	const base = { host: 'dockhand.local', tags: ['dockhand:instance=i'], hasVolumes: true, swapArtifacts: ['.dockhand-restore-old'] };

	it('builds the core backup argv over /volumes and /metadata', () => {
		const a = buildBackupArgs(base);
		expect(a.slice(0, 6)).toEqual(['backup', '--json', '--retry-lock', '5m', '--host', 'dockhand.local']);
		expect(a).toContain('/volumes/');
		expect(a).toContain('/metadata/');
	});
	it('backs up ONLY /metadata when the target has no volumes (config-only snapshot)', () => {
		const a = buildBackupArgs({ ...base, hasVolumes: false });
		expect(a).toContain('/metadata/');
		expect(a).not.toContain('/volumes/'); // omitted so restic doesn't exit 3 on a missing path
	});
	it('adds every tag and always excludes the swap artifacts', () => {
		const a = buildBackupArgs({ ...base, tags: ['t1', 't2'] });
		expect(a.filter((x) => x === '--tag')).toHaveLength(2);
		const exIdx = a.indexOf('--exclude');
		expect(a[exIdx + 1]).toBe('.dockhand-restore-old');
	});
	it('defaults to --exclude-caches, honours opt-out', () => {
		expect(buildBackupArgs(base)).toContain('--exclude-caches');
		expect(buildBackupArgs({ ...base, excludeCaches: false })).not.toContain('--exclude-caches');
	});
	it('adds user excludes, compression, and limits when set', () => {
		const a = buildBackupArgs({ ...base, excludePatterns: ['*.tmp', '  '], compression: 'max', limitUpload: 1000, limitDownload: 2000 });
		expect(a).toContain('*.tmp');
		expect(a.filter((x) => x === '*.tmp')).toHaveLength(1); // blank pattern dropped
		expect(a).toContain('--compression'); expect(a).toContain('max');
		expect(a).toContain('--limit-upload'); expect(a).toContain('1000');
		expect(a).toContain('--limit-download'); expect(a).toContain('2000');
	});
});

describe('buildBackupScript', () => {
	// Metadata/stack files are streamed into /metadata via put-archive (docker cp),
	// NOT written by the script — so the script must NOT embed any file contents
	// (that inline base64 blew ARG_MAX for large stack files). It only ensures
	// /metadata exists and runs restic, surfacing the real exit via the marker.
	it('only ensures /metadata and runs restic — never embeds file contents', () => {
		const script = buildBackupScript(['backup', '/volumes/', '/metadata/']);
		expect(script).toContain('mkdir -p /metadata');
		expect(script).not.toContain('base64'); // no inline file bytes → no ARG_MAX
		expect(script).not.toContain('printf');
		expect(script).toContain('set +e'); // restic step runs without errexit
		expect(script).toMatch(/restic 'backup'/);
	});

	it('runs restic in the background with a SIGINT-forwarding trap (graceful cancel)', () => {
		// Cancel sends SIGINT so restic releases its repo lock before exiting; a plain
		// SIGKILL would orphan the lock and hang the next backup on --retry-lock.
		const script = buildBackupScript(['backup', '/volumes/']);
		expect(script).toMatch(/restic 'backup' '\/volumes\/' &/); // backgrounded
		expect(script).toContain('trap'); // signal forwarder installed
		expect(script).toContain('kill -INT'); // forwards SIGINT to restic
		expect(script).toContain('kill -0'); // re-wait loop guarded on liveness
	});

	it('is small regardless of how many/large the stack files are (no ARG_MAX)', () => {
		// The script no longer scales with file payload — it is a fixed few lines.
		const script = buildBackupScript(['backup', '/volumes/', '/metadata/', '--tag', 'x']);
		expect(script.length).toBeLessThan(500);
	});

	it('round-trip: the script runs restic and reports exit 0 via the marker', () => {
		const { execFileSync } = require('child_process');
		const { mkdtempSync, writeFileSync, rmSync } = require('fs');
		const { tmpdir } = require('os');
		const { join } = require('path');
		const dir = mkdtempSync(join(tmpdir(), 'bkscript-'));
		try {
			// Fake restic = `true`; the script's mkdir + set +e + marker must run and
			// print the real exit code (0). Swap the `restic ...` head for `true`.
			const script = buildBackupScript(['backup']).replace(/restic '[^']*'/, 'true');
			const file = join(dir, 'run.sh');
			writeFileSync(file, script);
			const out = execFileSync('sh', [file], { encoding: 'utf8' });
			expect(readExitMarker(out)).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The stack-dir volume PROBE is the 100% runtime guard: in 'volume' capture mode the
	// helper must assert the compose file is visible under the mount before backing up, so
	// a phantom mount (a remote daemon's empty auto-created dir) HARD-FAILS instead of
	// writing a silent-empty snapshot.
	describe('stack-dir volume probe', () => {
		it('emits a compose-visibility guard when a probe is given', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/'], { volumeKey: '__dockhand_stackdir__', composeFileName: 'docker-compose.yml' });
			expect(script).toContain("[ ! -f '/volumes/__dockhand_stackdir__/docker-compose.yml' ]");
			expect(script).toContain('exit 1');
			expect(script).toContain('STACKDIR PROBE FAILED');
		});

		it('emits NO probe when none is given (tar / container path unchanged)', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/']);
			expect(script).not.toContain('STACKDIR PROBE');
		});

		it('stamps the env/target label + wall-clock into the probe failure line for CI correlation', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/'], {
				volumeKey: '__dockhand_stackdir__', composeFileName: 'docker-compose.yml', label: 'env=166 target=anton'
			});
			// The failure echo carries the key so a parallel CI log identifies WHICH backup failed,
			// and a shell $(date ...) so it can be lined up with the shard test log by time.
			expect(script).toContain('env=166 target=anton STACKDIR PROBE FAILED');
			expect(script).toContain('$(date -u +%Y-%m-%dT%H:%M:%SZ)');
		});

		it('names the host path + a redeploy hint in the probe failure when hostPath is given (no hint = local)', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/'], {
				volumeKey: '__dockhand_stackdir__', composeFileName: 'compose.yaml',
				hostPath: '/opt/dockhand/stacks/myapp'
			});
			// The operator must see WHERE it looked and WHAT to do about it.
			expect(script).toContain('not found in /opt/dockhand/stacks/myapp on the host');
			expect(script).toContain('Redeploy the stack');
		});

		it('hawser-defaulted hint: names the empty host path and tells the user to set the host path, NOT redeploy', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/'], {
				volumeKey: '__dockhand_stackdir__', composeFileName: 'compose.yaml',
				hostPath: '/data/stacks/gitlab',
				hint: { kind: 'hawser-defaulted', hostPath: '/data/stacks/gitlab', envName: 'prod-hawser' }
			});
			// The default /data/stacks came up empty: name WHERE (path on the env), the fix, and the
			// exact settings location so the operator can go straight there.
			expect(script).toContain('compose compose.yaml not found in /data/stacks/gitlab on prod-hawser');
			expect(script).toContain('Set "Remote stack path (for backup)" in Settings > Environments > prod-hawser');
			expect(script).not.toContain('Redeploy the stack');
		});

		it('uses the stack\'s REAL compose filename in the probe (adopted stacks can be anything)', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/'], {
				volumeKey: '__dockhand_stackdir__', composeFileName: 'dupa.yaml',
				hostPath: '/data/stacks/adopted', hint: { kind: 'hawser-defaulted', hostPath: '/data/stacks/adopted', envName: 'prod' }
			});
			// The name is taken from the stack's own composePath, never hardcoded to compose.yaml.
			expect(script).toContain("[ ! -f '/volumes/__dockhand_stackdir__/dupa.yaml' ]");
			expect(script).toContain('compose dupa.yaml not found');
		});

		it('user-set hint: same clear "set the real host path" instruction', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/'], {
				volumeKey: '__dockhand_stackdir__', composeFileName: 'compose.yaml',
				hostPath: '/opt/agent/stacks/gitlab',
				hint: { kind: 'user-set', hostPath: '/opt/agent/stacks/gitlab', envName: 'remote-1' }
			});
			expect(script).toContain('not found in /opt/agent/stacks/gitlab on remote-1');
			expect(script).toContain('Set "Remote stack path (for backup)" in Settings > Environments > remote-1');
			expect(script).not.toContain('Redeploy the stack');
		});

		it('falls back to "on the host" when the env name is unknown (never prints null)', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/'], {
				volumeKey: '__dockhand_stackdir__', composeFileName: 'compose.yaml',
				hostPath: '/data/stacks/x', hint: { kind: 'hawser-defaulted', hostPath: '/data/stacks/x', envName: null }
			});
			expect(script).toContain('not found in /data/stacks/x on the host');
			expect(script).toContain('Set "Remote stack path (for backup)" in Settings > Environments to');
			expect(script).not.toContain('on null');
			expect(script).not.toContain('Environments > null');
		});

		it('local hint: keeps the redeploy hint (files are staged by a local redeploy)', () => {
			const script = buildBackupScript(['backup', '/volumes/', '/metadata/'], {
				volumeKey: '__dockhand_stackdir__', composeFileName: 'compose.yaml',
				hostPath: '/srv/stacks/myapp', hint: { kind: 'local' }
			});
			expect(script).toContain('not found in /srv/stacks/myapp on the host');
			expect(script).toContain('Redeploy the stack');
		});

		it('round-trip: probe FAILS (exit 1) when the compose is not under the mount', () => {
			const { execFileSync } = require('child_process');
			const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs');
			const { tmpdir } = require('os');
			const { join } = require('path');
			const dir = mkdtempSync(join(tmpdir(), 'bkprobe-'));
			try {
				// Empty /volumes/__dockhand_stackdir__ (phantom mount) — no compose file.
				mkdirSync(join(dir, 'volumes', '__dockhand_stackdir__'), { recursive: true });
				// Point the probe at our temp tree and stub restic to `true`.
				let script = buildBackupScript(['backup'], { volumeKey: '__dockhand_stackdir__', composeFileName: 'compose.yaml' })
					.replace(/restic '[^']*'/, 'true')
					.replaceAll('/volumes/', `${dir}/volumes/`);
				const file = join(dir, 'run.sh');
				writeFileSync(file, script);
				let failed = false;
				try { execFileSync('sh', [file], { encoding: 'utf8' }); }
				catch (e: any) { failed = true; expect(String(e.stderr || e.stdout)).toContain('STACKDIR PROBE FAILED'); }
				expect(failed).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		// The hint messages contain quotes, parens and `>` ("Remote stack path (for backup)",
		// "Settings > Environments > <env>"). If they aren't shell-quoted they break `sh` with
		// "syntax error near (" and EVERY hawser/user-set backup dies at the probe. Run the REAL
		// generated script through sh for each hint kind to guarantee it stays valid.
		for (const hint of [
			{ kind: 'hawser-defaulted', hostPath: '/data/stacks/x', envName: "prod's-env (eu)" } as const,
			{ kind: 'user-set', hostPath: '/opt/agent/stacks/x', envName: 'remote-1' } as const,
			{ kind: 'local' } as const,
		]) {
			it(`round-trip: generated probe script is valid sh for hint kind=${hint.kind}`, () => {
				const { execFileSync } = require('child_process');
				const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs');
				const { tmpdir } = require('os');
				const { join } = require('path');
				const dir = mkdtempSync(join(tmpdir(), 'bkprobe-'));
				try {
					mkdirSync(join(dir, 'volumes', '__dockhand_stackdir__'), { recursive: true });
					const script = buildBackupScript(['backup'], {
						volumeKey: '__dockhand_stackdir__', composeFileName: 'compose.yaml',
						label: 'env=26 target=t', hostPath: '/data/stacks/x', hint,
					})
						.replace(/restic '[^']*'/, 'true')
						.replaceAll('/volumes/', `${dir}/volumes/`);
					const file = join(dir, 'run.sh');
					writeFileSync(file, script);
					// `sh -n` = syntax-only check: no quoting bug can slip through.
					execFileSync('sh', ['-n', file], { encoding: 'utf8' });
					// And it must still FAIL loud (empty mount) with the message, not silently.
					let failed = false;
					try { execFileSync('sh', [file], { encoding: 'utf8' }); }
					catch (e: any) { failed = true; expect(String(e.stderr || e.stdout)).toContain('STACKDIR PROBE FAILED'); }
					expect(failed).toBe(true);
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			});
		}

		it('round-trip: probe PASSES when the compose IS under the mount', () => {
			const { execFileSync } = require('child_process');
			const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs');
			const { tmpdir } = require('os');
			const { join } = require('path');
			const dir = mkdtempSync(join(tmpdir(), 'bkprobe-'));
			try {
				const mount = join(dir, 'volumes', '__dockhand_stackdir__');
				mkdirSync(mount, { recursive: true });
				writeFileSync(join(mount, 'compose.yaml'), 'services: {}\n'); // compose present
				const script = buildBackupScript(['backup'], { volumeKey: '__dockhand_stackdir__', composeFileName: 'compose.yaml' })
					.replace(/restic '[^']*'/, 'true')
					.replaceAll('/volumes/', `${dir}/volumes/`);
				const file = join(dir, 'run.sh');
				writeFileSync(file, script);
				const out = execFileSync('sh', [file], { encoding: 'utf8' });
				expect(readExitMarker(out)).toBe(0); // probe passed, restic (stubbed) ran
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
