/**
 * put-archive-stream.ts — a BACKUP-ONLY streaming upload to a container's PUT /archive.
 *
 * WHY a separate function (not the shared putContainerArchive): the shared one has three
 * callers (file-browser upload, the files-upload API, and backup). It routes through
 * `dockerFetch`, whose plain-HTTP path uses global `fetch` (undici) which BUFFERS the whole
 * request body in RAM (verified: 200 MB file -> 239 MB RSS). For the backup helper we want
 * to stream a large stack-dir tar with O(1) RAM, so we go straight to node http/https core
 * (verified: 200 MB -> 43 MB RSS). Keeping this backup-only means the file-upload paths are
 * completely untouched.
 *
 * TRANSPORTS:
 *   - socket / plain-http (direct, hawser-standard)  -> node http.request, pipe the tar in.
 *   - https / mTLS (direct, hawser-standard TLS)      -> httpsAgentRequest (its ReadableStream
 *                                                        body branch streams via req.write).
 *   - hawser-edge                                     -> CANNOT stream (its WS protocol frames
 *                                                        the whole base64 tar). canStream()
 *                                                        returns false; the caller falls back
 *                                                        to the buffered putContainerArchive.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { getDockerConfig, httpsAgentRequest, putContainerArchive, type DockerClientConfig } from '../docker';

// Pure transport predicates + the idle watchdog live in an import-light module so they can be
// unit-tested without pulling docker.ts (and thus better-sqlite3).
import { transportCanStream, sanitizeArchivePath, withIdleWatchdog } from './put-archive-transport';
export { transportCanStream, sanitizeArchivePath, withIdleWatchdog };

/** PUT a streaming tar into a container over a unix socket or plain HTTP, via node
 * http.request (streams the piped body — unlike undici fetch, which buffers). */
function putViaNodeHttp(config: DockerClientConfig, containerId: string, archivePath: string, tar: Readable, extraHeaders: Record<string, string>): Promise<void> {
	return new Promise((resolve, reject) => {
		const path = `/containers/${containerId}/archive?path=${encodeURIComponent(sanitizeArchivePath(archivePath))}`;
		const reqOptions: http.RequestOptions = config.type === 'socket'
			? { socketPath: config.socketPath, path, method: 'PUT', headers: { 'Content-Type': 'application/x-tar', ...extraHeaders } }
			: { host: config.host, port: config.port, path, method: 'PUT', headers: { 'Content-Type': 'application/x-tar', ...extraHeaders } };

		const req = http.request(reqOptions, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => {
				const status = res.statusCode ?? 0;
				if (status >= 200 && status < 300) resolve();
				else reject(new Error(`put-archive-stream: PUT /archive -> ${status} ${Buffer.concat(chunks).toString().slice(0, 200)}`));
			});
			res.on('error', reject);
		});
		req.on('error', reject);
		// Idle watchdog: abort if the target stops reading (backpressure stalls the tar) so a
		// half-dead agent can't hang the backup up to the 6h helper ceiling.
		const guarded = withIdleWatchdog(tar, 'put-archive-stream');
		guarded.on('error', (e) => req.destroy(e));
		guarded.pipe(req); // streams: node writes chunks as the tar produces them, O(1) RAM
	});
}

/**
 * Stream a tar (a web ReadableStream, e.g. from modern-tar's createTarPacker) into a
 * container's PUT /archive with O(1) RAM. Returns false WITHOUT uploading if the env's
 * transport can't stream (hawser-edge) — the caller must then use the buffered path.
 */
export async function putContainerArchiveStreaming(
	containerId: string,
	archivePath: string,
	tar: ReadableStream<Uint8Array>,
	envId: number | null | undefined,
): Promise<{ streamed: boolean }> {
	const config = await getDockerConfig(envId ?? undefined);
	if (!transportCanStream(config)) {
		console.log(`[Backup] put-archive-stream: env ${envId} is ${config.connectionType} (cannot stream) — caller should use the buffered path`);
		return { streamed: false };
	}

	const extraHeaders: Record<string, string> = {};
	if (config.connectionType === 'hawser-standard' && config.hawserToken) {
		extraHeaders['X-Hawser-Token'] = config.hawserToken;
	}

	console.log(`[Backup] put-archive-stream: streaming tar to container ${containerId.slice(0, 12)} via ${config.type} (${config.connectionType ?? 'local'})`);

	if (config.type === 'https') {
		// httpsAgentRequest streams a ReadableStream body (req.write per chunk) and, seeing a
		// stream body, skips the 30s idle timeout meant for small requests - a multi-GB tar PUT
		// can legitimately stall >30s (slow disk, mTLS backpressure, GC) without being dead. Run it
		// through the idle watchdog (node Readable) so a truly-stalled target still aborts.
		const guardedWeb = Readable.toWeb(withIdleWatchdog(Readable.fromWeb(tar as unknown as NodeReadableStream), 'put-archive-stream')) as unknown as ReadableStream<Uint8Array>;
		const res = await httpsAgentRequest(config, `/containers/${containerId}/archive?path=${encodeURIComponent(sanitizeArchivePath(archivePath))}`,
			{ method: 'PUT', headers: { 'Content-Type': 'application/x-tar', ...extraHeaders }, body: guardedWeb }, false, extraHeaders);
		if (!res.ok) throw new Error(`put-archive-stream: PUT /archive -> ${res.status} ${(await res.text()).slice(0, 200)}`);
		await res.body?.cancel().catch(() => {});
		return { streamed: true };
	}

	// socket or plain http: node http.request, pipe the tar (converted to a node Readable).
	await putViaNodeHttp(config, containerId, archivePath, Readable.fromWeb(tar as unknown as NodeReadableStream), extraHeaders);
	return { streamed: true };
}

/** Re-exported for the caller's buffered fallback (edge). */
export { putContainerArchive };
