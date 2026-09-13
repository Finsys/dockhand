/**
 * Unit tests for isUnbackupableBindSource — the shared rule that keeps sockets
 * and host system paths out of backups (both the engine's "backup all" and the
 * UI picker). A regression here would either re-admit /var/run/docker.sock into
 * snapshots or wrongly exclude real data binds like /app/data.
 */
import { describe, test, expect } from 'bun:test';
import { isUnbackupableBindSource } from '../src/lib/utils/unbackupable-mounts';

describe('isUnbackupableBindSource', () => {
	test('docker + containerd sockets are unbackupable', () => {
		expect(isUnbackupableBindSource('/var/run/docker.sock')).toBe(true);
		expect(isUnbackupableBindSource('/run/docker.sock')).toBe(true);
		expect(isUnbackupableBindSource('/run/containerd/containerd.sock')).toBe(true);
		// rootless docker socket path (under /var/run prefix)
		expect(isUnbackupableBindSource('/var/run/user/1000/docker.sock')).toBe(true);
		// a socket bound from an unusual path still caught by basename
		expect(isUnbackupableBindSource('/opt/custom/docker.sock')).toBe(true);
	});

	test('host system paths are unbackupable', () => {
		expect(isUnbackupableBindSource('/proc')).toBe(true);
		expect(isUnbackupableBindSource('/proc/sys')).toBe(true);
		expect(isUnbackupableBindSource('/sys/fs/cgroup')).toBe(true);
		expect(isUnbackupableBindSource('/dev')).toBe(true);
		expect(isUnbackupableBindSource('/dev/net/tun')).toBe(true);
		expect(isUnbackupableBindSource('/var/run')).toBe(true);
		expect(isUnbackupableBindSource('/run')).toBe(true);
		// trailing slash tolerated
		expect(isUnbackupableBindSource('/var/run/')).toBe(true);
	});

	test('real data binds stay backupable', () => {
		expect(isUnbackupableBindSource('/app/data')).toBe(false);
		expect(isUnbackupableBindSource('/external-stacks')).toBe(false);
		expect(isUnbackupableBindSource('/backups')).toBe(false);
		expect(isUnbackupableBindSource('/home/user/stacks/myapp')).toBe(false);
		// a data dir that merely CONTAINS 'run' or 'dev' as a segment is fine
		expect(isUnbackupableBindSource('/srv/dev-data')).toBe(false);
		expect(isUnbackupableBindSource('/data/runner')).toBe(false);
		// prefix must be a full segment: /developer is NOT /dev
		expect(isUnbackupableBindSource('/developer')).toBe(false);
		expect(isUnbackupableBindSource('/systemd-data')).toBe(false);
	});

	test('named volumes (non-absolute) and empty are backupable', () => {
		expect(isUnbackupableBindSource('my_named_volume')).toBe(false);
		expect(isUnbackupableBindSource('')).toBe(false);
		expect(isUnbackupableBindSource(undefined)).toBe(false);
		expect(isUnbackupableBindSource(null)).toBe(false);
	});
});
