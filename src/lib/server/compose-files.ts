import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { isAllowedStackFilename } from './stack-filename';

const STANDARD_OVERRIDE_MAP: Record<string, string[]> = {
	'compose.yaml': ['compose.override.yml', 'compose.override.yaml'],
	'compose.yml': ['compose.override.yml', 'compose.override.yaml'],
	'docker-compose.yaml': ['docker-compose.override.yml', 'docker-compose.override.yaml'],
	'docker-compose.yml': ['docker-compose.override.yml', 'docker-compose.override.yaml'],
};

export interface ResolvedComposeFile {
	path: string;
	role: 'primary' | 'additional' | 'override';
	source: 'user' | 'auto';
}

export interface ResolveComposeFilesInput {
	composePaths?: string[] | null;
	composePath?: string | null;
	composePathSource?: 'user' | 'auto';
	diskExists?: (path: string) => boolean;
}

function discoverOverrideCandidates(baseFileName: string): string[] {
	return STANDARD_OVERRIDE_MAP[baseFileName] ?? [];
}

export function parseComposePathsColumn(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
			return parsed as string[];
		}
	} catch {
		return [];
	}
	return [];
}

export function resolveEffectiveComposeFiles(input: ResolveComposeFilesInput): ResolvedComposeFile[] {
	const { composePaths, composePath, composePathSource = 'user', diskExists } = input;
	const hasExplicitPathList = Array.isArray(composePaths) && composePaths.length > 0;

	const basePaths = composePaths && composePaths.length > 0
		? composePaths
		: composePath
			? [composePath]
			: [];

	if (basePaths.length === 0) return [];

	const existsFn = diskExists ?? ((p: string) => existsSync(p));

	// Explicit user paths come first, in the given order (last file wins in
	// Compose merging), deduplicated.
	const resolved: ResolvedComposeFile[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < basePaths.length; i++) {
		const path = basePaths[i];
		if (seen.has(path)) continue;
		seen.add(path);
		resolved.push({
			path,
			role: i === 0 ? 'primary' : 'additional',
			source: hasExplicitPathList ? 'user' : composePathSource
		});
	}

	// Then append implicit overrides — but ONLY for a single configured file.
	// Explicit `docker compose -f a -f b` never auto-loads compose.override.yaml,
	// and appending the override after later explicit files would hand IT the
	// last-file-wins precedence instead of the file the user picked.
	if (!hasExplicitPathList && basePaths.length === 1) {
		const path = basePaths[0];
		const baseName = basename(path);
		const baseDir = dirname(path);
		for (const candidate of discoverOverrideCandidates(baseName)) {
			const fullPath = join(baseDir, candidate);
			if (!existsFn(fullPath) || seen.has(fullPath)) continue;
			seen.add(fullPath);
			resolved.push({ path: fullPath, role: 'override', source: 'auto' });
			break;
		}
	}

	return resolved;
}

export function composeFilePathList(files: ResolvedComposeFile[]): string[] {
	return files.map((f) => f.path);
}

export function composeSiblingRelPath(composePath: string | undefined, siblingName: string): string {
	return composePath ? join(dirname(composePath), siblingName).split('\\').join('/') : siblingName;
}

/**
 * Pick the additional (non-primary) compose file contents from a submitted
 * composePaths/composeContents pair, in order. Used by the validation routes so
 * they lint/inspect exactly the merged set deploy will use. Unvalidated request
 * input: entries that are not non-empty path strings or whose content is not a
 * non-empty string are skipped.
 */
export function pickAdditionalComposeContents(composePaths: unknown, composeContents: unknown): string[] {
	if (!Array.isArray(composePaths) || composePaths.length < 2) return [];
	if (typeof composeContents !== 'object' || composeContents === null) return [];
	const contents = composeContents as Record<string, unknown>;
	const out: string[] = [];
	for (const p of composePaths.slice(1)) {
		if (typeof p !== 'string' || !p.trim()) continue;
		const c = contents[p];
		if (typeof c === 'string' && c.trim()) out.push(c);
	}
	return out;
}

/**
 * Validate a request-supplied composePaths value. Accepted: undefined/null or
 * an array of non-empty path strings. Every entry gets the same gate as the
 * primary compose path (no `..` traversal, stack-shaped filename) — additional
 * paths are read verbatim by getStackComposeFile, so an unvalidated entry
 * would let a stacks:edit user read arbitrary server files (e.g. /etc/passwd)
 * through the compose GET endpoint. Returns an error message, or null when valid.
 */
export function validateComposePathsInput(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) return 'composePaths must be an array of path strings';
	if (!value.every((p) => typeof p === 'string' && p.trim().length > 0)) {
		return 'composePaths must contain only non-empty path strings';
	}
	for (const p of value as string[]) {
		if (p.split(/[\\/]/).includes('..')) {
			return `Path traversal not allowed in compose path "${p}"`;
		}
		const filename = basename(p);
		if (!isAllowedStackFilename(filename)) {
			return `File "${filename}" is not an allowed stack filename (must end in .yml, .yaml, or .env)`;
		}
	}
	return null;
}

/**
 * Validate a request-supplied composeContents value. Accepted: undefined/null
 * or an object mapping non-empty path strings to string content. Returns an
 * error message, or null when valid.
 */
export function validateComposeContentsInput(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) {
		return 'composeContents must be an object mapping file paths to content';
	}
	for (const [key, content] of Object.entries(value)) {
		if (!key.trim() || typeof content !== 'string') {
			return 'composeContents must map non-empty file paths to string content';
		}
	}
	return null;
}

/**
 * Return the first configured compose path that does not reside under
 * `baseDir` (a repo-relative directory, '' = repo root), or null when all are
 * contained. Git deploys only watch and copy that directory, so an additional
 * file outside it could never be synced, copied, or rebased onto the
 * deployment directory.
 */
export function firstComposePathOutsideDir(
	composePaths: string[] | null | undefined,
	baseDir: string
): string | null {
	if (!composePaths || composePaths.length === 0) return null;
	const base = baseDir || '.';
	for (const p of composePaths) {
		const rel = relative(base, p);
		if (!rel || rel.startsWith('..') || isAbsolute(rel)) return p;
	}
	return null;
}

/** Filenames Docker Compose auto-discovers when no `-f` is passed. */
const STANDARD_COMPOSE_BASENAMES = new Set([
	'compose.yaml',
	'compose.yml',
	'docker-compose.yaml',
	'docker-compose.yml'
]);

/**
 * Whether to pass explicit `-f` flags to `docker compose`.
 *
 * Omit `-f` only for a single standard compose filename Dockhand itself
 * auto-detected. User-selected paths always use `-f`, even when their basename
 * is standard, so Compose cannot silently choose a sibling file instead.
 */
export function shouldUseExplicitFFlags(files: ResolvedComposeFile[]): boolean {
	if (files.length === 0) return false;
	if (files.length > 1) return true;
	return files[0].source !== 'auto' || !STANDARD_COMPOSE_BASENAMES.has(basename(files[0].path));
}
