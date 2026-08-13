/**
 * Stage a stack's files onto a REMOTE `direct` daemon's host filesystem.
 *
 * A `direct` env has no agent and no shared FS with Dockhand, so a `docker compose up`
 * over TCP resolves relative binds (`./config.yaml`, `./data`) against a path the remote
 * daemon can't see - it auto-creates empty dirs. This function puts the stack dir onto the
 * remote host under `remoteDir` (compose points there via --project-directory), using a
 * throwaway helper container + the Docker put-archive API - the same mechanism the backup
 * helper uses to write to a remote host. After this runs, the relative binds resolve.
 *
 * The tar is STREAMED from disk (O(1) RAM) via the same primitive the backup helper uses:
 * a stack dir with a large relative bind (a few-GB ./data) must not buffer in memory.
 * DIRECT streams (transportCanStream is true for everything but hawser-edge, which never
 * reaches this code - staging is direct-only).
 *
 * DIRECT ONLY. Socket shares the FS; Hawser has an agent that writes files itself.
 */
import { runContainerWithStreaming } from './docker';
import { buildTarStream, type TarFileSource } from './backups/tar';
import { putContainerArchiveStreaming } from './backups/put-archive-stream';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const STAGER_IMAGE = 'alpine:latest';

export interface StageResult {
	staged: number;
	remoteDir: string;
}

/** Walk a stack dir into TarFileSource[] (disk paths, no in-RAM contents), so the tar
 * streams lazily. `.git` is skipped. There is deliberately NO per-file size cap: the tar
 * streams from disk with O(1) RAM, so a large relative-bind file (a big ./data config)
 * must stage in full - a cap would defeat the whole point of streaming. */
function collectSources(rootDir: string): TarFileSource[] {
	const sources: TarFileSource[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === '.git') continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) { walk(full); continue; }
			if (!entry.isFile()) continue;
			// archivePath is POSIX-relative to rootDir (tar entries under remoteDir).
			sources.push({ diskPath: full, archivePath: relative(rootDir, full).split(sep).join('/') });
		}
	};
	walk(rootDir);
	return sources;
}

/**
 * Stream the stack dir at `localDir` onto the remote host at `remoteDir` via a helper
 * container. Throws on failure so the caller fails loudly instead of deploying against
 * empty dirs (a silent no-op deploy).
 *
 * @param envId     the direct env whose daemon hosts the files
 * @param remoteDir absolute path on the remote host (validated by the API layer)
 * @param localDir  the local stack dir to stage (its files land under remoteDir 1:1)
 */
export async function stageStackDirOnRemote(
	envId: number,
	remoteDir: string,
	localDir: string
): Promise<StageResult> {
	const sources = collectSources(localDir);
	if (sources.length === 0) return { staged: 0, remoteDir };

	const name = `dockhand-stage-${envId}-${Math.floor(Date.now() / 1000)}`;

	await runContainerWithStreaming({
		image: STAGER_IMAGE,
		// The container only needs to exist for the put-archive in beforeStart; the bind mount
		// itself creates remoteDir on the remote host, then it exits immediately.
		cmd: ['sh', '-c', `mkdir -p '${remoteDir.replace(/'/g, "'\\''")}'`],
		binds: [`${remoteDir}:${remoteDir}:rw`],
		name,
		envId,
		timeout: 300000,
		labels: { 'io.dockhand.role': 'stackfile-stager' },
		// After create, before start: the bind mount already exists, so a streaming put-archive
		// lands the files on the remote host FS under remoteDir with O(1) RAM.
		beforeStart: async (containerId: string) => {
			const tar = buildTarStream(sources);
			const { streamed } = await putContainerArchiveStreaming(containerId, remoteDir, tar, envId);
			// direct always streams; a false here would mean a transport we don't stage on.
			if (!streamed) throw new Error(`remote staging: transport for env ${envId} cannot stream the stack dir`);
		},
	});

	return { staged: sources.length, remoteDir };
}
