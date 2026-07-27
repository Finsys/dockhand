import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { runBackup } from '$lib/server/backups';
import { createJobResponse } from '$lib/server/sse';
import { auditBackup } from '$lib/server/audit';
import { requireBackups, loadConfigGateEnv } from '$lib/server/backups/route-guards';

export const POST: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	const gated = await loadConfigGateEnv(params.id, auth);
	if ('response' in gated) return gated.response;
	const config = gated.config;

	await auditBackup(event, 'backup', config.targetName, config.environmentId, { configId: config.id });

	return createJobResponse(async (send) => {
		const result = await runBackup(config.id, 'manual', (status, message) => {
			send('progress', { status, message });
		});

		send('result', result);

		// A backup succeeds as 'success' or 'warning' (partial read still committed);
		// 'skipped' isn't a failure. Only a real 'error' throws.
		if (result.status === 'error') {
			throw new Error(result.error || 'Backup failed');
		}
	}, request);
};
