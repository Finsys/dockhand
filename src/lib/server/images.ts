/**
 * Image operations that don't belong in the transport layer (docker.ts). Starts
 * with `loadImage` (docker load from an uploaded tar); the rest of the image
 * functions still live in docker.ts and can migrate here incrementally.
 */

import { dockerFetch, getDockerConfig } from './docker';

/** A line from the /images/load progress stream. Docker sends `{stream: "..."}` for
 *  progress and `{errorDetail: {...}}` / `{error: "..."}` on failure. */
export interface LoadProgress {
	stream?: string;
	error?: string;
	errorDetail?: { message?: string };
}

/**
 * Loads a Docker image from a tar stream (equivalent to `docker load`), for
 * air-gapped hosts with no registry access. The tar is streamed straight to the
 * daemon's `POST /images/load` without buffering it in memory, so a multi-GB image
 * does not OOM Dockhand. `onProgress` receives each parsed progress line.
 *
 * Only supported on connection types where Dockhand streams the request body to the
 * daemon: socket (local), direct HTTP, and direct HTTPS/mTLS. Hawser (standard/edge)
 * is rejected up front - the WS transport can't stream a large upload - with an
 * actionable error rather than a silent failure mid-transfer.
 */
export async function loadImage(
	tar: ReadableStream<Uint8Array>,
	onProgress?: (data: LoadProgress) => void,
	envId?: number | null
): Promise<void> {
	const config = await getDockerConfig(envId);
	if (config.connectionType === 'hawser-edge' || config.connectionType === 'hawser-standard') {
		throw new Error(
			'Uploading an image tar is not supported on Hawser connections yet; use a local or direct-TCP environment.'
		);
	}

	// quiet=false so the daemon streams progress (loaded image name) back.
	const response = await dockerFetch(
		'/images/load?quiet=false',
		{
			method: 'POST',
			streaming: true,
			headers: { 'Content-Type': 'application/x-tar' },
			body: tar
		},
		envId
	);

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Failed to load image (HTTP ${response.status})${body ? `: ${body}` : ''}`);
	}

	// Docker streams NDJSON progress inside a 200 response, and reports a failed load
	// as an {errorDetail}/{error} line - capture it and throw after the stream ends.
	const reader = response.body?.getReader();
	if (!reader) return;
	const decoder = new TextDecoder();
	let buffer = '';
	let streamError: string | null = null;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() || '';
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const data = JSON.parse(line) as LoadProgress;
				if (data.error || data.errorDetail) {
					streamError = data.errorDetail?.message || data.error || 'Image load failed';
				}
				onProgress?.(data);
			} catch {
				// ignore non-JSON keepalive lines
			}
		}
	}

	if (streamError) {
		throw new Error(`Failed to load image: ${streamError}`);
	}
}
