/**
 * Pure transport predicates for the streaming put-archive path. Import-light (no docker.ts /
 * db deps) so it's unit-testable — this is the edge-cap SAFEGUARD the whole streaming design
 * leans on: if this wrongly reported an edge env as streamable, the uncapped stream path would
 * run and the buffered+capped fallback would never engage (OOM risk).
 */

import { PassThrough, type Readable } from 'node:stream';

/** Minimal shape we branch on (a subset of DockerClientConfig). */
export interface TransportConfig {
	connectionType?: string | null;
}

// A stalled tar upload has NO absolute timeout (a legit multi-GB tar can take a long time), so its
// only backstop is the helper's 6h ceiling - a half-dead agent that accepts the connection then
// stops reading would hang for hours. An IDLE (progress-based) watchdog distinguishes "slow but
// alive" from "dead": it fails only after N minutes of ZERO bytes flowing, and resets on every chunk.
export const TAR_IDLE_TIMEOUT_MS = Number(process.env.BACKUP_TAR_IDLE_MS) || 5 * 60_000;

/** Wrap a tar stream so it aborts (destroys) after TAR_IDLE_TIMEOUT_MS of zero throughput. The
 * timer resets on every chunk that flows through (i.e. every chunk the receiver actually read via
 * backpressure), so a stalled receiver trips it while a slow-but-progressing upload does not.
 * Import-light (node:stream only) so it's unit-testable without docker.ts. */
export function withIdleWatchdog(tar: Readable, label: string, idleMs = TAR_IDLE_TIMEOUT_MS): Readable {
	const out = new PassThrough();
	let timer: ReturnType<typeof setTimeout> | null = null;
	const arm = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			const err = new Error(`${label}: no data flowed for ${Math.round(idleMs / 1000)}s - the target is not reading (stalled/dead); aborting upload`);
			tar.destroy(err);
			out.destroy(err);
		}, idleMs);
	};
	const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
	// A chunk crossing the PassThrough means the receiver drained the previous one (backpressure) -
	// real forward progress. Reset the idle timer on each.
	out.on('data', arm);
	out.on('end', disarm);
	out.on('close', disarm);
	tar.on('error', (e) => out.destroy(e));
	arm();
	return tar.pipe(out);
}

/** True when this env's transport can stream a request body with O(1) RAM. hawser-edge CANNOT
 * (its WebSocket protocol base64s the whole tar into one frame); everything else (socket,
 * direct, hawser-standard, and the local/undefined case) goes through node http/https core,
 * which streams. Keep this the SINGLE source of the stream-vs-buffer decision. */
export function transportCanStream(config: TransportConfig): boolean {
	return config.connectionType !== 'hawser-edge';
}

/** Strip shell/URL-dangerous chars from an archive path before it goes into the PUT query. */
export function sanitizeArchivePath(path: string): string {
	return path.replace(/[;&|`$(){}[\]<>'"\\]/g, '');
}
