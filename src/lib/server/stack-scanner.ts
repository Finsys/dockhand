/**
 * Stack Scanner Service
 *
 * Scans external filesystem paths for Docker Compose files and adopts them as stacks.
 * Discovered stacks are editable - compose and .env files are modified in their original location.
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { getExternalStackPaths, getStackSources, upsertStackSource, type StackSourceType } from './db';

// Compose file patterns to detect (in order of priority - prefer new style first)
const COMPOSE_PATTERNS = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

// Directories to skip during scanning
const SKIP_DIRECTORIES = ['.git', 'node_modules', '.docker', '__pycache__', '.venv', 'venv'];

// Maximum recursion depth to prevent runaway scanning
const MAX_DEPTH = 5;

export interface RunningStackInfo {
	envId: number;
	envName: string;
	containerCount: number;
}

export interface DiscoveredStack {
	name: string;
	composePath: string;
	envPath: string | null;
	sourceDir: string;
	serviceCount?: number; // Number of services defined in compose file
	runningOn?: RunningStackInfo[];
}

export interface ScanResult {
	discovered: DiscoveredStack[];
	adopted: string[];
	skipped: DiscoveredStack[];
	errors: { path: string; error: string }[];
}

/**
 * Normalize a stack name to be valid (lowercase alphanumeric with hyphens/underscores)
 */
export function normalizeStackName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/**
 * Check if a file looks like a compose file (contains 'services:' key)
 */
async function isComposeFile(filePath: string): Promise<boolean> {
	try {
		const file = Bun.file(filePath);
		const content = await file.text();
		// Basic check for services key - could be more sophisticated
		return /^services:/m.test(content) || /\nservices:/m.test(content);
	} catch {
		return false;
	}
}

/**
 * Count the number of services defined in a compose file
 * Parses YAML to reliably count top-level keys under 'services:' section
 */
async function countServices(filePath: string): Promise<number> {
	try {
		const file = Bun.file(filePath);
		const content = await file.text();
		const doc = yaml.load(content) as Record<string, unknown> | null;
		if (doc?.services && typeof doc.services === 'object') {
			return Object.keys(doc.services).length;
		}
		return 0;
	} catch {
		return 0;
	}
}

/**
 * Scan a single directory path for compose files
 */
async function scanPath(basePath: string): Promise<{ stacks: DiscoveredStack[]; errors: { path: string; error: string }[] }> {
	const discovered: DiscoveredStack[] = [];
	const errors: { path: string; error: string }[] = [];

	// Resolve to absolute path
	const absolutePath = resolve(basePath);

	// Verify path exists and is a directory
	if (!existsSync(absolutePath)) {
		errors.push({ path: basePath, error: 'Path does not exist' });
		return { stacks: discovered, errors };
	}

	try {
		const stat = statSync(absolutePath);
		if (!stat.isDirectory()) {
			errors.push({ path: basePath, error: 'Path is not a directory' });
			return { stacks: discovered, errors };
		}
	} catch (err) {
		errors.push({ path: basePath, error: 'Cannot access path' });
		return { stacks: discovered, errors };
	}

	// Track which directories we've found compose files in (to avoid duplicate scanning)
	const foundStackDirs = new Set<string>();

	async function scan(currentPath: string, depth: number = 0): Promise<void> {
		// Limit depth to prevent runaway scanning
		if (depth > MAX_DEPTH) return;

		let entries;
		try {
			entries = readdirSync(currentPath, { withFileTypes: true });
		} catch (err) {
			// Skip inaccessible directories
			return;
		}

		// First pass: check for compose files in this directory
		for (const pattern of COMPOSE_PATTERNS) {
			const composePath = join(currentPath, pattern);
			if (existsSync(composePath)) {
				// Found a stack! Stack name = directory name
				const stackName = normalizeStackName(basename(currentPath));
				if (stackName) {
					// Check for .env file
					const envPath = join(currentPath, '.env');
					// Count services in compose file
					const serviceCount = await countServices(composePath);
					discovered.push({
						name: stackName,
						composePath,
						envPath: existsSync(envPath) ? envPath : null,
						sourceDir: currentPath,
						serviceCount
					});
					foundStackDirs.add(currentPath);
				}
				// Don't continue scanning in this directory - it's a stack
				return;
			}
		}

		// Second pass: check for standalone compose files (*.yml, *.yaml) and recurse into subdirectories
		for (const entry of entries) {
			const entryPath = join(currentPath, entry.name);

			if (entry.isDirectory()) {
				// Skip excluded directories
				if (SKIP_DIRECTORIES.includes(entry.name)) continue;

				// Skip if we already found a compose file here
				if (foundStackDirs.has(entryPath)) continue;

				// Recurse into subdirectory
				await scan(entryPath, depth + 1);
			} else if (entry.isFile()) {
				const lowerName = entry.name.toLowerCase();

				// Skip standard compose patterns (already handled above)
				if (COMPOSE_PATTERNS.includes(entry.name)) continue;

				// Check for standalone compose files (e.g., myapp.yml, myapp.yaml)
				if (lowerName.endsWith('.yml') || lowerName.endsWith('.yaml')) {
					// Validate it's actually a compose file
					if (await isComposeFile(entryPath)) {
						const stackName = normalizeStackName(
							entry.name.replace(/\.(yml|yaml)$/i, '')
						);
						if (stackName) {
							// Check for .env file in same directory
							const envPath = join(currentPath, '.env');
							// Count services in compose file
							const serviceCount = await countServices(entryPath);
							discovered.push({
								name: stackName,
								composePath: entryPath,
								envPath: existsSync(envPath) ? envPath : null,
								sourceDir: currentPath,
								serviceCount
							});
						}
					}
				}
			}
		}
	}

	await scan(absolutePath);
	return { stacks: discovered, errors };
}

/**
 * Adopt a single stack into the database
 * - Checks if stack already exists (by composePath)
 * - Creates stackSource record with sourceType: 'internal'
 * - Does NOT deploy - just registers the stack
 */
export async function adoptStack(
	stack: DiscoveredStack,
	environmentId: number
): Promise<{ success: boolean; adoptedName?: string; error?: string }> {
	// Get all existing stack sources to check for duplicates
	const existingSources = await getStackSources();

	// Check if already adopted (by composePath within the same environment)
	const alreadyAdopted = existingSources.some(
		(s) => s.composePath === stack.composePath && s.environmentId === environmentId
	);

	if (alreadyAdopted) {
		return { success: false, error: 'Already adopted' };
	}

	// Check for name conflict within the same environment
	let finalName = normalizeStackName(stack.name);
	const existingNames = new Set(
		existingSources
			.filter((s) => s.environmentId === environmentId)
			.map((s) => s.stackName)
	);

	if (existingNames.has(finalName)) {
		// Append suffix to make unique
		let suffix = 1;
		while (existingNames.has(`${stack.name}-${suffix}`)) {
			suffix++;
		}
		finalName = `${stack.name}-${suffix}`;
	}

	// Create stack source record - use 'internal' since we know the file paths
	try {
		await upsertStackSource({
			stackName: finalName,
			environmentId,
			sourceType: 'internal' as StackSourceType,
			composePath: stack.composePath,
			envPath: stack.envPath
		});

		return { success: true, adoptedName: finalName };
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`[Stack Scanner] Failed to adopt ${stack.name}:`, errorMsg);
		return { success: false, error: errorMsg };
	}
}

/**
 * Adopt multiple selected stacks into the database
 */
export async function adoptSelectedStacks(
	stacks: DiscoveredStack[],
	environmentId: number
): Promise<{ adopted: string[]; failed: { name: string; error: string }[] }> {
	const adopted: string[] = [];
	const failed: { name: string; error: string }[] = [];

	for (const stack of stacks) {
		const result = await adoptStack(stack, environmentId);
		if (result.success && result.adoptedName) {
			adopted.push(result.adoptedName);
		} else {
			failed.push({ name: stack.name, error: result.error || 'Unknown error' });
		}
	}

	return { adopted, failed };
}

/**
 * Scan specific paths and return discovered stacks (without adopting)
 */
export async function scanPaths(paths: string[]): Promise<ScanResult> {
	if (paths.length === 0) {
		return { discovered: [], adopted: [], skipped: [], errors: [] };
	}

	console.log(`[Stack Scanner] Scanning ${paths.length} path(s)...`);

	const allDiscovered: DiscoveredStack[] = [];
	const allErrors: { path: string; error: string }[] = [];

	// Scan all paths
	for (const path of paths) {
		const { stacks, errors } = await scanPath(path);
		allDiscovered.push(...stacks);
		allErrors.push(...errors);
	}

	console.log(`[Stack Scanner] Found ${allDiscovered.length} compose file(s)`);

	// Check which stacks are already adopted
	const existingSources = await getStackSources();
	const alreadyAdopted: DiscoveredStack[] = [];
	const newStacks: DiscoveredStack[] = [];

	for (const stack of allDiscovered) {
		const isAdopted = existingSources.some(s => s.composePath === stack.composePath);
		if (isAdopted) {
			alreadyAdopted.push(stack);
		} else {
			newStacks.push(stack);
		}
	}

	return {
		discovered: newStacks,
		adopted: [],
		skipped: alreadyAdopted,
		errors: allErrors
	};
}

/**
 * Scan all configured external paths and return discovered stacks (without adopting)
 */
export async function scanExternalPaths(): Promise<ScanResult> {
	const paths = await getExternalStackPaths();

	if (paths.length === 0) {
		return { discovered: [], adopted: [], skipped: [], errors: [] };
	}

	console.log(`[Stack Scanner] Scanning ${paths.length} external path(s)...`);

	const allDiscovered: DiscoveredStack[] = [];
	const allErrors: { path: string; error: string }[] = [];

	// Scan all paths
	for (const path of paths) {
		const { stacks, errors } = await scanPath(path);
		allDiscovered.push(...stacks);
		allErrors.push(...errors);
	}

	console.log(`[Stack Scanner] Found ${allDiscovered.length} compose file(s)`);

	// Check which stacks are already adopted
	const existingSources = await getStackSources();
	const alreadyAdopted: DiscoveredStack[] = [];
	const newStacks: DiscoveredStack[] = [];

	for (const stack of allDiscovered) {
		const isAdopted = existingSources.some(s => s.composePath === stack.composePath);
		if (isAdopted) {
			alreadyAdopted.push(stack);
		} else {
			newStacks.push(stack);
		}
	}

	if (alreadyAdopted.length > 0) {
		console.log(`[Stack Scanner] ${alreadyAdopted.length} stack(s) already adopted`);
	}
	if (newStacks.length > 0) {
		console.log(`[Stack Scanner] ${newStacks.length} new stack(s) available for adoption`);
	}
	if (allErrors.length > 0) {
		console.warn(`[Stack Scanner] ${allErrors.length} error(s) during scanning`);
	}

	return {
		discovered: newStacks, // Only return stacks not yet adopted
		adopted: [], // No auto-adopt anymore
		skipped: alreadyAdopted,
		errors: allErrors
	};
}

/**
 * Check if two paths overlap (one is parent/child of the other)
 */
function pathsOverlap(path1: string, path2: string): 'parent' | 'child' | 'same' | null {
	const resolved1 = resolve(path1);
	const resolved2 = resolve(path2);

	if (resolved1 === resolved2) {
		return 'same';
	}

	// Normalize paths with trailing slash for proper prefix matching
	const normalized1 = resolved1.endsWith('/') ? resolved1 : resolved1 + '/';
	const normalized2 = resolved2.endsWith('/') ? resolved2 : resolved2 + '/';

	if (normalized2.startsWith(normalized1)) {
		// path1 is parent of path2
		return 'parent';
	}

	if (normalized1.startsWith(normalized2)) {
		// path1 is child of path2
		return 'child';
	}

	return null;
}

/**
 * Validate that a path exists, is a directory, and doesn't overlap with existing paths
 */
export function validatePath(
	path: string,
	existingPaths: string[] = []
): { valid: boolean; error?: string; resolvedPath?: string } {
	if (!path || typeof path !== 'string') {
		return { valid: false, error: 'Path is required' };
	}

	const resolvedPath = resolve(path.trim());

	if (!existsSync(resolvedPath)) {
		return { valid: false, error: 'Path does not exist' };
	}

	try {
		const stat = statSync(resolvedPath);
		if (!stat.isDirectory()) {
			return { valid: false, error: 'Path is not a directory' };
		}
	} catch {
		return { valid: false, error: 'Cannot access path' };
	}

	// Check for overlapping paths
	for (const existingPath of existingPaths) {
		const overlap = pathsOverlap(resolvedPath, existingPath);
		if (overlap === 'same') {
			return { valid: false, error: 'This location is already added' };
		}
		if (overlap === 'parent') {
			return { valid: false, error: `This path contains an existing location: ${existingPath}` };
		}
		if (overlap === 'child') {
			return { valid: false, error: `This path is inside an existing location: ${existingPath}` };
		}
	}

	return { valid: true, resolvedPath };
}

/**
 * Detect which discovered stacks are already running on any environment.
 * Matches by stack name (com.docker.compose.project label) since paths may differ.
 */
export async function detectRunningStacks(
	discovered: DiscoveredStack[]
): Promise<DiscoveredStack[]> {
	if (discovered.length === 0) {
		return discovered;
	}

	// Dynamic imports to avoid circular dependencies
	const { listComposeStacks } = await import('./stacks.js');
	const { getEnvironments } = await import('./db.js');

	// Get all environments
	const environments = await getEnvironments();

	if (environments.length === 0) {
		return discovered;
	}

	// Build map of stack name -> running info across all environments
	const runningStacksMap = new Map<string, RunningStackInfo[]>();

	// Query each environment in parallel for running stacks
	await Promise.all(
		environments.map(async (env) => {
			try {
				const stacks = await listComposeStacks(env.id);
				for (const stack of stacks) {
					const existing = runningStacksMap.get(stack.name) || [];
					existing.push({
						envId: env.id,
						envName: env.name,
						containerCount: stack.containers?.length || 0
					});
					runningStacksMap.set(stack.name, existing);
				}
			} catch (error) {
				// Environment might be offline - skip silently
				console.warn(`[Stack Scanner] Failed to query environment ${env.name}:`, error);
			}
		})
	);

	// Attach running info to discovered stacks by matching name
	return discovered.map((stack) => ({
		...stack,
		runningOn: runningStacksMap.get(stack.name)
	}));
}
