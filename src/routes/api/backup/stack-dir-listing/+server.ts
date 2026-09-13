import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { probeStackDir } from '$lib/server/backups';

// GET /api/backup/stack-dir-listing?target=<stack>&env=<id>
// Probe the TARGET host and list the actual contents of the stack directory, so the
// create/edit backup dialog can show the resolved host path + let the user pick which
// stack-dir entries to back up. Returns { kind:'listed', hostPath, entries } or
// { kind:'unknown', reason } (never throws for an operational failure).
/**
 * @openapi
 * summary: Probe the target host and list the actual contents of a stack's directory, for the backup create/edit dialog's file picker
 * query: target:string! Target stack name
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * resp-200: The stack directory probe result — kind "listed"/"tar" with hostPath/localStackDir and entries, or kind "helper-failed"/"unknown" with a reason (never throws for an operational failure)
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
		const result = await probeStackDir(targetName, environmentId);
		return json(result);
	} catch (e) {
		return json({ kind: 'unknown', reason: e instanceof Error ? e.message : 'failed to probe stack directory' });
	}
};
