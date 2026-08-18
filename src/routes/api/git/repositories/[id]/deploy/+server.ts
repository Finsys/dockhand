import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGitRepository, getFullGitStacksByRepositoryId } from '$lib/server/db';
import { deployFromRepositoryWithFanOut } from '$lib/server/git';
import { assertNotMigrating } from '$lib/server/git-migration-guard';
import { auditGitRepository } from '$lib/server/audit';
import { authorize } from '$lib/server/authorize';
import { filterCentralizedStacks } from '$lib/utils/git-model-routing';
import { filterStacksByEnvAccess } from '$lib/utils/git-deploy-gating';

/**
 * @openapi
 * summary: Deploy the compose stack(s) defined in a git repository (clones/pulls, then runs docker compose)
 * path: id:integer! Git repository ID (from GET /api/git/repositories)
 * resp-200: {success:boolean!, error:string}
 * resp-200-example: {"success":true}
 * resp-400: The id path segment is not a valid integer
 * resp-403: Caller lacks git:edit, or cannot deploy any of the repository's stacks' environments
 * resp-404: No repository exists with that ID
 * resp-500: The deployment failed
 */
export const POST: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('git', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid repository ID' }, { status: 400 });
		}

		// Block only while THIS repository is being provisioned by a migration.
		const locked = await assertNotMigrating([], [id]);
		if (locked) return locked;

		const repository = await getGitRepository(id);
		if (!repository) {
			return json({ error: 'Repository not found' }, { status: 404 });
		}

		// Fan-out must be env-scoped: the repo deploy resolves each stack's
		// environment and only fanned out stacks the caller may deploy
		// (stacks:start per environment), mirroring the per-stack route.
		let allowed: number[] | undefined;
		if (auth.authEnabled) {
			const stacks = filterCentralizedStacks(await getFullGitStacksByRepositoryId(id));
			allowed = await filterStacksByEnvAccess(stacks, (envId) => auth.can('stacks', 'start', envId ?? undefined));
			if (allowed.length === 0) {
				return json({ error: 'Permission denied' }, { status: 403 });
			}
		}

		// Deploy from repository using fan-out logic
		const result = await deployFromRepositoryWithFanOut(id, undefined, allowed);
		await auditGitRepository(event, 'deploy', id, repository.name, {
			result: result.success ? 'deployed' : 'failed'
		});
		return json(result);
	} catch (error: any) {
		console.error('Failed to deploy from git repository:', error);
		return json({ success: false, error: error.message }, { status: 500 });
	}
};
