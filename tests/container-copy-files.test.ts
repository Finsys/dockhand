import { describe, expect, test } from 'bun:test';
import { packTar, unpackTar, type TarHeader } from 'modern-tar';
import {
	copyFilePaths, copyFileDisposition, sanitizeCopyFileArchive, snapshotContainerCopyFiles as snapshotFiles,
	COPY_FILE_MAX_BYTES, COPY_FILE_MAX_ARCHIVE_BYTES, COPY_FILE_MAX_TOTAL_BYTES,
	type CopyFileContainer, type CopyFileSnapshot
} from '../src/lib/server/container-copy-files';

// Existing cases run against an ordinary daemon; remapping tests supply /info explicitly.
const snapshotContainerCopyFiles: typeof snapshotFiles = (container, request, ...args) => snapshotFiles(
	container, (url, options) => url === '/info' ? Promise.resolve(Response.json({ SecurityOptions: [] })) : request(url, options), ...args
);

const label = 'dockhand.copy-file';
const path = '/run/secrets/token';
const container: CopyFileContainer = { Id: 'old', Config: { Labels: { [label]: path } } };
const content = new Uint8Array([0, 255, 13, 10, 65]);
const statResponse = (stat = { size: content.length, mode: 0o640 }) => new Response(null, { headers: {
	'X-Docker-Container-Path-Stat': Buffer.from(JSON.stringify(stat)).toString('base64')
} });
const sourceResponse = (archive: Uint8Array) => new Response(archive, { headers: statResponse().headers });
const tar = (header: Partial<TarHeader> = {}, body = content) => packTar([{
	header: { name: 'token', type: 'file', size: body.length, mode: 0o640, uid: 123, gid: 456, ...header }, body
}]);

describe('dockhand.copy-file paths', () => {
	test('absent/blank labels do nothing; trims and deduplicates paths', () => {
		const cases: (Record<string, string> | null | undefined)[] = [undefined, null, {}, { [label]: '  ' }, { 'other.copy-file': path }];
		for (const labels of cases) {
			expect(copyFilePaths(labels)).toEqual([]);
		}
		expect(copyFilePaths({ [label]: ` ${path}, /etc/config,${path} ` })).toEqual([path, '/etc/config']);
	});
	test('rejects ambiguous, relative, traversal and non-file paths', () => {
		for (const value of ['token', '/', '/etc/', '/etc/../token', '/etc/./token', '//token', '/a//b', '/a\\b', '/a\0b', '/a\nb', '/a,', ',/a']) {
			expect(() => copyFilePaths({ [label]: value })).toThrow('absolute file paths');
		}
		expect(() => copyFilePaths({ [label]: Array.from({ length: 65 }, (_, i) => `/f${i}`).join(',') })).toThrow('64');
		expect(() => copyFilePaths({ [label]: '/' + 'a'.repeat(16384) })).toThrow('16 KiB');
	});
	test('preserves URL/shell punctuation literally (no shell or lossy path sanitization)', () => {
		const path = '/etc/a $b;&[]{}#?"é';
		expect(copyFilePaths({ [label]: path })).toEqual([path]);
	});
});

describe('mount handling', () => {
	test('copies writable-layer files and files below writable mounts', () => {
		expect(copyFileDisposition(container, path)).toBe('copy');
		for (const Type of ['bind', 'volume']) {
			expect(copyFileDisposition({ ...container, Mounts: [{ Type, Destination: '/run', RW: true }] }, path)).toBe('copy');
		}
	});
	test('skips exact persistent mounts and files supplied by read-only persistent mounts', () => {
		for (const Type of ['bind', 'volume']) {
			expect(copyFileDisposition({ ...container, Mounts: [{ Type, Destination: path, RW: true }] }, path)).toBe('mounted');
			expect(copyFileDisposition({ ...container, Mounts: [{ Type, Destination: '/run/secrets', RW: false }] }, path)).toBe('mounted');
		}
		expect(copyFileDisposition({ ...container, HostConfig: { Binds: ['/host:/run:ro'] } }, path)).toBe('mounted');
		expect(copyFileDisposition({ ...container, HostConfig: { Mounts: [{ Type: 'bind', Target: path }] } }, path)).toBe('mounted');
	});
	test('deepest mount wins; matches path components, including a root mount', () => {
		const Mounts = [{ Type: 'bind', Destination: '/', RW: false }, { Type: 'volume', Destination: '/run/secrets', RW: true }];
		expect(copyFileDisposition({ ...container, Mounts }, path)).toBe('copy');
		expect(copyFileDisposition({ ...container, Mounts }, '/etc/config')).toBe('mounted');
		expect(copyFileDisposition({ ...container, Mounts: [{ Type: 'bind', Destination: '/run/secret', RW: false }] }, path)).toBe('copy');
	});
	test('refuses tmpfs and read-only root writes before stopping', () => {
		for (const host of [{ Tmpfs: { '/run': '' } }, { Mounts: [{ Type: 'tmpfs', Target: '/run' }] }, { ReadonlyRootfs: true }]) {
			expect(() => copyFileDisposition({ ...container, HostConfig: host }, path)).toThrow();
		}
	});
});

describe('archive validation', () => {
	test('preserves binary bytes, uid/gid and permissions, strips special bits and xattrs', async () => {
		const archive = await sanitizeCopyFileArchive(await tar({ mode: 0o7640, pax: { 'SCHILY.xattr.user.test': 'discard' } }), path);
		const [file] = await unpackTar(archive, { strict: true });
		expect(file.header.name).toBe('run/secrets/token');
		expect(file.header.uid).toBe(123);
		expect(file.header.gid).toBe(456);
		expect(file.header.mode).toBe(0o640);
		expect(file.header.pax?.['SCHILY.xattr.user.test']).toBeUndefined();
		expect(file.data).toEqual(content);
	});
	test('handles empty files, ./ basenames and long destination paths', async () => {
		const dest = '/' + 'deep/'.repeat(40) + 'token';
		const [file] = await unpackTar(await sanitizeCopyFileArchive(await tar({ name: './token' }, new Uint8Array()), dest));
		expect(file.header.name).toBe(dest.slice(1));
		expect(file.data?.length).toBe(0);
	});
	test('rejects traversal, unexpected names, symlinks, hardlinks and special entries', async () => {
		for (const header of [
			{ name: '../token' }, { name: '/token' }, { name: 'unexpected' },
			{ type: 'symlink', linkname: '/etc/passwd', size: 0 }, { type: 'link', linkname: 'token', size: 0 },
			{ type: 'directory', size: 0 }, { type: 'fifo', size: 0 }
		] as Partial<TarHeader>[]) {
			await expect(sanitizeCopyFileArchive(await tar(header, header.size === 0 ? new Uint8Array() : content), path)).rejects.toThrow('one regular file');
		}
	});
	test('rejects extra members, oversized payloads, corrupt headers and truncated content', async () => {
		const extra = await packTar(['token', 'extra'].map(name => ({ header: { name, type: 'file' as const, size: 1 }, body: 'x' })));
		const oversized = await tar({}, new Uint8Array(COPY_FILE_MAX_BYTES + 1));
		const corrupt = await tar(); corrupt[0] ^= 1;
		for (const archive of [extra, oversized, corrupt, (await tar()).slice(0, 513), new Uint8Array()]) {
			await expect(sanitizeCopyFileArchive(archive, path)).rejects.toThrow('one regular file');
		}
	});
});

describe('snapshot lifecycle', () => {
	test('explicit paths precede discovery, duplicates copy once, and combined limits apply', async () => {
		const reads: string[] = [];
		const snapshot = await snapshotContainerCopyFiles(container, async (url, options) => {
			const target = new URL(url, 'http://docker').searchParams.get('path')!;
			if (options.method === 'HEAD') return statResponse();
			reads.push(target);
			return new Response(await tar({ name: target.split('/').at(-1) }));
		}, undefined, ['/etc/extra', path, '/etc/extra']);
		try { expect(reads).toEqual([path, '/etc/extra']); } finally { snapshot.dispose(); }
		await expect(snapshotContainerCopyFiles(container, async () => { throw new Error('Unexpected I/O'); }, undefined,
			Array.from({ length: 64 }, (_, i) => `/f${i}`))).rejects.toThrow('64');
	});
	test('unlabeled containers do no additional I/O', async () => {
		const snapshot = await snapshotContainerCopyFiles({ Id: 'old' }, async () => { throw new Error('Unexpected I/O'); });
		await snapshot.inject('new');
		snapshot.dispose();
	});
	test('encodes exact source paths and restores at root with numeric ownership', async () => {
		const oddPath = '/etc/a.. $b;&[]{}#?"é';
		const calls: string[] = [];
		const snapshot = await snapshotContainerCopyFiles({ ...container, Config: { Labels: { [label]: oddPath } } }, async (url, options) => {
			calls.push(url);
			if (url.endsWith('/json')) return Response.json({ Id: 'new' });
			if (options.method === 'HEAD') return statResponse();
			if (options.method === 'PUT') {
				expect(url).toContain('path=%2F&copyUIDGID=false');
				expect((await unpackTar(options.body as Uint8Array))[0].header.name).toBe(oddPath.slice(1));
				return new Response(null, { status: 200 });
			}
			expect(new URL(url, 'http://docker').searchParams.get('path')).toBe(oddPath);
			return new Response(await tar({ name: oddPath.slice(5) }));
		});
		try { await snapshot.inject('new'); } finally { snapshot.dispose(); }
		expect(calls.length).toBe(4);
	});
	test('failed reads do not expose response bodies or parser contents', async () => {
		await expect(snapshotContainerCopyFiles(container, async () => new Response('SECRET-VALUE', { status: 404 }))).rejects.toThrow('could not snapshot');
	});
	test('rejects oversized streaming responses and cancels unread chunks', async () => {
		let cancelled = false;
		await expect(snapshotContainerCopyFiles(container, async (_url, options) => options.method === 'HEAD' ? statResponse() : new Response(new ReadableStream({
			pull(c) { c.enqueue(new Uint8Array(COPY_FILE_MAX_ARCHIVE_BYTES + 1)); },
			cancel() { cancelled = true; }
		})))).rejects.toThrow('could not snapshot');
		expect(cancelled).toBe(true);
	});
	test('refuses oversized or non-regular stat results without downloading the archive', async () => {
		for (const stat of [{ size: COPY_FILE_MAX_BYTES + 1, mode: 0o400 }, { size: 0, mode: 0x80000000 }, { size: 5, mode: 0x08000000 }]) {
			await expect(snapshotContainerCopyFiles(container, async (_url, options) => {
				expect(options.method).toBe('HEAD');
				return statResponse(stat);
			})).rejects.toThrow('could not snapshot');
		}
	});
	test('missing or malformed HEAD metadata aborts before GET', async () => {
		for (const value of [undefined, 'not-base64', Buffer.from('{}').toString('base64')]) {
			await expect(snapshotContainerCopyFiles(container, async (_url, options) => {
				expect(options.method).toBe('HEAD');
				return new Response(null, { headers: value ? { 'X-Docker-Container-Path-Stat': value } : {} });
			})).rejects.toThrow('could not snapshot');
		}
	});
	test('rejects systemd-managed containers without issuing requests', async () => {
		await expect(snapshotContainerCopyFiles({ ...container, Config: { Labels: { [label]: path, PODMAN_SYSTEMD_UNIT: 'app.service' } } }, async () => { throw new Error('unexpected'); })).rejects.toThrow('systemd-managed');
	});
	test('checks new mounts before writing; upload failures are fatal', async () => {
		for (const fail of ['readonly', 'tmpfs', 'upload']) {
			let uploads = 0;
			const snapshot = await snapshotContainerCopyFiles(container, async (url, options) => {
				if (options.method === 'HEAD') return statResponse();
				if (url.endsWith('/json')) return Response.json({ HostConfig: fail === 'readonly' ? { ReadonlyRootfs: true } : fail === 'tmpfs' ? { Tmpfs: { '/run': '' } } : {} });
				if (options.method === 'PUT') { uploads++; return new Response('SECRET', { status: 500 }); }
				return new Response(await tar());
			});
			try { await expect(snapshot.inject('new')).rejects.toThrow('dockhand.copy-file'); } finally { snapshot.dispose(); }
			expect(uploads).toBe(fail === 'upload' ? 1 : 0);
		}
	});
	test('caps snapshots across concurrent updates and releases capacity after disposal or errors', async () => {
		const large = await tar({}, new Uint8Array(COPY_FILE_MAX_BYTES));
		const snapshots: CopyFileSnapshot[] = [];
		try {
			const count = Math.floor((COPY_FILE_MAX_TOTAL_BYTES - COPY_FILE_MAX_ARCHIVE_BYTES) / large.length) + 1;
			for (let i = 0; i < count; i++) snapshots.push(await snapshotContainerCopyFiles(container, async () => sourceResponse(large.slice())));
			await expect(snapshotContainerCopyFiles(container, async () => sourceResponse(large.slice()))).rejects.toThrow('16 MiB');
		} finally { for (const snapshot of snapshots) { snapshot.dispose(); snapshot.dispose(); } }
		const snapshot = await snapshotContainerCopyFiles(container, async () => sourceResponse(large.slice()));
		snapshot.dispose();
		await expect(snapshot.inject('new')).rejects.toThrow('disposed');
	});
});

describe('user namespace ownership', () => {
	const source: CopyFileContainer = { ...container, Config: { ...container.Config, User: '12345:12346' } };
	const info = (SecurityOptions = ['name=userns'], ServerVersion = '29.8.2') => Response.json({ SecurityOptions, ServerVersion });

	test('remapped daemons use the configured user once for all files, keeping bytes and modes', async () => {
		const calls: string[] = [];
		const logs: string[] = [];
		let uploads = 0;
		const snapshot = await snapshotFiles(source, async (url, options) => {
			calls.push(url);
			if (url === '/info') return info(['name=seccomp,profile=builtin', 'name=userns,profile=custom']);
			if (url.endsWith('/json')) return Response.json(source);
			if (options.method === 'HEAD') return statResponse();
			if (options.method === 'PUT') {
				expect(url).toContain('copyUIDGID=true');
				const [file] = await unpackTar(options.body as Uint8Array);
				expect(file.data).toEqual(content);
				expect(file.header.mode).toBe(0o640);
				expect(file.header.uid).toBe(uploads++ === 0 ? 165536 : 177881);
				return new Response(null);
			}
			const path = new URL(url, 'http://docker').searchParams.get('path')!;
			return new Response(await tar({ name: path.split('/').at(-1), uid: path.endsWith('token') ? 165536 : 177881 }));
		}, message => logs.push(message), ['/run/secrets/other']);
		try { await snapshot.inject('new'); } finally { snapshot.dispose(); }
		expect(calls.filter(url => url === '/info').length).toBe(1);
		expect(uploads).toBe(2);
		expect(logs.some(line => line.includes('replacement container user'))).toBe(true);
	});

	test('ordinary/rootless daemons and unavailable info retain captured ownership', async () => {
		for (const getInfo of [
			() => info([]), () => info(['name=rootless']), () => info(['name=usernsx', 'profile=userns']),
			() => new Response(null, { status: 403 }), () => Response.json({}),
			() => Response.json({ SecurityOptions: [null] }), () => { throw new Error('offline'); }
		]) {
			const snapshot = await snapshotFiles(source, async (url, options) => {
				if (url === '/info') return getInfo();
				if (url.endsWith('/json')) return Response.json(source);
				if (options.method === 'HEAD') return statResponse();
				if (options.method === 'PUT') { expect(url).toContain('copyUIDGID=false'); return new Response(null); }
				return new Response(await tar());
			});
			try { await snapshot.inject('new'); } finally { snapshot.dispose(); }
		}
	});

	test('unsupported remapped engines, empty users and host mode fail before archive requests', async () => {
		for (const version of ['28.5.0', '29.6.2', '29.7.0-rc.1', '', 'unknown']) {
			await expect(snapshotFiles(source, async url => {
				expect(url).toBe('/info'); return info(['name=userns'], version);
			})).rejects.toThrow('29.7.0');
		}
		for (const target of [
			{ ...source, Config: { User: '' } }, { ...source, Config: {} },
			{ ...source, HostConfig: { UsernsMode: 'host' } }
		]) {
			await expect(snapshotFiles(source, async url => {
				expect(url).toBe('/info'); return info();
			}, undefined, [], target)).rejects.toThrow('remapped daemon');
		}
	});

	test('explicit root and newer engines are supported; replacement configuration is rechecked', async () => {
		for (const user of ['0', '0:0', 'app:app', '12345:12346']) {
			for (const replacement of ['same', 'empty', 'host']) {
				let uploads = 0;
				const target = { ...source, Config: { User: user } };
				const snapshot = await snapshotFiles(source, async (url, options) => {
					if (url === '/info') return info(['name=userns'], '30.0.0');
					if (url.endsWith('/json')) return Response.json(replacement === 'empty'
						? { ...target, Config: {} } : replacement === 'host' ? { ...target, HostConfig: { UsernsMode: 'host' } } : target);
					if (options.method === 'HEAD') return statResponse();
					if (options.method === 'PUT') { uploads++; expect(url).toContain('copyUIDGID=true'); return new Response(null); }
					return new Response(await tar());
				}, undefined, [], target);
				try {
					if (replacement === 'same') await snapshot.inject('new');
					else await expect(snapshot.inject('new')).rejects.toThrow('remapped daemon');
					expect(uploads).toBe(replacement === 'same' ? 1 : 0);
				} finally { snapshot.dispose(); }
			}
		}
	});

	test('mounted files do not need daemon info or ownership changes', async () => {
		const snapshot = await snapshotFiles({ ...container, Mounts: [{ Type: 'bind', Destination: path, RW: false }] }, async () => {
			throw new Error('Unexpected I/O');
		});
		try { await snapshot.inject('new'); } finally { snapshot.dispose(); }
	});
});
