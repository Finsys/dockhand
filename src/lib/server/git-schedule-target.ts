/**
 * Single source of truth for resolving git schedule targets.
 *
 * Stack-model stacks are scheduled per-stack (git_stack_sync → the stack row).
 * Centralized-model stacks sync at the repository level; the deprecated
 * git_stack_sync for them continues to map to the stack's repository (old
 * installs cut over under the fleet transition left stack-id keyed
 * git_stack_sync calls; they must keep resolving to the repo, not the stack).
 * git_repository_sync always targets the repository. All schedule routes must
 * resolve through this function (F12) — no ad-hoc repo remapping.
 */

import { getGitStack, getGitRepository, type GitStackWithRepo, type GitRepositoryData } from './db';
import { resolveGitStackScheduleKind } from '../utils/git-model-routing';

export type GitScheduleTarget =
	| { kind: 'stack'; id: number; entity: GitStackWithRepo }
	| { kind: 'repository'; id: number; entity: GitRepositoryData };

export type GitScheduleType = 'git_stack_sync' | 'git_repository_sync';

/**
 * Resolve the effective target for a git schedule id. Returns null when the
 * entity is missing or (deprecated centralized git_stack_sync) has no linked
 * repository.
 */
export async function resolveGitScheduleTarget(
	type: string,
	id: number
): Promise<GitScheduleTarget | null> {
	if (type === 'git_stack_sync') {
		const stack = await getGitStack(id);
		if (!stack) return null;
		if (resolveGitStackScheduleKind(stack.engine) === 'repository') {
			// Centralized stacks live on the shared clone: git_stack_sync is a
			// deprecated alias — target the repository.
			if (!stack.repositoryId) return null;
			const repo = await getGitRepository(stack.repositoryId);
			if (!repo) return null;
			return { kind: 'repository', id: repo.id, entity: repo };
		}
		return { kind: 'stack', id, entity: stack };
	}
	if (type === 'git_repository_sync') {
		const repo = await getGitRepository(id);
		if (!repo) return null;
		return { kind: 'repository', id, entity: repo };
	}
	return null;
}

/** True when the schedule type is one of the git families. */
export function isGitScheduleType(type: string): type is GitScheduleType {
	return type === 'git_stack_sync' || type === 'git_repository_sync';
}
