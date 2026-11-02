// Pure directory-to-payload scanner for stack files, split out of stacks.ts so it
// loads under the bun unit runner (stacks.ts drags in ./db -> better-sqlite3). This
// is what pins the exec-bit mode-capture plumbing in tests/stack-files-core.test.ts.
import { readdirSync, statSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { stackFileExecMode } from './stack-file-mode';

// Content is binary when it is not valid UTF-8 text.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
function isBinaryContent(bytes: Uint8Array): boolean {
	try {
		utf8Decoder.decode(bytes);
		return false;
	} catch {
		return true;
	}
}

// Total payload cap. There is no per-file cap: a single large file is fine, only the
// SUM matters, because the whole map is JSON-serialized into one string before it reaches
// the agent. That string has a hard V8 ceiling (~512 MiB), and building the map plus the
// string holds the payload in memory twice, so 256 MB keeps the peak well under the heap
// limit (measured ~1.1 GB RSS at 256 MB). Larger repos need the chunked transport, not a
// bigger number here. Binary files are base64 (+33%), so they count 1.33x toward this.
// Exceeding it FAILS the scan (StackPayloadTooLargeError): sending a partial tree would be
// the same silent half-deploy this guard exists to prevent.
const MAX_TOTAL_SIZE = 256 * 1024 * 1024;

/** Thrown when the stack's files sum past the transfer cap. The caller fails the deploy. */
export class StackPayloadTooLargeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StackPayloadTooLargeError';
	}
}

/**
 * Stack-dir files plus a sparse exec-bit mode map, both keyed by relative path.
 * `skipped` names files that CANNOT travel the path->content protocol (symlinks), with a
 * reason, so a deploy can surface them rather than let them vanish unremarked. An oversize
 * stack is not here: it throws StackPayloadTooLargeError instead of partially deploying.
 */
export interface StackFilesPayload {
	files: Record<string, string>;
	modes: Record<string, number>;
	skipped: string[];
}

/**
 * Read all files from a directory as a map of relative path -> content.
 * Used to send files to Hawser for remote deployments.
 * Binary files are base64-encoded with a "base64:" prefix to preserve all bytes.
 * `maxTotalBytes` is the total payload cap; it exists as a parameter only so the budget
 * accounting can be tested at a small scale (the production caller always uses the default).
 */
export async function readDirFilesAsMap(dirPath: string, maxTotalBytes: number = MAX_TOTAL_SIZE): Promise<StackFilesPayload> {
	const files: Record<string, string> = {};
	// Only executable files get an entry; git tracks a file as 100644 or 100755,
	// so the exec bit is the only mode a stack checkout can carry. A sparse map
	// keeps the payload small and an old agent ignores the field (see fileModes).
	const modes: Record<string, number> = {};
	let totalSize = 0;
	const skipped: string[] = [];

	/** Read one regular file into the map; fail the whole scan if it busts the total cap. */
	async function readOneFile(fullPath: string, relPath: string, _fileSize: number, mode: number): Promise<void> {
		const bytes = readFileSync(fullPath);
		// Budget against the STORED string length, not the raw byte count: a binary file is
		// base64 (~1.33x), and the cap protects the JSON string the whole map serializes to.
		const value = isBinaryContent(bytes) ? `base64:${bytes.toString('base64')}` : new TextDecoder().decode(bytes);
		if (totalSize + value.length > maxTotalBytes) {
			throw new StackPayloadTooLargeError(
				`Stack is too large to deploy to a remote agent: it exceeds the ${maxTotalBytes / 1024 / 1024} MB transfer limit ` +
				`(reached at ${relPath}). Reduce the stack size or exclude large files from the stack directory.`
			);
		}
		totalSize += value.length;
		files[relPath] = value;
		const execMode = stackFileExecMode(mode);
		if (execMode !== undefined) modes[relPath] = execMode;
	}

	async function scanDir(currentPath: string, relativePath: string = ''): Promise<void> {
		const entries = readdirSync(currentPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentPath, entry.name);
			const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

			// A symlink is neither isDirectory() nor isFile() to withFileTypes, so without
			// this it would match no branch and vanish from the payload unremarked. The
			// protocol carries path -> content and cannot express a link, so the link is
			// not sent; it is named instead, because a file the agent never receives has
			// to be visible to whoever wonders where it went.
			if (entry.isSymbolicLink()) {
				let target = '?';
				try { target = readlinkSync(fullPath); } catch { /* keep the placeholder */ }
				skipped.push(`${relPath} -> ${target} (symlink; only regular files are sent)`);
				continue;
			}

			if (entry.isDirectory()) {
				// Skip .git directory
				if (entry.name === '.git') continue;
				await scanDir(fullPath, relPath);
			} else if (entry.isFile()) {
				const st = statSync(fullPath);
				await readOneFile(fullPath, relPath, st.size, st.mode);
			}
		}
	}

	await scanDir(dirPath);

	if (skipped.length > 0) {
		console.log(`[readDirFilesAsMap] Skipped ${skipped.length} file(s) not sent to the agent: ${skipped.join(', ')}`);
	}

	return { files, modes, skipped };
}

/**
 * Emit each skipped-file entry as a deploy-log WARNING via `forward`. A skipped file (a
 * symlink the path->content protocol cannot carry) would otherwise vanish silently and the
 * deploy would read as successful. `forward` is undefined when there is no deploy-log
 * consumer, in which case nothing is emitted (the entries still reach the server console log).
 */
export function reportSkippedStackFiles(skipped: string[] | undefined, forward: ((line: string) => void) | undefined): void {
	if (!forward || !skipped || skipped.length === 0) return;
	for (const entry of skipped) {
		forward(`WARNING: not sent to the remote host: ${entry}`);
	}
}
