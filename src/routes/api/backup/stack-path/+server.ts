import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { previewStackBackupPath } from '$lib/server/backups';

// GET /api/backup/stack-path?target=<stack>&env=<id>
// Preview WHERE a stack's directory will be captured from on the host (the resolved host
// bind path), or `unknown` with a reason - so the create-schedule dialog can show it up front
// and warn before scheduling a backup that would hard-fail the stack-dir probe.
/**
 * @openapi
 * summary: Preview where a stack's directory will be captured from on the host, without running a backup
 * query: target:string! Target stack name
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * resp-200: The resolved capture path preview — kind "candidate" with hostPath, kind "tar" with composeFile only, or kind "unknown" with a reason
 * resp-400: target is required
 * resp-403: Permission denied (requires backups:view), or no access to the target's environment (enterprise)
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	const targetName = url.searchParams.get('target');
	if (!targetName) return json({ error: 'target is required' }, { status: 400 });
	const envParam = url.searchParams.get('env');
	const environmentId = envParam ? parseInt(envParam) : null;

	if (environmentId != null && auth.isEnterprise && !await auth.canAccessEnvironment(environmentId)) {
		return json({ error: 'Environment access denied' }, { status: 403 });
	}

	try {
		const result = await previewStackBackupPath(targetName, environmentId);
		return json(result);
	} catch (e) {
		return json({ kind: 'unknown', reason: e instanceof Error ? e.message : 'failed to resolve stack path' });
	}
};
