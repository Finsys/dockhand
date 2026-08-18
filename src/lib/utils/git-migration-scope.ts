/**
 * Pure migration-scope decisions — no database, no SvelteKit runtime.
 *
 * A per-stack migration job locks ONLY the stacks it is migrating (and their
 * repositories). The scheduler consults this so a system-triggered sync cannot
 * re-clone a stack's per-stack directory while the job is about to remove it.
 * git-migration-guard.ts loads the persisted scope and delegates here.
 */

export interface GitMigrationScope {
	stackIds: number[];
	repoIds: number[];
}

/** True when the given stack id is inside an active migration job's scope. */
export function isStackInMigrationScope(scope: GitMigrationScope, stackId: number): boolean {
	return scope.stackIds.includes(stackId);
}
