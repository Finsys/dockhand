/**
 * Narrow 409 guard for the per-stack migration job.
 *
 * While a git stack migration is running (git_migration_state.state !==
 * 'idle'), only the entities INSIDE that job's scope are locked: the migrating
 * stack ids and the repositories they belong to. Everything else keeps working
 * (unlike the old whole-instance git-mode-transition lock).
 */

import { json } from '@sveltejs/kit';
import { getGitMigrationState, getGitStack } from './db';
import {
	isStackInMigrationScope,
	type GitMigrationScope
} from '../utils/git-migration-scope';

export type { GitMigrationScope };

/**
 * Resolve the current active migration scope (empty when no job is running).
 * Repos are derived from the selected stack rows each call — cheap and always
 * current.
 */
export async function getActiveGitMigrationScope(): Promise<GitMigrationScope> {
	const job = await getGitMigrationState();
	if (!job || job.state === 'idle') {
		return { stackIds: [], repoIds: [] };
	}
	let stackIds: number[] = [];
	try {
		stackIds = JSON.parse(job.stackIds ?? '[]');
	} catch {
		stackIds = [];
	}
	const repoIds = new Set<number>();
	for (const id of stackIds) {
		const stack = await getGitStack(id);
		if (stack?.repositoryId) repoIds.add(stack.repositoryId);
	}
	return { stackIds, repoIds: [...repoIds] };
}

/**
 * Whether system-triggered git operations for this stack must be suppressed
 * right now (a per-stack migration is draining/provisioning it). DB-backed, so
 * it stays correct across a mid-migration restart, unlike the in-memory cron
 * unregister.
 */
export async function isStackMigrating(stackId: number): Promise<boolean> {
	return isStackInMigrationScope(await getActiveGitMigrationScope(), stackId);
}

/**
 * Block a git write when it would touch a stack or repository inside the
 * active migration job's scope. Callers that know their target ids should pass
 * them so unrelated stacks/repos stay unlocked. When the migration job is
 * actively provisioning, the repo ids are locked for the whole window.
 */
export async function assertNotMigrating(stackIds: number[] = [], repoIds: number[] = []): Promise<Response | null> {
	const scope = await getActiveGitMigrationScope();
	if (scope.stackIds.length === 0 && scope.repoIds.length === 0) return null;

	const touchesStack = stackIds.some((id) => scope.stackIds.includes(id));
	const touchesRepo = repoIds.some((id) => scope.repoIds.includes(id));
	if (touchesStack || touchesRepo) {
		return json({ error: 'A git stack migration is in progress for this stack or repository' }, { status: 409 });
	}
	return null;
}