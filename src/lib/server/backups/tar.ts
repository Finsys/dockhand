/**
 * Build the tar we put-archive (docker cp) into the backup helper, replacing the
 * base64-in-Cmd approach that blew ARG_MAX on large stack files.
 *
 * `modern-tar` is zero-dependency and emits PAX headers, so paths of ANY length
 * round-trip (the old hand-rolled USTAR writer threw on names >100 bytes, breaking
 * deep stack trees). Zero deps also matters for CI: it installs into a symlinked
 * node_modules where libs with transitive deps fail to resolve them.
 */

import { packTar } from 'modern-tar';

export interface TarEntry {
	/** Path inside the archive, e.g. "metadata/stacks/foo/compose.yaml". A leading slash is stripped. */
	path: string;
	content: Uint8Array;
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
