import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { getSnapshotMetadata } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { redactSnapshotLayout } from '$lib/server/backups/snapshot-layout';
import { jobResult } from '$lib/server/sse';

/**
 * @openapi
 * summary: The snapshot's redacted metadata layout (job-polled restic dump)
 * description: Job-polled so a proxy can't abort the restic dump at ~15s. The layout is redacted (stack secrets and container Config.Env/Labels stripped) before it leaves the server.
 * path: id:string The restic snapshot id
 * query: destinationId:integer Destination the snapshot lives in
 * resp-400: Missing/invalid destinationId
 */
export const GET: RequestHandler = async ({ params, url, cookies, request }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	const snapshotId = params.id;
	const invalidSnap = validateSnapshotId(snapshotId);
	if (invalidSnap) return invalidSnap;

	const destIdParam = url.searchParams.get('destinationId');
	if (!destIdParam) return json({ error: 'destinationId is required' }, { status: 400 });

	const destinationId = parseInt(destIdParam);
	if (isNaN(destinationId)) return json({ error: 'Invalid destinationId' }, { status: 400 });

	// (HIGH #8) Enforce per-environment access on the snapshot's owning env.
	const envDenied = await guardSnapshotEnvAccess(auth, destinationId, snapshotId);
	if (envDenied) return envDenied;

	// Job-polling: reading metadata runs `restic dump` which a proxy would abort at ~15s.
	return jobResult(request, async () => {
		const metadata = await getSnapshotMetadata(destinationId, snapshotId);
		if (!metadata) return { error: 'No metadata available' };
		// Single redaction point: strips stack.secrets values AND container inspect
		// Config.Env/Labels (plaintext secrets) before anything reaches the client.
		return redactSnapshotLayout(metadata);
	});
};
