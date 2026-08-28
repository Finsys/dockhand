import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackSources, getEnvironment } from '$lib/server/db';
import { countStackEnvVars, resolveStackSourceDisplayPathsForEnv, buildStackPathHintsMap } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { listContainers } from '$lib/server/docker';

/**
 * @openapi
 * summary: List stack source records (their stored compose/env paths and source type, plus an env-var count)
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

		const envIds = [...new Set(sources.map((s) => s.environmentId).filter((id): id is number => id != null))];
		const envs = await Promise.all(envIds.map((id) => getEnvironment(id)));
		const envMap = new Map(envs.filter((e) => e !== undefined).map((e) => [e.id, e]));

		const hintEnvIds = [...new Set(sources.map((s) => s.environmentId ?? null))];
		const hintMaps = await Promise.all(
			hintEnvIds.map(async (id) => {
				const containers = await listContainers(true, id).catch(() => []);
				return { id, map: buildStackPathHintsMap(containers) };
			})
		);
		const hintsByEnv = new Map(hintMaps.map((h) => [String(h.id ?? 'null'), h.map]));

		const sourceMap: Record<
			string,
			{
				sourceType: string;
				composePath?: string | null;
				repository?: any;
				secretProviderId?: number | null;
				icon?: string | null;
				envVarCount?: number;
			}
		> = {};
		const countEnvId = envIdNum ?? null;
		const counts = await Promise.all(
			sources.map((s) =>
				s.sourceType === 'internal' || s.sourceType === 'git'
					? countStackEnvVars(s.stackName, countEnvId)
					: Promise.resolve(0)
			)
		);
		for (const [i, source] of sources.entries()) {
			const resolved = await resolveStackSourceDisplayPathsForEnv(
				source,
				source.environmentId != null ? envMap.get(source.environmentId) ?? null : null,
				hintsByEnv.get(String(source.environmentId ?? 'null'))?.get(source.stackName) ?? null
			);
			sourceMap[source.stackName] = {
				sourceType: source.sourceType,
				composePath: resolved.composePath,
				repository: source.repository,
				secretProviderId: source.secretProviderId,
				icon: source.icon ?? null,
				envVarCount: counts[i],
			};
		}

		return json(sourceMap);
	} catch (error) {
		console.error('Failed to get stack sources:', error);
		return json({ error: 'Failed to get stack sources' }, { status: 500 });
	}
};
