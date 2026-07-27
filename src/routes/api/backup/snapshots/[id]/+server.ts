import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditBackup } from '$lib/server/audit';
import { getBackupDestination } from '$lib/server/db';
import { forgetSnapshot } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

export const DELETE: RequestHandler = async (event) => {
	const { params, url, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const snapshotId = params.id;
	const invalidSnap = validateSnapshotId(snapshotId);
	if (invalidSnap) return invalidSnap;

	const destIdParam = url.searchParams.get('destinationId');
	if (!destIdParam) return json({ error: 'destinationId parameter is required' }, { status: 400 });

	const destinationId = parseInt(destIdParam);
	if (isNaN(destinationId)) return json({ error: 'Invalid destinationId' }, { status: 400 });

	const envParam = url.searchParams.get('env');
	const envId = envParam ? parseInt(envParam) : undefined;

	// Environment access check (enterprise RBAC) — only when an env is specified.
	if (envId !== undefined && Number.isInteger(envId) && envId > 0 && auth.isEnterprise && !await auth.canAccessEnvironment(envId)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	// (re-audit H2) Server-authoritative env gate, matching the read-content routes
	// (HIGH #8): resolve the snapshot's OWNING env from its own dockhand:env tag and
	// fail closed. The caller-supplied `env` param above is not trusted for access
	// control — omitting it previously skipped the RBAC check entirely on this
	// DESTRUCTIVE (forget --prune) route.
	const denied = await guardSnapshotEnvAccess(auth, destinationId, snapshotId);
	if (denied) return denied;

	try {
		const result = await forgetSnapshot(destinationId, snapshotId);
		const dest = await getBackupDestination(destinationId);
		if (result.ok) {
			// Audit on the backup_config entity (decision: reuse existing
			// entity types rather than add a 'snapshot' one). entityName is
			// the destination, details carries the snapshot ID and dest ID.
			await auditBackup(event, 'delete', dest?.name ?? `destination#${destinationId}`, null, {
				snapshotId,
				destinationId,
				kind: 'snapshot'
			});
			return json({ success: true });
		}
		// (audit low #25) Relay the real reason AND audit the failed delete so it's
		// traceable, instead of a generic opaque 500 with no record.
		await auditBackup(event, 'delete', dest?.name ?? `destination#${destinationId}`, null, {
			snapshotId, destinationId, kind: 'snapshot', failed: true, reason: result.reason
		});
		if (result.reason === 'not-owned') {
			return json({ error: 'Snapshot not found for this installation' }, { status: 404 });
		}
		return json({ error: result.error ?? 'Failed to forget snapshot' }, { status: 500 });
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return json({ error: errorMsg }, { status: 500 });
	}
};
