import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

/**
 * Fetch from the local Docker socket directly
 */
async function localDockerFetch(path: string): Promise<Response> {
	const socketPath = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
	return fetch(`http://localhost${path}`, {
		// @ts-ignore - Bun supports unix sockets
		unix: socketPath
	});
}

/**
 * Strip Docker log stream multiplexing headers.
 * Docker prefixes each frame with an 8-byte header:
 * [stream_type(1)] [0(3)] [size(4 big-endian)]
 */
function stripDockerLogHeaders(raw: Uint8Array): string {
	const lines: string[] = [];
	let offset = 0;

	while (offset < raw.length) {
		// Check if we have a Docker stream header (8 bytes)
		if (offset + 8 <= raw.length) {
			const streamType = raw[offset];
			// Stream type should be 0 (stdin), 1 (stdout), or 2 (stderr)
			if (streamType <= 2) {
				// Read the 4-byte big-endian size
				const size = (raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
				if (size > 0 && offset + 8 + size <= raw.length) {
					const frameData = new TextDecoder().decode(raw.slice(offset + 8, offset + 8 + size));
					const frameLines = frameData.split('\n');
					for (const line of frameLines) {
						if (line.trim()) {
							lines.push(line);
						}
					}
					offset += 8 + size;
					continue;
				}
			}
		}
		// Fallback: decode remaining as plain text
		const remaining = new TextDecoder().decode(raw.slice(offset));
		const remainingLines = remaining.split('\n');
		for (const line of remainingLines) {
			if (line.trim()) {
				lines.push(line);
			}
		}
		break;
	}

	return lines.join('\n');
}

/**
 * Poll updater container logs and status for progress tracking.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAdmin) {
		return json({ error: 'Admin access required' }, { status: 403 });
	}

	const containerId = url.searchParams.get('id');
	if (!containerId) {
		return json({ error: 'Container ID is required' }, { status: 400 });
	}

	try {
		// Check container state
		const inspectResponse = await localDockerFetch(`/containers/${containerId}/json`);

		if (!inspectResponse.ok) {
			if (inspectResponse.status === 404) {
				// Container removed (AutoRemove after exit)
				return json({ logs: '', status: 'removed' });
			}
			return json({ error: 'Failed to inspect container' }, { status: 500 });
		}

		const info = await inspectResponse.json() as {
			State?: { Status: string; ExitCode: number; Running: boolean };
		};

		const status = info.State?.Running ? 'running' : 'exited';
		const exitCode = info.State?.ExitCode ?? 0;

		// Fetch logs
		const logsResponse = await localDockerFetch(
			`/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=false`
		);

		let logs = '';
		if (logsResponse.ok && logsResponse.body) {
			const rawBytes = new Uint8Array(await logsResponse.arrayBuffer());
			logs = stripDockerLogHeaders(rawBytes);
		}

		return json({ logs, status, exitCode });
	} catch (err) {
		return json({ error: 'Failed to fetch progress: ' + String(err) }, { status: 500 });
	}
};
