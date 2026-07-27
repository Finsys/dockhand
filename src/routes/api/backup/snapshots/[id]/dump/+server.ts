import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { dumpSnapshotFile, dumpSnapshotFileBytes, dumpSnapshotArchive } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';

export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const snapshotId = params.id;
	const invalidSnap = validateSnapshotId(snapshotId);
	if (invalidSnap) return invalidSnap;

	const destIdParam = url.searchParams.get('destinationId');
	if (!destIdParam) return json({ error: 'destinationId parameter is required' }, { status: 400 });

	const destinationId = parseInt(destIdParam);
	if (isNaN(destinationId)) return json({ error: 'Invalid destinationId' }, { status: 400 });

	// (HIGH #8) Enforce per-environment access on the snapshot's OWNING env,
	// resolved server-side from its tag — not a caller-supplied param.
	const envDenied = await guardSnapshotEnvAccess(auth, destinationId, snapshotId);
	if (envDenied) return envDenied;

	const path = url.searchParams.get('path');
	if (!path) return json({ error: 'path parameter is required' }, { status: 400 });

	const download = url.searchParams.get('download') === '1';
	const isDir = url.searchParams.get('type') === 'directory';

	// Validate path — no traversal
	if (path.includes('..')) {
		return json({ error: 'Invalid path' }, { status: 400 });
	}

	// Restrict dumps to the known snapshot roots so arbitrary snapshot paths can't be
	// read. Accept the root dir itself (`/volumes`, `/metadata`) AND anything inside
	// it — the previous `/volumes/` / `/metadata/` prefix check rejected downloading a
	// top-level directory (e.g. `/metadata`) with a bogus "Invalid path".
	if (
		path !== '/volumes' && path !== '/metadata' &&
		!path.startsWith('/volumes/') && !path.startsWith('/metadata/')
	) {
		return json({ error: 'Invalid path' }, { status: 400 });
	}

	// Sanitize filename for Content-Disposition (strip quotes, backslashes, control chars)
	const sanitizeFilename = (name: string) => name.replace(/["\\\x00-\x1f]/g, '_');

	try {
		if (download && isDir) {
			// Binary tar stream — serve the raw bytes untouched (a UTF-8 round-trip
			// would corrupt any non-ASCII byte in the archive).
			const tarData = await dumpSnapshotArchive(destinationId, snapshotId, path);
			const filename = sanitizeFilename((path.split('/').filter(Boolean).pop() || 'archive') + '.tar');
			return new Response(new Uint8Array(tarData), {
				headers: {
					'Content-Type': 'application/x-tar',
					'Content-Disposition': `attachment; filename="${filename}"`
				}
			});
		}

		if (download) {
			// A file download may be binary — serve raw bytes, not a decoded string.
			const bytes = await dumpSnapshotFileBytes(destinationId, snapshotId, path);
			const filename = sanitizeFilename(path.split('/').pop() || 'file');
			return new Response(new Uint8Array(bytes), {
				headers: {
					'Content-Type': 'application/octet-stream',
					'Content-Disposition': `attachment; filename="${filename}"`
				}
			});
		}

		// Inline preview — text only.
		const content = await dumpSnapshotFile(destinationId, snapshotId, path);
		return json({ content });
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return json({ error: errorMsg }, { status: 500 });
	}
};
