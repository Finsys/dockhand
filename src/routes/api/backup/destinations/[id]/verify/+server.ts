import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { auditBackupDestination } from '$lib/server/audit';
import { getBackupDestination } from '$lib/server/db';
import { verifyBackup } from '$lib/server/backups';
import { createJobResponse } from '$lib/server/sse';

/**
 * POST /api/backup/destinations/{id}/verify - Verify backup integrity (streamed job)
 *
 * @openapi
 * summary: Verify the integrity of a destination's backups by reading a data subset, streaming progress as a Server-Sent Events job
 * description: Returns a text/event-stream that emits `progress` events and a final `result` event. Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard.
 * path: id:integer! Backup destination id (from GET /api/backup/destinations)
 * body: {dataSubset:string}
 * body-example: {"dataSubset":"5%"}
 * resp-200: Server-Sent Events stream of progress and a final result event ({ success, ... })
 * resp-400: Invalid destination id (not a number)
 */
export const POST: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

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
