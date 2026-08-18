import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const STANDARD_OVERRIDE_MAP: Record<string, string[]> = {
	'compose.yaml': ['compose.override.yaml', 'compose.override.yml'],
	'compose.yml': ['compose.override.yaml', 'compose.override.yml'],
	'docker-compose.yaml': ['docker-compose.override.yaml', 'docker-compose.override.yml'],
	'docker-compose.yml': ['docker-compose.override.yaml', 'docker-compose.override.yml'],
};

export interface ResolvedComposeFile {
	path: string;
	role: 'primary' | 'additional' | 'override';
	source: 'user' | 'auto';
}

export interface ResolveComposeFilesInput {
	composePaths?: string[] | null;
	composePath?: string | null;
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
	const { composePaths, composePath, diskExists } = input;

	const basePaths = composePaths && composePaths.length > 0
		? composePaths
		: composePath
			? [composePath]
			: [];

	if (basePaths.length === 0) return [];

	const existsFn = diskExists ?? ((p: string) => existsSync(p));

	const allFilePaths: ResolvedComposeFile[] = [];

	for (let i = 0; i < basePaths.length; i++) {
		const path = basePaths[i];
		const role = i === 0 ? 'primary' : 'additional';
		const source = 'user';

		const alreadyIncluded = allFilePaths.some((f) => f.path === path);
		if (!alreadyIncluded) {
			allFilePaths.push({ path, role, source });
		} else {
			const existingIndex = allFilePaths.findIndex((f) => f.path === path);
			const existing = allFilePaths[existingIndex];
			// User explicitly listed a path that was auto-discovered as an override.
			if (existing.source === 'auto') {
				allFilePaths[existingIndex] = { path, role, source };
			}
		}

		const baseName = basename(path);
		const baseDir = dirname(path);
		const candidates = discoverOverrideCandidates(baseName);

		for (const candidate of candidates) {
			const fullPath = join(baseDir, candidate);
			if (existsFn(fullPath)) {
				const alreadyIncluded = allFilePaths.some((f) => f.path === fullPath);
				if (!alreadyIncluded) {
					allFilePaths.push({ path: fullPath, role: 'override', source: 'auto' });
				}
			}
		}
	}

	return allFilePaths;
}

export function composeFilePathList(files: ResolvedComposeFile[]): string[] {
	return files.map((f) => f.path);
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
 * Omit `-f` only for a single standard compose filename so Compose can
 * auto-discover it (and any matching override) from cwd. Any non-standard
 * name (e.g. `immich.yaml`, `docker-compose.prod.yml`) or multi-file set
 * must use `-f`, otherwise Compose reports "no configuration file provided".
 */
export function shouldUseExplicitFFlags(files: ResolvedComposeFile[]): boolean {
	if (files.length === 0) return false;
	if (files.length > 1) return true;
	return !STANDARD_COMPOSE_BASENAMES.has(basename(files[0].path));
}
