/**
 * Mapping a path inside Dockhand's container to the one the daemon knows. Everything
 * Dockhand hands the daemon - a helper's bind source, a compose relative volume - goes
 * through this, so a wrong answer here fails a backup before it starts.
 */
import { describe, test, expect } from 'bun:test';
import { resolveHostPath, type ContainerMount } from '../src/lib/server/host-path';

const bind = (destination: string, source: string): ContainerMount => ({ source, destination, type: 'bind' });
const volume = (destination: string, name: string): ContainerMount => ({
	source: `/var/lib/docker/volumes/${name}/_data`,
	destination,
	type: 'volume',
	name
});
const tmpfs = (destination: string): ContainerMount => ({ source: '', destination, type: 'tmpfs' });

const map = (path: string, mounts: ContainerMount[], hostDataDir: string | null = null) =>
	resolveHostPath(path, mounts, '/app/data', hostDataDir);

describe('resolveHostPath', () => {
	test('maps a path under a bind to its host source', () => {
		const r = map('/app/data/stacks/web', [bind('/app/data', '/docker/data/dockhand')]);
		expect(r.ok && r.hostPath).toBe('/docker/data/dockhand/stacks/web');
		expect(r.ok && r.via).toBe('bind');
	});

	test('maps a path under a named volume to where Docker keeps it', () => {
		const r = map('/app/data/stacks/web', [volume('/app/data', 'dh_data')]);
		expect(r.ok && r.hostPath).toBe('/var/lib/docker/volumes/dh_data/_data/stacks/web');
		expect(r.ok && r.via).toBe('volume');
	});

	// Overlapping mounts: the files live under the deepest one, so it has to win.
	test('the most specific mount wins', () => {
		const mounts = [volume('/app/data', 'dh_data'), bind('/app/data/stacks', '/opt/stacks')];
		const inner = map('/app/data/stacks/web', mounts);
		expect(inner.ok && inner.hostPath).toBe('/opt/stacks/web');
		// ...and a sibling path still resolves through the outer one.
		const other = map('/app/data/db', mounts);
		expect(other.ok && other.hostPath).toBe('/var/lib/docker/volumes/dh_data/_data/db');
	});

	test('order of the mount list does not decide the answer', () => {
		const a = [volume('/app/data', 'dh_data'), bind('/app/data/stacks', '/opt/stacks')];
		const b = [...a].reverse();
		const ra = map('/app/data/stacks/web', a);
		const rb = map('/app/data/stacks/web', b);
		expect(ra.ok && ra.hostPath).toBe(rb.ok ? rb.hostPath : 'differs');
	});

	test('maps the mount point itself', () => {
		const r = map('/app/data', [bind('/app/data', '/host/d')]);
		expect(r.ok && r.hostPath).toBe('/host/d');
	});

	test('ignores a trailing slash on either side', () => {
		const r = map('/app/data/stacks/', [bind('/app/data/', '/host/d/')]);
		expect(r.ok && r.hostPath).toBe('/host/d/stacks');
	});

	// A tmpfs reports an empty Source and lives in memory: joining a subpath onto ''
	// would hand the daemon a path rooted at the host filesystem.
	test('refuses a mount with nothing on disk behind it', () => {
		const r = map('/app/data/stacks/web', [tmpfs('/app/data')]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.failure.reason).toBe('mount-not-on-disk');
	});

	test('refuses a bind whose source is empty', () => {
		const r = map('/app/data/x', [{ source: '', destination: '/app/data', type: 'bind' }]);
		expect(r.ok).toBe(false);
	});

	// An older daemon may omit Type; that must not be read as "not a disk".
	test('accepts a mount that does not state its type', () => {
		const r = map('/app/data/stacks/web', [{ source: '/host/d', destination: '/app/data' }]);
		expect(r.ok && r.hostPath).toBe('/host/d/stacks/web');
	});

	test('reports when no mount covers the path', () => {
		const r = map('/etc/hosts', [bind('/app/data', '/host/d')]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.failure.reason).toBe('no-mount-covers');
	});

	test('reports when Dockhand has no mounts at all', () => {
		const r = map('/app/data/x', []);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.failure.reason).toBe('not-containerized');
	});

	// HOST_DATA_DIR answers for the DATA_DIR subtree where introspection cannot, so it is a
	// FALLBACK: a mount that covers the path is the more specific truth.
	test('HOST_DATA_DIR answers for DATA_DIR when only the DATA_DIR mount covers the path', () => {
		const r = map('/app/data/stacks/web', [volume('/app/data', 'dh_data')], '/mnt/appdata/dockhand');
		// The volume mount reports a real source, so it wins; the override is not needed.
		expect(r.ok && r.via).toBe('volume');
	});

	// The #1533 topology: DATA_DIR on a volume with a DEEPER bind for the stacks subpath. The
	// operator's declaration names the host dir for the DATA_DIR ROOT and must not speak for a
	// subpath another mount names explicitly. Covered here rather than in integration because
	// both halves are the HOST's wiring (an env var and the mount table), which a test cannot
	// change on a running instance - and this function takes both as arguments.
	test('a bind deeper than DATA_DIR beats the override for its own subpath', () => {
		const mounts = [volume('/app/data', 'dh_data'), bind('/app/data/stacks', '/srv/stacks')];
		const r = map('/app/data/stacks/myapp', mounts, '/var/lib/docker/volumes/dh_data/_data');
		expect(r.ok && r.hostPath).toBe('/srv/stacks/myapp');
		expect(r.ok && r.via).toBe('bind');
	});

	test('the override still answers a DATA_DIR path no mount covers', () => {
		const r = map('/app/data/x', [bind('/other', '/h')], '/mnt/appdata/dockhand');
		expect(r.ok && r.hostPath).toBe('/mnt/appdata/dockhand/x');
		expect(r.ok && r.via).toBe('override');
	});

	test('the override rescues a DATA_DIR path whose mount is not on disk', () => {
		const r = map('/app/data/x', [tmpfs('/app/data')], '/mnt/appdata/dockhand');
		expect(r.ok && r.hostPath).toBe('/mnt/appdata/dockhand/x');
		expect(r.ok && r.via).toBe('override');
	});

	// A textual prefix test is satisfied by a traversal that leaves the mount, so the path is
	// normalized before coverage is decided.
	test('a traversal out of a mount is not attributed to it', () => {
		const r = map('/app/data/../etc/shadow', [bind('/app/data', '/h/d')]);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.failure.reason).toBe('no-mount-covers');
	});

	test('an interior double slash resolves to the same host path', () => {
		const r = map('/app/data//x', [bind('/app/data', '/h/d')]);
		expect(r.ok && r.hostPath).toBe('/h/d/x');
	});

	test('the override does not touch a path outside DATA_DIR', () => {
		const r = map('/external/web', [bind('/external', '/opt/ext')], '/mnt/appdata/dockhand');
		expect(r.ok && r.hostPath).toBe('/opt/ext/web');
		expect(r.ok && r.via).toBe('bind');
	});

	// The override speaks ONLY for the DATA_DIR subtree. A managed stack can sit outside it
	// (STACKS_DIR set independently), so when the override is actually REACHED for such a path
	// it must decline rather than fabricate a host path under HOST_DATA_DIR.
	test('the override declines a path outside DATA_DIR that no mount covers', () => {
		const r = map('/external/web', [bind('/other', '/h')], '/mnt/appdata/dockhand');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.failure.reason).toBe('no-mount-covers');
	});

	test('the override declines a path outside DATA_DIR when there are no mounts', () => {
		const r = map('/external/web', [], '/mnt/appdata/dockhand');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.failure.reason).toBe('not-containerized');
	});

	test('the override works with no mounts to infer from', () => {
		const r = map('/app/data/stacks/web', [], '/mnt/appdata/dockhand');
		expect(r.ok && r.hostPath).toBe('/mnt/appdata/dockhand/stacks/web');
	});
});
