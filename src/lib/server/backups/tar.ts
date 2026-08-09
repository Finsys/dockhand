/**
 * Build the tar we put-archive (docker cp) into the backup helper.
 *
 * `modern-tar` is zero-dependency and emits PAX headers, so paths of ANY length
 * round-trip (USTAR caps names at 100 bytes, breaking deep stack trees). Zero deps
 * also matters for CI: it installs into a symlinked node_modules where libs with
 * transitive deps fail to resolve them.
 */

import { packTar, createTarPacker } from 'modern-tar';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

export interface TarEntry {
	/** Path inside the archive, e.g. "metadata/stacks/foo/compose.yaml". A leading slash is stripped. */
	path: string;
	content: Uint8Array;
}

/** A file to stream into the tar lazily from disk (no in-RAM contents). */
export interface TarFileSource {
	/** Absolute path on disk to read from. */
	diskPath: string;
	/** Path inside the archive (leading slash stripped). */
	archivePath: string;
}

/**
 * Build a tar as a streaming web ReadableStream, reading each file from disk LAZILY (O(1)
 * RAM regardless of total size). Used by the backup helper's streaming put-archive so a
 * huge stack dir never buffers in memory. Entries are produced in the given order; the
 * consumer (the HTTP request) drives the pace via backpressure.
 *
 * `inlineEntries` (e.g. the small metadata.json) are written first from memory; then each
 * file source is streamed from disk. NOTE: the header size is fixed from statSync but the
 * body is read lazily via createReadStream, so a file that GROWS or SHRINKS between stat and
 * read makes modern-tar's packer throw ("exceeds given size" / "Size mismatch") and errors
 * the whole stream - the run FAILS loudly (it is NOT silently tolerated). This is acceptable
 * because the backup helper's stack dir is quiescent (the stack is stopped or the files are
 * config); a mid-capture size change is a real problem the caller should see, not hide.
 */
export function buildTarStream(sources: TarFileSource[], inlineEntries: TarEntry[] = [], mtimeSecs = Math.floor(Date.now() / 1000)): ReadableStream<Uint8Array> {
	const packer = createTarPacker();
	const mtime = new Date(mtimeSecs * 1000);

	(async () => {
		try {
			for (const e of inlineEntries) {
				const w = packer.controller.add({ name: e.path.replace(/^\/+/, ''), size: e.content.length, mode: 0o644, mtime, uid: 0, gid: 0, uname: 'root', gname: 'root', type: 'file' });
				await Readable.toWeb(Readable.from(Buffer.from(e.content))).pipeTo(w);
			}
			for (const s of sources) {
				const size = statSync(s.diskPath).size;
				const w = packer.controller.add({ name: s.archivePath.replace(/^\/+/, ''), size, mode: 0o644, mtime, uid: 0, gid: 0, uname: 'root', gname: 'root', type: 'file' });
				await Readable.toWeb(createReadStream(s.diskPath)).pipeTo(w);
			}
			packer.controller.finalize();
		} catch (err) {
			// Surface the failure to the consumer by erroring the stream.
			packer.controller.error(err);
		}
	})();

	return packer.readable;
}

/** Build a tar (any path length via PAX). `mtimeSecs` injectable for deterministic tests. */
export function buildTar(entries: TarEntry[], mtimeSecs = Math.floor(Date.now() / 1000)): Promise<Uint8Array> {
	return packTar(
		entries.map((e) => ({
			header: {
				name: e.path.replace(/^\/+/, ''),
				size: e.content.length,
				mode: 0o644,
				mtime: new Date(mtimeSecs * 1000),
				uid: 0,
				gid: 0,
				uname: 'root',
				gname: 'root',
				type: 'file' as const,
			},
			body: e.content,
		})),
	);
}
