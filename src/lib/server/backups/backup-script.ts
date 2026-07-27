/**
 * backups/backup-script.ts — pure builder for the ONE backup session-container
 * script. No I/O, so it is unit-testable directly.
 *
 * The whole backup runs in a single helper container: it writes the restore
 * metadata (and any small stack files) into an in-container /metadata directory,
 * then runs `restic backup /volumes /metadata`. There is no throwaway metadata
 * volume and no mid-run Docker interaction — one container, one restic call.
 *
 * The script does NOT use `set -e` around the restic step, and it prints restic's
 * real exit code via the shared exit marker (see ./restic-script), so a partial
 * backup (restic exit 3) is reported as a warning rather than a hard failure.
 */
import { shellQuote, finishScript } from './restic-script';

/** A small file to materialise inside the container before the backup runs
 * (metadata.json, and for stacks the compose/.env files). `path` is relative to
 * /metadata; `contentBase64` is the base64 of the file bytes. */
export interface MetadataFile {
	path: string;
	contentBase64: string;
}

/**
 * Build the backup session script.
 *
 * The metadata files (metadata.json, and for stacks the compose/.env and the
 * whole stackfiles/ tree) are NOT written by this script — they are streamed into
 * the container's /metadata directory via the Docker put-archive API BEFORE the
 * container starts (see restic.ts runInHelper). Embedding their base64 inline in
 * the Cmd used to blow the kernel ARG_MAX for large stack files ("argument list
 * too long"); put-archive has no such limit.
 *
 * So the script only:
 *   1. ensures /metadata exists (put-archive already created it, but be defensive
 *      for the no-files case), and
 *   2. runs `restic backup /volumes/ /metadata/ ...` with the given args.
 * The restic step's exit code is captured via the marker (finishScript), so the
 * caller reads the real code and never mistakes a partial backup for a failure.
 *
 * @param resticArgs the full restic argv (starting with 'backup') — already
 *                   tag/exclude/flag-assembled by the caller.
 */
export function buildBackupScript(resticArgs: string[]): string {
	// restic runs backgrounded so the SIGINT-forwarding trap can reach it on cancel
	// (SIGINT lets restic release its repo lock; a SIGKILL orphans it and hangs the
	// next backup on --retry-lock). The kill-0 re-wait loop only fires when a signal
	// interrupted the first `wait` early; a normal exit skips it, keeping restic's
	// real code (0/3) for the marker.
	const restic = `restic ${resticArgs.map(shellQuote).join(' ')}`;
	const step = `${restic} & __rpid=$!; trap 'kill -INT $__rpid 2>/dev/null' INT TERM; wait $__rpid; __rc=$?; while kill -0 $__rpid 2>/dev/null; do wait $__rpid; __rc=$?; done; ( exit $__rc )`;
	return `mkdir -p /metadata; set +e; ${finishScript(step)}`;
}

/**
 * Build the restic `backup` argv. Volumes are mounted read-only under /volumes
 * and metadata under /metadata, so both paths are backed up. The swap artifacts
 * are always excluded so a backup taken while a restore was interrupted never
 * captures the transient staging dirs.
 *
 * When the target has NO volumes/binds (`hasVolumes: false`) we back up ONLY
 * /metadata — a config-only snapshot. Passing `/volumes/` in that case would make
 * restic exit 3 ("path does not exist") since no volume is mounted; omitting it
 * gives a clean exit 0 metadata-only snapshot.
 */
export function buildBackupArgs(input: {
	host: string;
	tags: string[];
	hasVolumes: boolean;
	excludePatterns?: string[];
	excludeCaches?: boolean;
	compression?: string;
	limitUpload?: number;
	limitDownload?: number;
	swapArtifacts: readonly string[];
}): string[] {
	const paths = input.hasVolumes ? ['/volumes/', '/metadata/'] : ['/metadata/'];
	const args = ['backup', '--json', '--retry-lock', '5m', '--host', input.host, ...paths];
	for (const t of input.tags) args.push('--tag', t);
	for (const a of input.swapArtifacts) args.push('--exclude', a);
	for (const p of input.excludePatterns ?? []) if (p.trim()) args.push('--exclude', p.trim());
	if (input.excludeCaches !== false) args.push('--exclude-caches');
	if (input.compression) args.push('--compression', input.compression);
	if (input.limitUpload) args.push('--limit-upload', String(input.limitUpload));
	if (input.limitDownload) args.push('--limit-download', String(input.limitDownload));
	return args;
}
