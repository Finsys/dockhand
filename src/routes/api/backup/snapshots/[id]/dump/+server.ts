import { json } from '@sveltejs/kit';
import { validateSnapshotId } from '$lib/server/docker-validation';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
import { dumpSnapshotFile, dumpSnapshotFileBytes, dumpSnapshotArchive } from '$lib/server/backups';
import { guardSnapshotEnvAccess } from '$lib/server/backups/route-guards';
import { parseSnapshotLayout, redactSnapshotLayout } from '$lib/server/backups/snapshot-layout';
import { jobResult } from '$lib/server/sse';

/**
 * @openapi
 * summary: Read a single file (or archive) out of a snapshot (job-polled restic dump)
 * description: Job-polled so a proxy can't abort the restic dump at ~15s. type selects the payload (inline preview vs archive); download requests a raw file/directory tar. A raw metadata.json download is refused (403) - it would bypass redaction.
 * path: id:string The restic snapshot id
 * query: destinationId:integer Destination the snapshot lives in
 * query: path:string Path inside the snapshot (must resolve under /volumes or /metadata)
 * query: type:string Payload kind (e.g. inline preview vs archive)
 * query: download:string When set, stream the file/directory as a tar
 * resp-400: Missing/invalid destinationId or path
 * resp-403: Permission denied (needs backups:view), or a raw metadata.json download was refused
 * resp-500: The restic dump failed
 */
export const GET: RequestHandler = async ({ params, url, cookies, request }) => {
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
		// Job-polling: `restic dump` behind a reverse proxy would abort at ~15s.
		return jobResult(request, async () => {
			const raw = await dumpSnapshotFile(destinationId, snapshotId, '/metadata/metadata.json');
			const layout = parseSnapshotLayout(raw);
			if (!layout) return { error: 'metadata unreadable' };
			return { content: JSON.stringify(redactSnapshotLayout(layout), null, 2) };
		});
	}

	// Sanitize filename for Content-Disposition (strip quotes, backslashes, control chars)
	const sanitizeFilename = (name: string) => name.replace(/["\\\x00-\x1f]/g, '_');

	// Binary downloads are window.open navigations, not fetch()es — they can't poll a job,
	// so they stay synchronous. (A raw byte/tar stream also can't be JSON-wrapped.) These
	// stream restic's output, so the proxy sees bytes flowing and won't idle-abort them.
	if (download) {
		try {
			if (isDir) {
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
			// A file download may be binary — serve raw bytes, not a decoded string.
			const bytes = await dumpSnapshotFileBytes(destinationId, snapshotId, path);
			const filename = sanitizeFilename(path.split('/').pop() || 'file');
			return new Response(new Uint8Array(bytes), {
				headers: {
					'Content-Type': 'application/octet-stream',
					'Content-Disposition': `attachment; filename="${filename}"`
				}
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			return json({ error: errorMsg }, { status: 500 });
		}
	}

	// Inline preview (text only) — job-polling: `restic dump` would otherwise be aborted
	// at the reverse-proxy's ~15s cap.
	return jobResult(request, async () => {
		const content = await dumpSnapshotFile(destinationId, snapshotId, path);
		return { content };
	});
};
