import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { computeStackDeletionPaths } from '$lib/server/stacks';
import { authorize } from '$lib/server/authorize';

// GET /api/stacks/[name]/delete-preview?env=N
// Returns the on-disk directories a delete-with-files would remove, so the confirm modal
// shows the user EXACTLY what the backend will delete (same source of truth — no drift).
/**
 * @openapi
 * summary: Preview the on-disk directories and named volumes a delete-with-files would remove for a stack
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * resp-200: {stackName:string!, sourceType:string, stackDir:string, gitDir:string, namedVolumes:array<string>!, canDeleteFiles:boolean!}
 * resp-200-example: {"stackName":"web","sourceType":"internal","stackDir":"/opt/stacks/web","gitDir":null,"namedVolumes":["web_data"],"canDeleteFiles":true}
 * resp-403: Permission denied (requires stacks:remove)
 * resp-500: Failed to compute the deletion preview
 */
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
