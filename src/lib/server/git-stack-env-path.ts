/**
 * Where a Git stack's configured env file lands inside its stack directory.
 *
 * A Git deploy copies the compose directory (or the context directory, when one
 * is set) into the stack directory, and points --env-file at the configured env
 * file relative to it. The lifecycle paths (start, update, down) only see the
 * stack directory, so they derive the same location from the stored Git stack
 * settings with this helper. Pure: no fs, so it is unit-testable.
 */

import { posix } from 'node:path';

export interface GitStackEnvPathInput {
	// Nullable in the database even though the column has a default.
	composePath: string | null;
	contextDir?: string | null;
	envFilePath?: string | null;
}

/**
 * The env file's path relative to the stack directory, or null when no env file
 * is configured or it lies outside the directory a deploy copies (such a file
 * never reaches the stack directory, so there is nothing to read).
 */
export function gitStackEnvFileRelPath(stack: GitStackEnvPathInput): string | null {
	const envFilePath = stack.envFilePath?.trim();
	if (!envFilePath || !stack.composePath) return null;
	const sourceDir = stack.contextDir?.trim()
		? posix.normalize(stack.contextDir.trim())
		: posix.dirname(posix.normalize(stack.composePath));
	const rel = posix.relative(posix.normalize(`/${sourceDir}`), posix.normalize(`/${envFilePath}`));
	if (!rel || rel === '..' || rel.startsWith('../')) return null;
	return rel;
}
