import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackSources, getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { listContainers } from '$lib/server/docker';
import { resolveStackSourceDisplayPathsForEnv, buildStackPathHintsMap } from '$lib/server/stacks';

/**
 * @openapi
 * summary: List stack source records (their stored compose/env paths and source type)
 * query: env:integer Filter to a single environment id
 * resp-403: Permission denied (needs stacks:view)
 * resp-500: Failed to list stack sources
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const sources = await getStackSources(envIdNum);

		// Batch-fetch environments and container path hints once per env, so
		// per-stack Hawser remapping doesn't trigger a DB lookup and a full
		// container listing for every source (N+1).
		const envIds = [...new Set(sources.map((s) => s.environmentId).filter((id): id is number => id != null))];
		const envs = await Promise.all(envIds.map((id) => getEnvironment(id)));
		const envMap = new Map(envs.filter((e) => e !== undefined).map((e) => [e.id, e]));

		const hintEnvIds = [...new Set(sources.map((s) => s.environmentId ?? null))];
		const hintMaps = await Promise.all(
			hintEnvIds.map(async (id) => {
				const containers = await listContainers(true, id);
				return { id, map: buildStackPathHintsMap(containers) };
			})
		);
		const hintsByEnv = new Map(hintMaps.map((h) => [String(h.id ?? 'null'), h.map]));

		// Convert to a map for easier lookup in the frontend.
		// Resolve compose paths to absolute on-disk paths (git stacks store repo-relative paths).
		const sourceMap: Record<string, { sourceType: string; composePath?: string | null; composePaths?: string | null; repository?: any; secretProviderId?: number | null }> = {};
		for (const source of sources) {
			const resolved = await resolveStackSourceDisplayPathsForEnv(
				source,
				source.environmentId != null ? envMap.get(source.environmentId) ?? null : null,
				hintsByEnv.get(String(source.environmentId ?? 'null'))?.get(source.stackName) ?? null
			);
			sourceMap[source.stackName] = {
				sourceType: source.sourceType,
				composePath: resolved.composePath,
				composePaths: resolved.composePaths.length > 0 ? JSON.stringify(resolved.composePaths) : null,
				repository: source.repository,
				secretProviderId: source.secretProviderId
			};
		}

		return json(sourceMap);
	} catch (error) {
		console.error('Failed to get stack sources:', error);
		return json({ error: 'Failed to get stack sources' }, { status: 500 });
	}
};
