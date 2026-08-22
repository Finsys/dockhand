/**
 * Unit tests for resolveHostStackDir — the ONE decision point for WHICH host folder is
 * captured as a stack's directory. ONE FLOW: the helper always bind-mounts the host stack
 * folder. The candidate path comes from the compose `working_dir` label ALONE (ground truth
 * for where compose ran on the target daemon's host - staged, matching-path, or local); a
 * runtime probe (not tested here) then proves it's reachable.
 */
import { describe, test, expect } from 'bun:test';
import {
	resolveHostStackDir,
	hostStackDirFromBind,
	deriveStackDirFromBinds,
	trustBindDerivedForEnv,
	parseProbeListing,
	tagCapturedEntries,
	isLocalDaemon,
	STACKDIR_VOLUME_KEY,
	isReservedVolumeKey,
	stackDirSource,
	type HostStackDirInput,
} from '../../src/lib/server/backups/stackdir-plan';

const base = (over: Partial<HostStackDirInput> = {}): HostStackDirInput => ({
	composeFileName: 'docker-compose.yml',
	bindDerivedHostPath: null,
	dataDirHostPath: null,
	mountHostPath: null,
	workingDirLabel: null,
	...over,
});

describe('resolveHostStackDir — host path in priority order (bind-derived first, label last)', () => {
	test('bindDerivedHostPath wins over EVERYTHING (daemon-authoritative)', () => {
		const r = resolveHostStackDir(base({
			bindDerivedHostPath: '/docker/data/dockhand/stacks/anton/pppppp',
			dataDirHostPath: '/somewhere/else',
			workingDirLabel: '/app/data/stacks/anton/pppppp',
		}));
		expect(r.kind).toBe('candidate');
		if (r.kind === 'candidate') {
			expect(r.hostPath).toBe('/docker/data/dockhand/stacks/anton/pppppp');
			expect(r.source).toContain('bind');
		}
	});

	test('remoteStacksDirHostPath (direct-remote, user-configured) wins over data/mount/label', () => {
		// A direct-remote env with remote_stacks_dir set: the deploy staged the files at this
		// explicit host path, so it beats the (untrustworthy for direct-remote) label and the
		// local-only translations.
		const r = resolveHostStackDir(base({
			remoteStacksDirHostPath: '/opt/dockhand/stacks/myapp',
			dataDirHostPath: '/docker/data/dockhand/stacks/myapp',
			workingDirLabel: '/app/data/stacks/myapp',
		}));
		expect(r.kind).toBe('candidate');
		if (r.kind === 'candidate') {
			expect(r.hostPath).toBe('/opt/dockhand/stacks/myapp');
			expect(r.source).toContain('remote_stacks_dir');
		}
	});

	test('a relative bind still pins the dir more exactly than remote_stacks_dir', () => {
		const r = resolveHostStackDir(base({
			bindDerivedHostPath: '/opt/dockhand/stacks/myapp',
			remoteStacksDirHostPath: '/opt/dockhand/stacks/myapp',
		}));
		expect(r.kind).toBe('candidate');
		if (r.kind === 'candidate') expect(r.source).toContain('bind');
	});

	test('SOCKET/LOCAL: DATA_DIR->HOST_DATA_DIR translation wins over the working_dir label', () => {
		// The regression from the label-only resolver: on a socket env Dockhand deploys under
		// /app/data (its CONTAINER view). The helper on the host needs /docker/data/dockhand/...
		// The working_dir label is the container path and must NOT be used when the DATA_DIR
		// translation is available.
		const r = resolveHostStackDir(base({
			dataDirHostPath: '/docker/data/dockhand/stacks/anton/pppppp',
			workingDirLabel: '/app/data/stacks/anton/pppppp',   // container view - the wrong one
		}));
		expect(r.kind).toBe('candidate');
		if (r.kind === 'candidate') {
			expect(r.hostPath).toBe('/docker/data/dockhand/stacks/anton/pppppp');
			expect(r.hostPath).not.toBe('/app/data/stacks/anton/pppppp');   // never the container path
			expect(r.source).toContain('DATA_DIR');
		}
	});

	test('ADOPTED/EXTERNAL: mount translation used when not under DATA_DIR', () => {
		const r = resolveHostStackDir(base({ dataDirHostPath: null, mountHostPath: '/opt/stacks/blog', workingDirLabel: '/app/data/x' }));
		expect(r.kind === 'candidate' && r.hostPath).toBe('/opt/stacks/blog');
		expect((r as any).source).toContain('mount');
	});

	test('HAWSER / matching-paths: working_dir label used when no translation applies', () => {
		// A hawser agent ran compose on the remote host, so the label IS the host path.
		const r = resolveHostStackDir(base({ dataDirHostPath: null, mountHostPath: null, workingDirLabel: '/data/stacks/immich' }));
		expect(r.kind === 'candidate' && r.hostPath).toBe('/data/stacks/immich');
		expect((r as any).source).toContain('working_dir');
	});

	test('composeFile taken from composeFileName (authoritative), NOT config_files', () => {
		const r = resolveHostStackDir(base({ composeFileName: 'immich.yaml', dataDirHostPath: '/h/x' }));
		expect(r.kind === 'candidate' && r.composeFile).toBe('immich.yaml');
	});

	test("composeFileName '-' (stdin deploy) falls back to docker-compose.yml, never probes for '-'", () => {
		// Dockhand deploys via `-f -` (stdin) so config_files is `-`. composeFileName is `-` too
		// when derived from that; the resolver must NOT build a probe path ending in `/-`.
		const r = resolveHostStackDir(base({ composeFileName: '-', dataDirHostPath: '/h/x' }));
		expect(r.kind === 'candidate' && r.composeFile).toBe('docker-compose.yml');
	});

	test('null composeFileName falls back to docker-compose.yml', () => {
		const r = resolveHostStackDir(base({ composeFileName: null, dataDirHostPath: '/h/x' }));
		expect(r.kind === 'candidate' && r.composeFile).toBe('docker-compose.yml');
	});

	test('trailing slashes on the chosen host path are normalized', () => {
		expect((resolveHostStackDir(base({ dataDirHostPath: '/h/x/' })) as any).hostPath).toBe('/h/x');
		expect((resolveHostStackDir(base({ mountHostPath: '/m/y///' })) as any).hostPath).toBe('/m/y');
	});

	test('NO BINDS: falls back to DATA_DIR translation (socket stack with only named volumes)', () => {
		// A stack with no bind mounts (only named volumes, or none) can't be bind-derived, so
		// bindDerivedHostPath is null. On socket the DATA_DIR translation still resolves it.
		const r = resolveHostStackDir(base({ bindDerivedHostPath: null, dataDirHostPath: '/docker/data/dockhand/stacks/x' }));
		expect(r.kind === 'candidate' && r.hostPath).toBe('/docker/data/dockhand/stacks/x');
	});

	test('NO BINDS + no translation + no label -> unknown (conscious hard-fail, never a silent skip)', () => {
		// The remaining gap the user worried about: no bind to derive from AND no translation
		// (self-inspect failed / HOST_DATA_DIR unknown) AND no label. This is a CONSCIOUS
		// unknown -> the caller hard-fails the stack backup rather than capturing an empty dir.
		expect(resolveHostStackDir(base({ bindDerivedHostPath: null, dataDirHostPath: null, mountHostPath: null, workingDirLabel: null })).kind).toBe('unknown');
	});
});

describe('hostStackDirFromBind — derive the stack dir from a relative bind + daemon source', () => {
	test('the anton case: ./html on host /docker/data/dockhand/stacks/anton/pppppp/html', () => {
		expect(hostStackDirFromBind('./html', '/docker/data/dockhand/stacks/anton/pppppp/html'))
			.toBe('/docker/data/dockhand/stacks/anton/pppppp');
	});
	test('nested relative dir ./conf/nginx strips the whole tail', () => {
		expect(hostStackDirFromBind('./conf/nginx', '/srv/stacks/blog/conf/nginx')).toBe('/srv/stacks/blog');
	});
	test('whole-dir bind ./ (or .) -> the host source IS the stack dir', () => {
		expect(hostStackDirFromBind('./', '/srv/stacks/blog')).toBe('/srv/stacks/blog');
		expect(hostStackDirFromBind('.', '/srv/stacks/blog')).toBe('/srv/stacks/blog');
	});
	test('trailing slash on the host source is normalized before stripping', () => {
		expect(hostStackDirFromBind('./html', '/srv/blog/html/')).toBe('/srv/blog');
	});
	test('ABSOLUTE bind source -> null (not relative, cannot derive)', () => {
		expect(hostStackDirFromBind('/opt/data', '/opt/data')).toBeNull();
	});
	test('../ source (above the stack dir) -> null', () => {
		expect(hostStackDirFromBind('../shared', '/srv/shared')).toBeNull();
	});
	test('host source that does NOT end with the relative tail -> null (inconsistent, do not guess)', () => {
		expect(hostStackDirFromBind('./html', '/srv/blog/public')).toBeNull();
	});
	test('non-absolute host source -> null', () => {
		expect(hostStackDirFromBind('./html', 'relative/html')).toBeNull();
	});
});

describe('deriveStackDirFromBinds — match compose relative dirs to discovered bind sources', () => {
	test('finds the stack dir from the matching bind source', () => {
		expect(deriveStackDirFromBinds(['html'], ['/docker/data/dockhand/stacks/anton/pppppp/html']))
			.toBe('/docker/data/dockhand/stacks/anton/pppppp');
	});
	test('picks the first relative dir that has a consistent source', () => {
		// data has no matching source; html does.
		expect(deriveStackDirFromBinds(['data', 'html'], ['/srv/blog/html'])).toBe('/srv/blog');
	});
	test('no matching source -> null (caller falls back to translation/label)', () => {
		expect(deriveStackDirFromBinds(['html'], ['/unrelated/path'])).toBeNull();
	});
	test('no relative dirs -> null', () => {
		expect(deriveStackDirFromBinds([], ['/srv/blog/html'])).toBeNull();
	});
});

describe('trustBindDerivedForEnv — distrust the phantom bind path on direct-remote stdin deploys', () => {
	const P = '/app/data/stacks/test-direct/myapp'; // a phantom Dockhand-container path
	test('direct-remote + NO remote_stacks_dir -> null (falls through to tar; the #4921 regression)', () => {
		// The stdin deploy made the remote daemon mkdir a phantom empty dir at Dockhand's own
		// container path; trusting it made the probe mount an empty dir and HARD-FAIL the backup.
		expect(trustBindDerivedForEnv(P, { directRemote: true, hasRemoteStacksDir: false })).toBeNull();
	});
	test('direct-remote WITH remote_stacks_dir -> kept (deploy staged the files, bind pins the real path)', () => {
		expect(trustBindDerivedForEnv(P, { directRemote: true, hasRemoteStacksDir: true })).toBe(P);
	});
	test('NOT direct-remote (socket / direct-local / adopted) -> kept (daemon shares Dockhand\'s host)', () => {
		expect(trustBindDerivedForEnv(P, { directRemote: false, hasRemoteStacksDir: false })).toBe(P);
	});
	test('hawser (directRemote=false) -> kept (agent ran compose on its own host, mount.Source is real)', () => {
		expect(trustBindDerivedForEnv('/opt/stacks/immich', { directRemote: false, hasRemoteStacksDir: false }))
			.toBe('/opt/stacks/immich');
	});
	test('already-null bind-derived stays null regardless of env', () => {
		expect(trustBindDerivedForEnv(null, { directRemote: false, hasRemoteStacksDir: false })).toBeNull();
		expect(trustBindDerivedForEnv(null, { directRemote: true, hasRemoteStacksDir: true })).toBeNull();
	});
});

describe('isLocalDaemon — DATA_DIR/mount translation is only valid on Dockhand\'s own host', () => {
	test('socket / null -> local', () => {
		expect(isLocalDaemon('socket', null, null)).toBe(true);
		expect(isLocalDaemon(null, null, null)).toBe(true);
	});
	test('hawser -> never local (the rambo case: remote host, translation would be wrong)', () => {
		expect(isLocalDaemon('hawser-standard', null, 'tcp://x:2375')).toBe(false);
		expect(isLocalDaemon('hawser-edge', null, null)).toBe(false);
	});
	test('direct -> local ONLY when the env tcp host == Dockhand\'s own docker host', () => {
		expect(isLocalDaemon('direct', 'tcp://h:2375', 'tcp://h:2375')).toBe(true);
		expect(isLocalDaemon('direct', 'tcp://rambo:2375', 'tcp://anton:2375')).toBe(false);
		expect(isLocalDaemon('direct', 'tcp://h:2375', null)).toBe(false);
	});
});

describe('stack-dir reserved-key helpers (unchanged)', () => {
	test('the reserved key is recognized', () => {
		expect(isReservedVolumeKey(STACKDIR_VOLUME_KEY)).toBe(true);
		expect(isReservedVolumeKey('my_data')).toBe(false);
	});
	test('stackDirSource points at the single /volumes location restore reads', () => {
		expect(stackDirSource().include).toBe(`/volumes/${STACKDIR_VOLUME_KEY}`);
		expect(stackDirSource().extractSub).toBe(`volumes/${STACKDIR_VOLUME_KEY}`);
	});
});

describe('parseProbeListing — the host probe `find -printf` listing', () => {
	test('parses dirs and files with sizes, dirs first then alpha', () => {
		const out = parseProbeListing('f\t155\tcompose.yaml\nd\t4096\tmedia\nd\t4096\tconfig\nf\t9\t.env');
		expect(out).toEqual([
			{ name: 'config', type: 'dir', size: 4096 },
			{ name: 'media', type: 'dir', size: 4096 },
			{ name: '.env', type: 'file', size: 9 },
			{ name: 'compose.yaml', type: 'file', size: 155 },
		]);
	});
	test('names with spaces survive (tab-delimited, not space)', () => {
		const out = parseProbeListing('f\t10\tmy config.yaml');
		expect(out).toEqual([{ name: 'my config.yaml', type: 'file', size: 10 }]);
	});
	test('non-d type is treated as file', () => {
		const out = parseProbeListing('l\t0\tsymlink');
		expect(out[0]).toEqual({ name: 'symlink', type: 'file', size: 0 });
	});
	test('empty stdout -> empty list', () => {
		expect(parseProbeListing('')).toEqual([]);
		expect(parseProbeListing('\n\n')).toEqual([]);
	});
	test('malformed lines (missing tabs) are skipped', () => {
		const out = parseProbeListing('garbage line\nf\t5\tgood.txt');
		expect(out).toEqual([{ name: 'good.txt', type: 'file', size: 5 }]);
	});
	test('non-numeric size falls back to 0', () => {
		expect(parseProbeListing('f\tNaN\tx')[0].size).toBe(0);
	});
});

describe('tagCapturedEntries — mark stack-dir entries that are also a bind', () => {
	const entries = [
		{ name: 'config', type: 'dir' as const, size: 4096 },
		{ name: 'uploads', type: 'dir' as const, size: 4096 },
		{ name: 'compose.yaml', type: 'file' as const, size: 100 },
		{ name: 'README.txt', type: 'file' as const, size: 20 }
	];
	test('bind-dir entries get capturedAs:bind; loose files stay untagged', () => {
		const out = tagCapturedEntries(entries, '/opt/immich', ['/opt/immich/config', '/opt/immich/uploads']);
		expect(out.find((e) => e.name === 'config')?.capturedAs).toBe('bind');
		expect(out.find((e) => e.name === 'uploads')?.capturedAs).toBe('bind');
		expect(out.find((e) => e.name === 'compose.yaml')?.capturedAs).toBeUndefined();
		expect(out.find((e) => e.name === 'README.txt')?.capturedAs).toBeUndefined(); // the DATA_OLD case
	});
	test('trailing slash on hostPath or source is tolerated', () => {
		const out = tagCapturedEntries([{ name: 'data', type: 'dir', size: 1 }], '/opt/app/', ['/opt/app/data/']);
		expect(out[0].capturedAs).toBe('bind');
	});
	test('a bind OUTSIDE the stack dir does not match an equally-named entry', () => {
		// entry 'media' under /opt/app, but the only bind source is /mnt/media (absolute, elsewhere)
		const out = tagCapturedEntries([{ name: 'media', type: 'dir', size: 1 }], '/opt/app', ['/mnt/media']);
		expect(out[0].capturedAs).toBeUndefined();
	});
	test('no bind sources -> nothing tagged', () => {
		const out = tagCapturedEntries(entries, '/opt/immich', []);
		expect(out.every((e) => e.capturedAs === undefined)).toBe(true);
	});

	// STOPPED stack: the daemon reports no bind sources (containers aren't running), so the
	// compose bind-dir names are what tag `./memos` as captured-by-bind — without this, a stopped
	// stack's bind dir wrongly shows as a plain, deselectable stack file.
	test('compose bind-dir names tag entries even when runtime bindSources is empty', () => {
		const es = [
			{ name: 'memos', type: 'dir' as const, size: 4096 },
			{ name: 'compose.yaml', type: 'file' as const, size: 100 }
		];
		const out = tagCapturedEntries(es, '/docker/data/stacks/x', [], ['memos']);
		expect(out.find((e) => e.name === 'memos')?.capturedAs).toBe('bind');
		expect(out.find((e) => e.name === 'compose.yaml')?.capturedAs).toBeUndefined();
	});
	test('bindSources and bindDirNames are unioned (either tags an entry)', () => {
		const es = [
			{ name: 'data', type: 'dir' as const, size: 1 },   // via bindSources
			{ name: 'memos', type: 'dir' as const, size: 1 }   // via bindDirNames only
		];
		const out = tagCapturedEntries(es, '/opt/app', ['/opt/app/data'], ['memos']);
		expect(out.find((e) => e.name === 'data')?.capturedAs).toBe('bind');
		expect(out.find((e) => e.name === 'memos')?.capturedAs).toBe('bind');
	});
	test('a name NOT in bindDirNames and NOT a bind source stays untagged', () => {
		const out = tagCapturedEntries([{ name: 'readme.txt', type: 'file', size: 10 }], '/opt/app', [], ['memos']);
		expect(out[0].capturedAs).toBeUndefined();
	});
});
