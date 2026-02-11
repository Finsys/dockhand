import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStackSources } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

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

		// Convert to a map for easier lookup in the frontend
		const sourceMap: Record<string, { sourceType: string; composePath?: string | null; repository?: any }> = {};
		for (const source of sources) {
			sourceMap[source.stackName] = {
				sourceType: source.sourceType,
				composePath: source.composePath,
				repository: source.repository
			};
		}

		return json(sourceMap);
	} catch (error) {
		console.error('Failed to get stack sources:', error);
		return json({ error: 'Failed to get stack sources' }, { status: 500 });
	}
};
