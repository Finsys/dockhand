/**
 * Pure path guard for stack-directory deletion (#675). Import-light (only node:path), so
 * it's unit-testable without pulling the DB/docker imports of stacks.ts.
 *
 * THE BUG (#675): a stack ADOPTED at the stacks ROOT (compose at
 * $DATA_DIR/stacks/docker-compose.yml) is auto-named "stacks". On delete, its custom dir
 * is the stacks ROOT and its basename ("stacks") equals the stack name ("stacks"). A plain
 * `startsWith(stacksRoot)` guard passed both checks, so rmSync wiped the ENTIRE stacks
 * folder — every other stack. The fix is a STRICT-subdir check (`startsWith(stacksRoot +
 * sep)`): resolve() strips trailing separators, so the root has none and fails, while a
 * real nested stack dir ($DATA_DIR/stacks/<env>/<name>) is a strict subdir and passes.
 */
import { resolve, basename, sep as pathSep } from 'node:path';

/**
 * True when `customDir` is a directory Dockhand may delete for `stackName`: a STRICT
 * subdirectory of `stacksDir` (never the root itself) whose basename matches the stack
 * name. Path-only — the caller still checks existsSync before deleting.
 */
export function isDeletableStackDir(customDir: string, stacksDir: string, stackName: string): boolean {
	const resolvedCustomDir = resolve(customDir);
	const resolvedStacksDir = resolve(stacksDir);
	return (
		resolvedCustomDir.startsWith(resolvedStacksDir + pathSep) &&
		basename(resolvedCustomDir) === stackName
	);
}
