/**
 * Pure per-stack git-model routing decisions — no database, no git subprocess.
 *
 * Extracted so the mixed-mode behavior (stack-model vs centralized-model rows
 * coexisting) is unit-testable without the SvelteKit runtime, mirroring the
 * git-deploy-gating.ts pattern. The server modules call these directly, so the
 * tests exercise the same code paths the app uses.
 */

export type GitModel = 'stack' | 'centralized';

export interface GitModelStackLike {
	engine?: string | null;
}

export interface GitModelRepoLike {
	id: number;
}

export interface GitModelStackWithRepo extends GitModelStackLike {
	id: number;
	repositoryId: number;
}

/** Stacks that run on the per-stack engine (engine = 'stack'). */
export function filterStackModel<T extends GitModelStackLike>(stacks: T[]): T[] {
	return stacks.filter((s) => s.engine === 'stack');
}

/** Stacks that run on the centralized engine (engine = 'centralized'). */
export function filterCentralizedStacks<T extends GitModelStackLike>(stacks: T[]): T[] {
	return stacks.filter((s) => s.engine === 'centralized');
}

/**
 * Repos eligible for repo-level git_repository_sync / webhook: repo-level
 * settings are centralized concepts, so only repos with at least one
 * centralized-model stack participate. Stack-model-only repos keep per-stack
 * schedules/webhooks.
 */
export function filterReposWithCentralizedMember<R extends GitModelRepoLike, S extends GitModelStackWithRepo>(
	repos: R[],
	stacks: S[]
): R[] {
	const centralizedRepoIds = new Set(filterCentralizedStacks(stacks).map((s) => s.repositoryId));
	return repos.filter((r) => centralizedRepoIds.has(r.id));
}

/**
 * A git_stack_sync schedule targets the STACK for stack-model stacks and the
 * REPOSITORY for centralized-model stacks (the deprecated alias from the old
 * fleet cutover keeps resolving to the shared clone's repo). Resolves by the
 * stack row's own model, never the global default.
 */
export function resolveGitStackScheduleKind(model: GitModel): 'stack' | 'repository' {
	return model === 'centralized' ? 'repository' : 'stack';
}

export interface StackWebhookContract {
	/** Stack-model webhooks are synchronous; centralized-model ones trigger async. */
	synchronous: boolean;
	/** Centralized-model stack webhooks are a deprecated compat shim. */
	deprecated: boolean;
	/** Centralized-model stack webhooks require force-redeploy. */
	requiresForceRedeploy: boolean;
}

/**
 * The stack webhook contract follows the STACK's own model: stack-model stacks
 * use the synchronous per-stack webhook (no precondition); centralized-model
 * stacks use the deprecated background shim gated on force-redeploy.
 */
export function stackWebhookContract(model: GitModel): StackWebhookContract {
	if (model === 'centralized') {
		return { synchronous: false, deprecated: true, requiresForceRedeploy: true };
	}
	return { synchronous: true, deprecated: false, requiresForceRedeploy: false };
}

/**
 * New stacks ALWAYS inherit the global default. Any model sent by the client is
 * ignored — there is no per-stack chooser.
 */
export function createStackModel(defaultModel: GitModel, _clientModel?: unknown): GitModel {
	return defaultModel;
}
