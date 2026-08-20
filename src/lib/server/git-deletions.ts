/**
 * Git stack deletion sync (#966, #1162) and adopted/internal Hawser dir sync.
 *
 * Propagates file deletions to the stack deploy directory using a per-stack
 * manifest: a file is deleted ONLY when the manifest of files Dockhand wrote
 * on the previous sync lists it, the new payload/clone no longer contains it,
 * AND the bytes on disk still match what Dockhand wrote (nobody modified it
 * locally).
 *
 * Every failure mode degrades to "delete less" — never to user-data loss:
 * - user-created files (volume data) → never in the manifest → untouchable
 * - locally modified files → hash mismatch → skip
 * - first sync after upgrade / fresh DB → empty manifest → nothing to delete
 * - broken clone walk (empty / compose missing) → deletionSafetyCheck blocks
 *   ALL deletions for that sync (guards against mass-deleting managed files
 *   due to a Dockhand bug; those files are repo-restorable anyway)
 *
 * History rewrites are irrelevant by design: deletion converges the deploy
 * dir toward the clone state, regardless of how the commits got there.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync, rmdirSync, lstatSync } from 'node:fs';
import { join, resolve, sep, dirname, basename, isAbsolute } from 'node:path';

// =============================================================================
// Types
// =============================================================================

export type DeletionSkipReason =
	| 'locally-modified' // disk bytes differ from what Dockhand wrote
	| 'load-bearing' // compose/.env files are never auto-deleted
	| 'invalid-path' // absolute or escaping the stack directory
	| 'already-absent' // nothing to do (benign)
	| 'agent-no-support' // Hawser agent too old to apply deletions
	| 'apply-failed'; // unexpected error during unlink

export interface FileToDelete {
	path: string; // relative to the stack deploy dir, '/' separators
	hash: string; // sha256 hex of the content Dockhand wrote
}

export interface DeletionSkip {
	path: string;
	reason: DeletionSkipReason;
}

export interface DeletionPlan {
	toDelete: FileToDelete[];
	skipped: DeletionSkip[];
}

export interface DeletionApplyResult {
	deleted: string[];
	skipped: DeletionSkip[];
}

/** Manifest of files Dockhand wrote on the last successful sync. */
export interface SyncManifest {
	/** Full commit hash the manifest files were taken from. Null = legacy/bootstrap. */
	commit: string | null;
	/** relative path → sha256 hex of written content */
	files: Record<string, string>;
}

export interface SyncFileChange {
	file: string;
	status: 'added' | 'updated' | 'removed' | 'skipped';
	reason?: string; // human-readable, only for skipped
}

export interface SyncChangeSummary {
	changes: SyncFileChange[];
	unchangedCount: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Files that are never auto-deleted, regardless of what the sources say. */
export const LOAD_BEARING_FILES = new Set([
	'docker-compose.yml',
	'docker-compose.yaml',
	'compose.yml',
	'compose.yaml',
	'.env'
]);

// NOTE: deletion skips are FINAL by design. A deletion is attempted exactly
// once — at the sync where the file first disappears from the clone. Any
// skip (old agent, hash mismatch, apply error) is logged and the file simply
// stays on disk as unmanaged residue. There is deliberately no
// carry-forward/retry state: it would require tracking per-file retry status
// indefinitely (e.g. waiting for an agent upgrade that may never happen).
// Worst case is always "a stale file survives" — visible in the logs,
// recoverable manually. With an old Hawser agent the behavior is identical
// to before this feature existed: nothing is ever deleted remotely.

/** Human-readable explanation for each skip reason (shown in logs and activity). */
export function skipReasonMessage(reason: DeletionSkipReason): string {
	switch (reason) {
		case 'locally-modified':
			return 'deleted from the repository, but the file was modified on this machine since Dockhand deployed it — refusing to delete local changes';
		case 'load-bearing':
			return 'core stack file — never auto-deleted';
		case 'invalid-path':
			return 'invalid path outside the stack directory — ignored';
		case 'already-absent':
			return 'already absent';
		case 'agent-no-support':
			return 'the Hawser agent does not support file deletion sync — file left on the remote host (upgrade the agent to enable cleanup of future deletions)';
		case 'apply-failed':
			return 'could not be deleted — leaving the file in place';
		default:
			// Unknown reason (e.g., from a newer agent)
			return 'could not be deleted — leaving the file in place';
	}
}

const KNOWN_SKIP_REASONS: ReadonlySet<string> = new Set<DeletionSkipReason>([
	'locally-modified',
	'load-bearing',
	'invalid-path',
	'already-absent',
	'agent-no-support',
	'apply-failed'
]);

/** Normalize a reason string from an external source (Hawser agent). */
export function normalizeSkipReason(reason: string): DeletionSkipReason {
	return (KNOWN_SKIP_REASONS.has(reason) ? reason : 'apply-failed') as DeletionSkipReason;
}

// =============================================================================
// Manifest (de)serialization
// =============================================================================

export function parseManifest(raw: string | null | undefined): SyncManifest {
	if (!raw) return { commit: null, files: {} };
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && typeof parsed.files === 'object' && parsed.files !== null) {
			const files: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed.files)) {
				if (typeof v === 'string') files[k] = v;
			}
			return { commit: typeof parsed.commit === 'string' ? parsed.commit : null, files };
		}
	} catch {
		// Corrupt manifest → behave like a fresh bootstrap (fail closed: no deletions)
	}
	return { commit: null, files: {} };
}

export function serializeManifest(manifest: SyncManifest): string {
	return JSON.stringify(manifest);
}

// =============================================================================
// Hashing
// =============================================================================

export function hashContent(content: Buffer | string): string {
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Hash a Hawser `files` payload the same way the agent writes it to disk:
 * `base64:` values hash over their decoded bytes; everything else hashes over
 * the UTF-8 bytes of the string content the agent writes. Used by
 * adopted/internal stack dir sync so deletion hashes match remote bytes.
 */
export function hashShippedFiles(files: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [path, content] of Object.entries(files)) {
		if (content.startsWith('base64:')) {
			result[path] = hashContent(Buffer.from(content.slice('base64:'.length), 'base64'));
		} else {
			result[path] = hashContent(content);
		}
	}
	return result;
}

/**
 * Walk a directory and hash every regular file (raw bytes).
 * Returns { relativePath: sha256hex } with '/' separators.
 * Skips .git directories (mirrors the cpSync filter used by the deploy copy).
 */
export function hashDirFiles(dir: string): Record<string, string> {
	const result: Record<string, string> = {};
	const root = resolve(dir);

	const walk = (current: string, relPrefix: string) => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === '.git') continue;
			const abs = join(current, entry.name);
			const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(abs, rel);
			} else if (entry.isFile()) {
				try {
					result[rel] = hashContent(readFileSync(abs));
				} catch {
					// Unreadable file: leave out of the manifest → never a deletion candidate
				}
			}
			// Symlinks and other special entries are intentionally excluded:
			// Dockhand only writes regular files, so only regular files are managed.
		}
	};

	walk(root, '');
	return result;
}

// =============================================================================
// Path safety
// =============================================================================

/** A relative path is safe when it cannot escape the stack directory. */
export function isSafeRelPath(p: string): boolean {
	if (!p || isAbsolute(p) || p.includes('\\')) return false;
	const segments = p.split('/');
	return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Resolve relPath inside root; returns null when it would escape root. */
export function containedPath(root: string, relPath: string): string | null {
	if (!isSafeRelPath(relPath)) return null;
	const abs = resolve(root, relPath);
	if (abs !== root && abs.startsWith(root + sep)) return abs;
	return null;
}

// =============================================================================
// Core: manifest vs clone
// =============================================================================

/**
 * Sanity guard run BEFORE computing any deletions: when the new-clone walk
 * looks broken (no files at all, or the compose file itself is missing from
 * the walk even though it was just read from that tree), every manifest
 * entry would become a deletion candidate — a Dockhand bug, not a repo
 * change. Returns a human-readable reason to skip ALL deletions this sync,
 * or null when it is safe to proceed.
 */
export function deletionSafetyCheck(
	manifestFiles: Record<string, string>,
	newFiles: Record<string, string>,
	composeFileName: string | undefined
): string | null {
	if (Object.keys(manifestFiles).length === 0) return null; // nothing to delete anyway

	if (Object.keys(newFiles).length === 0) {
		return 'the new clone appears empty — skipping all deletions this sync (likely a sync problem, not repository changes)';
	}
	if (composeFileName && !(composeFileName in newFiles)) {
		return `the compose file "${composeFileName}" is missing from the new clone walk — skipping all deletions this sync (likely a sync problem, not repository changes)`;
	}
	return null;
}

/**
 * Compute the deletion plan: manifest entries that are absent from the new
 * clone. The hash recorded in the manifest travels with each entry — the
 * applier deletes only files whose disk bytes still match it.
 *
 * @param manifestFiles files Dockhand wrote on the last sync (path → hash)
 * @param newFiles files in the new clone that will be written (path → hash)
 */
export function computeDeletions(
	manifestFiles: Record<string, string>,
	newFiles: Record<string, string>
): DeletionPlan {
	const toDelete: FileToDelete[] = [];
	const skipped: DeletionSkip[] = [];

	for (const [path, hash] of Object.entries(manifestFiles)) {
		if (path in newFiles) continue; // still present in the repo

		if (!isSafeRelPath(path)) {
			skipped.push({ path, reason: 'invalid-path' });
			continue;
		}
		if (LOAD_BEARING_FILES.has(basename(path))) {
			skipped.push({ path, reason: 'load-bearing' });
			continue;
		}
		toDelete.push({ path, hash });
	}

	return { toDelete, skipped };
}

// =============================================================================
// Applier — the single chokepoint that touches the filesystem
// =============================================================================

/**
 * Apply a deletion list inside a stack directory.
 *
 * Structurally incapable of touching anything outside stackDir:
 * every path is containment-checked, only regular files whose content still
 * matches the recorded hash are unlinked, and directory cleanup uses rmdir
 * (never recursive) so directories holding any other content survive.
 */
export function applyFileDeletions(stackDir: string, files: FileToDelete[]): DeletionApplyResult {
	const root = resolve(stackDir);
	const deleted: string[] = [];
	const skipped: DeletionSkip[] = [];
	const parentDirs = new Set<string>();

	for (const { path, hash } of files) {
		const abs = containedPath(root, path);
		if (!abs) {
			skipped.push({ path, reason: 'invalid-path' });
			continue;
		}

		// Defense in depth: computeDeletions already filters these, but the
		// applier also runs on lists from external sources (Hawser payloads).
		if (LOAD_BEARING_FILES.has(basename(path))) {
			skipped.push({ path, reason: 'load-bearing' });
			continue;
		}

		let stat;
		try {
			stat = lstatSync(abs);
		} catch {
			skipped.push({ path, reason: 'already-absent' });
			continue;
		}

		// Dockhand only writes regular files. Anything else (symlink, dir,
		// socket) means the user replaced it — treat as locally modified.
		if (!stat.isFile()) {
			skipped.push({ path, reason: 'locally-modified' });
			continue;
		}

		try {
			if (hashContent(readFileSync(abs)) !== hash) {
				skipped.push({ path, reason: 'locally-modified' });
				continue;
			}
			unlinkSync(abs);
			deleted.push(path);
		} catch {
			skipped.push({ path, reason: 'apply-failed' });
			continue;
		}

		// Collect parent dir chain (inside root) for empty-dir cleanup
		let dir = dirname(abs);
		while (dir !== root && dir.startsWith(root + sep)) {
			parentDirs.add(dir);
			dir = dirname(dir);
		}
	}

	// Deepest-first rmdir; fails harmlessly when a directory still has content
	const dirsByDepth = [...parentDirs].sort((a, b) => b.length - a.length);
	for (const dir of dirsByDepth) {
		try {
			rmdirSync(dir);
		} catch {
			// ENOTEMPTY/ENOENT/etc. — directory stays, which is always safe
		}
	}

	return { deleted, skipped };
}

// =============================================================================
// Manifest evolution
// =============================================================================

/**
 * Build the manifest to persist after a sync.
 *
 * Trivial by design: the manifest is always exactly the files written this
 * sync, at this sync's commit. Skipped deletions are FINAL (see note above) —
 * the affected files drop out of the manifest and become unmanaged residue.
 */
export function buildNextManifest(newCommit: string, newFiles: Record<string, string>): SyncManifest {
	return { commit: newCommit, files: { ...newFiles } };
}

// =============================================================================
// Sync summary (per-file status table)
// =============================================================================

export function buildSyncChangeSummary(
	previousFiles: Record<string, string>,
	newFiles: Record<string, string>,
	applyResult: DeletionApplyResult,
	planSkipped: DeletionSkip[]
): SyncChangeSummary {
	const changes: SyncFileChange[] = [];
	let unchangedCount = 0;

	for (const [path, hash] of Object.entries(newFiles)) {
		const oldHash = previousFiles[path];
		if (oldHash === undefined) {
			changes.push({ file: path, status: 'added' });
		} else if (oldHash !== hash) {
			changes.push({ file: path, status: 'updated' });
		} else {
			unchangedCount++;
		}
	}

	for (const path of applyResult.deleted) {
		changes.push({ file: path, status: 'removed' });
	}

	// Benign "already absent" results are not interesting in the summary
	const interestingSkips = [...planSkipped, ...applyResult.skipped].filter(
		(s) => s.reason !== 'already-absent'
	);
	for (const skip of interestingSkips) {
		changes.push({ file: skip.path, status: 'skipped', reason: skipReasonMessage(skip.reason) });
	}

	return { changes, unchangedCount };
}

/** Render the summary as aligned text lines for console and job output. */
export function formatChangeTable(summary: SyncChangeSummary): string[] {
	const { changes, unchangedCount } = summary;
	const counts = { added: 0, updated: 0, removed: 0, skipped: 0 };
	for (const c of changes) counts[c.status]++;

	const header = `${counts.added} added, ${counts.updated} updated, ${counts.removed} removed, ${counts.skipped} skipped, ${unchangedCount} unchanged`;
	if (changes.length === 0) {
		return [header];
	}

	const fileWidth = Math.min(60, Math.max(4, ...changes.map((c) => c.file.length)));
	const lines = [header, `${'STATUS'.padEnd(9)} ${'FILE'.padEnd(fileWidth)} REASON`];
	for (const c of changes) {
		lines.push(`${c.status.padEnd(9)} ${c.file.padEnd(fileWidth)} ${c.reason ?? ''}`.trimEnd());
	}
	return lines;
}
