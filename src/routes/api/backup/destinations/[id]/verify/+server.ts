import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditBackupDestination } from '$lib/server/audit';
import { getBackupDestination } from '$lib/server/db';
import { verifyBackup } from '$lib/server/backups';
import { createJobResponse } from '$lib/server/sse';

export const POST: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const destinationId = parseInt(params.id);
	if (isNaN(destinationId)) return json({ error: 'Invalid destination ID' }, { status: 400 });

	const body = await request.json().catch(() => ({}));
	const dataSubset = body.dataSubset || '5%';

	const dest = await getBackupDestination(destinationId);
	if (dest) {
		await auditBackupDestination(event, 'verify', destinationId, dest.name, { dataSubset });
	}

	return createJobResponse(async (send) => {
		send('progress', { message: `Verifying backup integrity (reading ${dataSubset} of data)...` });

		const result = await verifyBackup(destinationId, {
			dataSubset,
			onProgress: (message) => {
				send('progress', { message });
			}
		});

		send('result', result);

		if (!result.success) {
			throw new Error(result.error || 'Verification failed');
		}
	}, request);
};
