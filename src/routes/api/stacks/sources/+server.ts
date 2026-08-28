import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackSources, getEnvironment } from '$lib/server/db';
import { countStackEnvVars } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';
import { listContainers } from '$lib/server/docker';
import { resolveStackSourceDisplayPathsForEnv, buildStackPathHintsMap } from '$lib/server/stacks';

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

		// Batch-fetch environments and container path hints once per env, so
		// per-stack Hawser remapping doesn't trigger a DB lookup and a full
		// container listing for every source (N+1).
		const envIds = [...new Set(sources.map((s) => s.environmentId ?? null))];
		const perEnv = await Promise.all(
			envIds.map(async (id) => ({
				id,
				env: id != null ? (await getEnvironment(id)) ?? null : null,
				hints: buildStackPathHintsMap(await listContainers(true, id).catch(() => []))
			}))
		);
		const byEnv = new Map(perEnv.map((e) => [e.id, e]));

		// Count env vars server-side (one local read per stack) so the list badge does
		// not need a /env fetch per stack. GET /env resolves its env param as
		// `envId ? parseInt : null`, so pass the SAME null-when-absent value (not
		// undefined - getStackEnvVars scopes differently for null vs undefined) so the
		// count matches that endpoint's variable list exactly.
		const countEnvId = envIdNum ?? null;
		const counts = await Promise.all(
			sources.map((s) =>
				s.sourceType === 'internal' || s.sourceType === 'git'
					? countStackEnvVars(s.stackName, countEnvId)
					: Promise.resolve(0)
			)
		);
		// Convert to a map for easier lookup in the frontend.
		// Resolve compose paths to absolute on-disk paths (git stacks store repo-relative paths).
		const sourceMap: Record<
			string,
			{
				sourceType: string;
				composePath?: string | null;
				composePaths?: string | null;
				repository?: any;
				secretProviderId?: number | null;
				icon?: string | null;
				envVarCount?: number;
			}
		> = {};
		for (const [i, source] of sources.entries()) {
			const entry = byEnv.get(source.environmentId ?? null);
			const resolved = await resolveStackSourceDisplayPathsForEnv(
				source,
				entry?.env ?? null,
				entry?.hints.get(source.stackName) ?? null
			);
			sourceMap[source.stackName] = {
				sourceType: source.sourceType,
				composePath: resolved.composePath,
				composePaths: resolved.composePaths.length > 0 ? JSON.stringify(resolved.composePaths) : null,
				repository: source.repository,
				secretProviderId: source.secretProviderId,
				icon: source.icon ?? null,
				envVarCount: counts[i]
			};
		}

		return json(sourceMap);
	} catch (error) {
		console.error('Failed to get stack sources:', error);
		return json({ error: 'Failed to get stack sources' }, { status: 500 });
	}
};
