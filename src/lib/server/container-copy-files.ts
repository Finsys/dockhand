/** File preservation for Docker API recreation. Snapshots stay in memory. */
import { posix } from 'node:path';
import { packTar, unpackTar } from 'modern-tar';
import { DOCKHAND_LABELS } from './container-labels';

export const COPY_FILE_MAX_BYTES = 1024 * 1024;
export const COPY_FILE_MAX_ARCHIVE_BYTES = COPY_FILE_MAX_BYTES + 64 * 1024;
export const COPY_FILE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_PATHS = 64;
const TIMEOUT_MS = 30_000;
// Includes reservations for downloads in progress, across concurrent updates.
let reservedBytes = 0;

type Mount = { Type?: string; Destination?: string; Target?: string; RW?: boolean; ReadOnly?: boolean };
export interface CopyFileContainer {
	Id: string;
	Config?: { Labels?: Record<string, string> | null };
	HostConfig?: {
		ReadonlyRootfs?: boolean;
		Mounts?: Mount[];
		Binds?: string[] | null;
		Tmpfs?: Record<string, string>;
	};
	Mounts?: Mount[];
}
export type CopyFileRequest = (path: string, options: RequestInit & { streaming?: boolean }) => Promise<Response>;
type Log = (message: string) => void;

export function isCopyFilePath(path: string): boolean {
	return path.startsWith('/') && path !== '/' && !path.endsWith('/') &&
		posix.normalize(path) === path && !/[\x00-\x1f\x7f\\,]/.test(path) &&
		!path.split('/').some(part => part === '.' || part === '..');
}

export function copyFilePaths(labels?: Record<string, string> | null): string[] {
	const value = labels?.[DOCKHAND_LABELS.COPY_FILE];
	if (value == null || value.trim() === '') return [];
	if (value.length > 16 * 1024) throw new Error('dockhand.copy-file label exceeds 16 KiB');
	const paths = [...new Set(value.split(',').map(path => path.trim()))];
	if (paths.length > MAX_PATHS) throw new Error(`dockhand.copy-file allows at most ${MAX_PATHS} files`);
	for (const path of paths) {
		if (!isCopyFilePath(path)) {
			throw new Error(`dockhand.copy-file requires clean absolute file paths: ${JSON.stringify(path)}`);
		}
	}
	return paths;
}

/** Use the deepest covering mount: a writable nested mount can shadow a read-only one. */
function coveringMount(container: CopyFileContainer, path: string): Mount | undefined {
	const host = container.HostConfig;
	const mounts: Mount[] = [
		...(container.Mounts ?? []),
		...(host?.Mounts ?? []),
		...(host?.Binds ?? []).map(bind => {
			const [source, target, options = ''] = bind.split(':');
			return { Type: source.startsWith('/') ? 'bind' : 'volume', Target: target, ReadOnly: options.split(',').includes('ro') };
		}),
		...Object.keys(host?.Tmpfs ?? {}).map(Target => ({ Type: 'tmpfs', Target }))
	];
	let best: Mount | undefined;
	let length = -1;
	for (const mount of mounts) {
		const target = mount.Destination ?? mount.Target;
		if (!target) continue;
		const dest = posix.normalize(target);
		if (dest.length > length && (path === dest || path.startsWith(dest === '/' ? '/' : dest + '/'))) {
			best = { ...mount, Target: dest };
			length = dest.length;
		}
	}
	return best;
}

export function copyFileDisposition(container: CopyFileContainer, path: string): 'copy' | 'mounted' {
	const mount = coveringMount(container, path);
	// Stopping loses tmpfs data; archive writes before start cannot restore it reliably.
	if (mount?.Type === 'tmpfs') throw new Error(`dockhand.copy-file cannot preserve a tmpfs file: ${path}`);
	if (mount && (mount.Type === 'bind' || mount.Type === 'volume') &&
		(mount.Target === path || mount.ReadOnly || mount.RW === false)) return 'mounted';
	if (container.HostConfig?.ReadonlyRootfs) {
		throw new Error(`dockhand.copy-file cannot inject into a read-only root filesystem: ${path}`);
	}
	return 'copy';
}

/** Repack a single regular file, dropping links, extra entries, xattrs and special mode bits. */
export async function sanitizeCopyFileArchive(archive: Uint8Array, path: string): Promise<Uint8Array> {
	if (!isCopyFilePath(path)) throw new Error('dockhand.copy-file requires a clean absolute file path');
	if (archive.length > COPY_FILE_MAX_ARCHIVE_BYTES) throw new Error('dockhand.copy-file archive exceeds size limit');
	let entries;
	try {
		let count = 0;
		entries = await unpackTar(archive, {
			strict: true,
			filter(header) {
				const name = header.name.startsWith('./') ? header.name.slice(2) : header.name;
				if (++count !== 1 || header.type !== 'file' || header.linkname || name !== posix.basename(path) ||
					!Number.isSafeInteger(header.size) || header.size < 0 || header.size > COPY_FILE_MAX_BYTES ||
					[header.uid, header.gid, header.mode].some(n => n != null && (!Number.isSafeInteger(n) || n < 0))) {
					throw new Error('Invalid file entry');
				}
				return true;
			}
		});
		if (entries.length !== 1 || !entries[0].data || entries[0].data.length !== entries[0].header.size) {
			throw new Error('Missing file entry');
		}
	} catch {
		// Do not echo tar parser errors: malformed metadata may contain secret contents.
		throw new Error(`dockhand.copy-file expected one regular file of at most 1 MiB: ${path}`);
	}
	const { header, data } = entries[0];
	try {
		return await packTar([{
			header: {
				name: path.slice(1), type: 'file', size: data!.length,
				mode: (header.mode ?? 0o444) & 0o777,
				uid: header.uid ?? 0, gid: header.gid ?? 0, mtime: header.mtime
			},
			body: data
		}]);
	} finally {
		data!.fill(0);
	}
}

async function readArchive(response: Response, signal: AbortSignal): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error('Empty archive response');
	const cancel = () => { void reader.cancel().catch(() => {}); };
	signal.addEventListener('abort', cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		if (Number(response.headers.get('content-length')) > COPY_FILE_MAX_ARCHIVE_BYTES) {
			throw new Error('Archive exceeds size limit');
		}
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			size += value.length;
			if (size > COPY_FILE_MAX_ARCHIVE_BYTES) throw new Error('Archive exceeds size limit');
			chunks.push(value);
		}
		return Buffer.concat(chunks, size);
	} finally {
		signal.removeEventListener('abort', cancel);
		cancel();
	}
}

export interface CopyFileSnapshot {
	/** Inject before start, including when the original container was stopped. */
	inject(containerId: string): Promise<void>;
	/** Always call, including after failed stop/rename/create/start. */
	dispose(): void;
}

export async function snapshotContainerCopyFiles(
	container: CopyFileContainer, request: CopyFileRequest, log?: Log, discoveredPaths: readonly string[] = []
): Promise<CopyFileSnapshot> {
	// Explicit operator paths come first; discovery only fills gaps.
	const paths = [...new Set([...copyFilePaths(container.Config?.Labels), ...discoveredPaths])];
	if (paths.length > MAX_PATHS) throw new Error(`dockhand.copy-file allows at most ${MAX_PATHS} files including discovered secrets`);
	if (paths.some(path => !isCopyFilePath(path))) throw new Error('dockhand.copy-file requires clean absolute file paths');
	if (paths.length && container.Config?.Labels?.PODMAN_SYSTEMD_UNIT) {
		throw new Error('dockhand.copy-file is unsupported for systemd-managed containers; the unit controls creation and start');
	}
	// Complete mount/read-only validation before the first archive request.
	const selected = paths.filter(path => {
		if (copyFileDisposition(container, path) === 'copy') return true;
		log?.(`dockhand.copy-file: mount already provides ${path}`);
		return false;
	});
	const files: { path: string; archive: Uint8Array }[] = [];
	let heldBytes = 0;
	let disposed = false;
	const snapshot: CopyFileSnapshot = {
		async inject(containerId) {
			if (disposed) throw new Error('dockhand.copy-file snapshot already disposed');
			if (files.length) {
				// The replacement image or a container edit may introduce new mounts.
				// Refuse tmpfs/read-only targets before writing ANY files.
				const response = await request(`/containers/${containerId}/json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error('dockhand.copy-file could not inspect replacement mounts');
				}
				const target = await response.json() as CopyFileContainer;
				for (const file of files) {
					const mount = coveringMount(target, file.path);
					if (target.HostConfig?.ReadonlyRootfs || mount?.Type === 'tmpfs' || mount?.ReadOnly || mount?.RW === false) {
						throw new Error(`dockhand.copy-file cannot restore to a read-only or tmpfs destination: ${file.path}`);
					}
				}
			}
			for (const file of files) {
				try {
					// Extract relative full paths at / so Docker creates missing parent dirs.
					// Docker's copyUIDGID=true applies Config.User ownership to the tar.
					// Leave it false to preserve each entry's captured numeric uid/gid,
					// including root-owned secrets in a container running as non-root.
					const response = await request(`/containers/${containerId}/archive?path=%2F&copyUIDGID=false&noOverwriteDirNonDir=true`, {
						method: 'PUT', headers: { 'Content-Type': 'application/x-tar' },
						body: file.archive as BodyInit, signal: AbortSignal.timeout(TIMEOUT_MS)
					});
					await response.body?.cancel();
					if (!response.ok) throw new Error('Archive upload failed');
				} catch {
					throw new Error(`dockhand.copy-file failed to restore ${file.path}; replacement must not start`);
				}
				log?.(`dockhand.copy-file: restored ${file.path}`);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const file of files) file.archive.fill(0);
			files.length = 0;
			reservedBytes -= heldBytes;
			heldBytes = 0;
		}
	};
	try {
		for (const path of selected) {
			if (reservedBytes + COPY_FILE_MAX_ARCHIVE_BYTES > COPY_FILE_MAX_TOTAL_BYTES) {
				throw new Error('dockhand.copy-file snapshots exceed the 16 MiB memory limit; retry after other updates finish');
			}
			reservedBytes += COPY_FILE_MAX_ARCHIVE_BYTES;
			heldBytes += COPY_FILE_MAX_ARCHIVE_BYTES;
			let raw: Uint8Array | undefined;
			try {
				const signal = AbortSignal.timeout(TIMEOUT_MS);
				// Encode dots too: dockerFetch rejects literal '..' anywhere in a URL,
				// even in otherwise valid filenames such as token..backup. This is a
				// transport constraint, not path validation: isCopyFilePath already
				// rejects traversal segments, and Docker decodes the original filename.
				const encodedPath = encodeURIComponent(path).replaceAll('.', '%2E');
				const url = `/containers/${container.Id}/archive?path=${encodedPath}`;
				// Hawser Edge buffers replies. Stat before downloading so a mistaken
				// directory or large-file label doesn't ask the agent to buffer it all.
				const statResponse = await request(url, { method: 'HEAD', signal });
				await statResponse.body?.cancel();
				if (!statResponse.ok) throw new Error('Missing or unreadable file');
				const stat = JSON.parse(Buffer.from(statResponse.headers.get('X-Docker-Container-Path-Stat') ?? '', 'base64').toString('utf8'));
				// Go os.FileMode's type bits: directory, link, device, pipe, socket,
				// character device, irregular. Ordinary/special permission bits differ.
				if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > COPY_FILE_MAX_BYTES ||
					!Number.isSafeInteger(stat.mode) || stat.mode < 0 || stat.mode > 0xffffffff ||
					(stat.mode & 0x8f280000) !== 0 || stat.linkTarget) {
					throw new Error('Not a regular file within size limit');
				}
				const response = await request(url, { streaming: true, signal });
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error('Missing or unreadable file');
				}
				raw = await readArchive(response, signal);
				const archive = await sanitizeCopyFileArchive(raw, path);
				files.push({ path, archive });
				const unused = COPY_FILE_MAX_ARCHIVE_BYTES - archive.length;
				reservedBytes -= unused;
				heldBytes -= unused;
			} catch {
				throw new Error(`dockhand.copy-file could not snapshot ${path}; file must exist, be regular, and fit within 1 MiB`);
			} finally {
				raw?.fill(0);
			}
			log?.(`dockhand.copy-file: captured ${path}`);
		}
		return snapshot;
	} catch (error) {
		snapshot.dispose();
		throw error;
	}
}
