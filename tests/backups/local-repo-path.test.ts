import { describe, test, expect } from 'bun:test';
import { classifyLocalRepoPath, localRepoPathError, localRepoIssueFor, type ContainerMount } from '../../src/lib/server/backups/local-repo-path';

// The #1506 mount: host /opt/dockhand-backups -> container /app/local-backups.
const MOUNTS: ContainerMount[] = [
	{ source: '/opt/dockhand-backups', destination: '/app/local-backups' },
	{ source: '/host/data', destination: '/app/data' }
];

describe('classifyLocalRepoPath', () => {
	test('container-side path under a bind resolves to the host path (the correct config)', () => {
		const v = classifyLocalRepoPath('/app/local-backups/Nextcloud', MOUNTS);
		expect(v.ok).toBe(true);
		expect(v.ok && v.hostPath).toBe('/opt/dockhand-backups/Nextcloud');
	});

	test('exact mount destination maps to the mount source', () => {
		const v = classifyLocalRepoPath('/app/local-backups', MOUNTS);
		expect(v.ok && v.hostPath).toBe('/opt/dockhand-backups');
	});

	test('the #1506 mistake (host path typed in) is rejected', () => {
		const v = classifyLocalRepoPath('/opt/dockhand-backups/Nextcloud', MOUNTS);
		expect(v.ok).toBe(false);
		expect(v.ok === false && v.reason).toBe('not-under-bind');
		expect(v.ok === false && v.mountHints).toContain('/app/local-backups');
	});

	test('a path under no mount at all is rejected', () => {
		const v = classifyLocalRepoPath('/some/random/dir', MOUNTS);
		expect(v.ok).toBe(false);
	});

	test('no mounts known (bare metal) -> allowed, container path IS the host path', () => {
		const v = classifyLocalRepoPath('/mnt/backups/repo', []);
		expect(v.ok).toBe(true);
		expect(v.ok && v.hostPath).toBeNull();
		expect(v.ok && 'reason' in v && v.reason).toBe('no-mounts');
	});

	test('most specific mount wins (longest destination)', () => {
		const nested: ContainerMount[] = [
			{ source: '/host/a', destination: '/app' },
			{ source: '/host/b', destination: '/app/local-backups' }
		];
		const v = classifyLocalRepoPath('/app/local-backups/repo', nested);
		expect(v.ok && v.hostPath).toBe('/host/b/repo');
	});

	test('a sibling that only shares a prefix is not treated as inside the mount', () => {
		// /app/local-backups-old must NOT match the /app/local-backups bind.
		const v = classifyLocalRepoPath('/app/local-backups-old/repo', MOUNTS);
		expect(v.ok).toBe(false);
	});

	test('trailing slashes on the mount destination/source are handled', () => {
		const trailing: ContainerMount[] = [{ source: '/host/x/', destination: '/app/y/' }];
		const v = classifyLocalRepoPath('/app/y/repo', trailing);
		expect(v.ok && v.hostPath).toBe('/host/x/repo');
	});
});

describe('localRepoIssueFor (the init/test guard decision)', () => {
	test('remote repo is NEVER rejected, whatever the mounts (the key safety invariant)', () => {
		// isLocal=false: s3/rest/b2/sftp must always pass, even with mounts present.
		expect(localRepoIssueFor('s3:https://s3.amazonaws.com/bucket', false, MOUNTS)).toBeNull();
		expect(localRepoIssueFor('rest:http://rest:8000/repo', false, [])).toBeNull();
		expect(localRepoIssueFor('sftp:user@host:/repo', false, MOUNTS)).toBeNull();
	});

	test('local repo under a bind is allowed', () => {
		expect(localRepoIssueFor('/app/local-backups/Nextcloud', true, MOUNTS)).toBeNull();
	});

	test('local repo on bare metal (no mounts) is allowed', () => {
		expect(localRepoIssueFor('/mnt/backups/repo', true, [])).toBeNull();
	});

	test('local repo NOT under any bind returns the #1506 error', () => {
		const issue = localRepoIssueFor('/opt/dockhand-backups/Nextcloud', true, MOUNTS);
		expect(issue).not.toBeNull();
		expect(issue).toContain('/opt/dockhand-backups/Nextcloud');
		expect(issue).toContain('/app/local-backups');
	});
});

describe('localRepoPathError', () => {
	test('names the bad path and lists the mount hints', () => {
		const msg = localRepoPathError('/opt/dockhand-backups/Nextcloud', ['/app/local-backups', '/app/data']);
		expect(msg).toContain('/opt/dockhand-backups/Nextcloud');
		expect(msg).toContain('/app/local-backups');
		expect(msg.toLowerCase()).toContain('container');
	});

	test('reads cleanly with no mount hints', () => {
		const msg = localRepoPathError('/x', []);
		expect(msg).toContain('/x');
		expect(msg).not.toContain('undefined');
	});
});
