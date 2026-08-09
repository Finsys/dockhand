import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { computeStackDeletionPaths } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';

// GET /api/stacks/[name]/delete-preview?env=N
// Returns the on-disk directories a delete-with-files would remove, so the confirm modal
// shows the user EXACTLY what the backend will delete (same source of truth — no drift).
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	if (auth.authEnabled && !(await auth.can('stacks', 'remove', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const { name } = params;
	try {
		const { stackDir, gitDir, sourceType, namedVolumes } = await computeStackDeletionPaths(name, envIdNum);
		return json({
			stackName: name,
			sourceType,          // internal | git | external | null
			stackDir,            // absolute path, or null if Dockhand won't delete files
			gitDir,              // absolute path of the cloned git repo dir, or null
			namedVolumes,        // compose-managed named volumes removed by "also delete volumes"
			canDeleteFiles: !!(stackDir || gitDir),
		});
	} catch (error: any) {
		return json({ error: error.message || 'Failed to compute deletion preview' }, { status: 500 });
	}
};
