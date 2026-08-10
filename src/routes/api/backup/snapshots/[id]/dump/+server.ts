import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { dumpSnapshotFile, dumpSnapshotFileBytes, dumpSnapshotArchive } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { parseSnapshotLayout, redactSnapshotLayout } from '$lib/server/backups/snapshot-layout';

/**
 * GET /api/backup/snapshots/{id}/dump - Read or download a file/directory from a snapshot
 *
 * @openapi
 * summary: Dump a file or directory from a snapshot — inline JSON preview for text files, or a raw binary download (octet-stream for files, tar for directories) when download=1
 * description: Paths are restricted to the /volumes and /metadata snapshot roots and rejected if they contain traversal (".."). Permission ("backups:view") and environment-access denials are produced by the shared requireBackups/guardSnapshotEnvAccess route guards.
 * path: id:string! Restic snapshot id
 * query: destinationId:integer! Destination holding the snapshot (required) (from GET /api/backup/destinations)
 * query: path:string! Path inside the snapshot to read (must be under /volumes or /metadata)
 * query: download:string Set to "1" to download raw bytes instead of an inline preview
 * query: type:string Set to "directory" to download a directory as a tar archive (with download=1)
 * resp-200: Inline preview returns { content } (JSON); with download=1 the body is the raw file bytes (application/octet-stream) or a tar archive (application/x-tar)
 * resp-400: Missing/invalid destinationId, missing path, an invalid snapshot id, or a path outside the allowed roots / containing traversal
 * resp-403: metadata.json cannot be downloaded raw (download=1); use this endpoint without download for the redacted inline preview
 * resp-404: The redacted metadata.json preview could not be parsed
 * resp-500: Failed to read the file/directory from the snapshot (restic error)
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

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

	// metadata.json carries secrets (stack.secrets ciphertext + container Config.Env
	// plaintext). It must ONLY leave the process through the redacting path — never as a
	// raw file/byte/archive dump, which would bypass redaction. Serve a redacted inline
	// preview; refuse raw downloads and reject a /metadata archive dump that would embed it.
	const isMetadataFile = path === '/metadata/metadata.json';
	if (isMetadataFile || (isDir && download && (path === '/metadata' || path === '/metadata/'))) {
		if (download) {
			return json({ error: 'metadata.json cannot be downloaded raw; use the snapshot metadata endpoint (secrets are redacted there)' }, { status: 403 });
		}
		try {
			const raw = await dumpSnapshotFile(destinationId, snapshotId, '/metadata/metadata.json');
			const layout = parseSnapshotLayout(raw);
			if (!layout) return json({ error: 'metadata unreadable' }, { status: 404 });
			return json({ content: JSON.stringify(redactSnapshotLayout(layout), null, 2) });
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			return json({ error: errorMsg }, { status: 500 });
		}
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
