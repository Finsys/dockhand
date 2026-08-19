import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';
import { authorize } from '$lib/server/authorize';
import { isProtectedPath } from '$lib/server/fs-guard';

export interface FileEntry {
	name: string;
	path: string;
	type: 'file' | 'directory' | 'symlink';
	size: number;
	mtime: string;
	mode: string;
}

/**
 * POST /api/system/files
 * Create a directory
 *
 * @openapi
 * summary: Create a directory on Dockhand's local filesystem (absolute path, no traversal, non-protected)
 * body: {path:string!}
 * body-example: {"path":"/docker/stacks/myapp"}
 * resp-200: {success:boolean!, path:string!}
 * resp-200-example: {"success":true,"path":"/docker/stacks/myapp"}
 * resp-400: Path is missing, not absolute, or contains ".."
 * resp-403: Permission denied, or the path is protected
 * resp-409: Path already exists
 * resp-500: Failed to create directory
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('stacks', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const path = body.path;

		if (!path || typeof path !== 'string') {
			return json({ error: 'Path is required' }, { status: 400 });
		}

		if (!isAbsolute(path)) {
			return json({ error: 'Path must be absolute' }, { status: 400 });
		}

		if (path.includes('..')) {
			return json({ error: 'Path must not contain ..' }, { status: 400 });
		}

		if (isProtectedPath(path)) {
			return json({ error: 'Access denied' }, { status: 403 });
		}

		if (existsSync(path)) {
			return json({ error: 'Path already exists' }, { status: 409 });
		}

		mkdirSync(path, { recursive: true });

		return json({ success: true, path });
	} catch (error) {
		console.error('Error creating directory:', error);
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: `Failed to create directory: ${message}` }, { status: 500 });
	}
};

/**
 * GET /api/system/files
 * Browse Dockhand's local filesystem (for mount browsing)
 *
 * @openapi
 * summary: List the entries of a directory on Dockhand's local filesystem (protected paths are hidden)
 * query: path:string Absolute directory path to list (defaults to "/")
 * resp-200: {path:string!, parent:string, entries:array<{name:string!, path:string!, type:string!, size:integer!, mtime:string!, mode:string!}>!}
 * resp-200-example: {"path":"/docker","parent":"/","entries":[{"name":"stacks","path":"/docker/stacks","type":"directory","size":4096,"mtime":"2026-07-01T10:00:00.000Z","mode":"755"}]}
 * resp-400: The path exists but is not a directory
 * resp-403: Permission denied, or the path is protected
 * resp-404: Path not found
 * resp-500: Failed to list directory
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('stacks', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const path = url.searchParams.get('path') || '/';

	if (isProtectedPath(path)) {
		return json({ error: 'Access denied' }, { status: 403 });
	}

	try {
		if (!existsSync(path)) {
			return json({ error: `Path not found: ${path}` }, { status: 404 });
		}

		const stat = statSync(path);
		if (!stat.isDirectory()) {
			return json({ error: `Not a directory: ${path}` }, { status: 400 });
		}

		const entries: FileEntry[] = [];
		const dirEntries = readdirSync(path, { withFileTypes: true });

		for (const entry of dirEntries) {
			try {
				const fullPath = join(path, entry.name);
				// Hide Dockhand's secrets (db dir, encryption key) from the listing.
				if (isProtectedPath(fullPath)) continue;
				const entryStat = statSync(fullPath);

				entries.push({
					name: entry.name,
					path: fullPath,
					type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
					size: entryStat.size,
					mtime: entryStat.mtime.toISOString(),
					mode: (entryStat.mode & 0o777).toString(8).padStart(3, '0')
				});
			} catch {
				// Skip entries we can't stat (permission issues, etc.)
			}
		}

		// Sort: directories first, then alphabetically
		entries.sort((a, b) => {
			if (a.type === 'directory' && b.type !== 'directory') return -1;
			if (a.type !== 'directory' && b.type === 'directory') return 1;
			return a.name.localeCompare(b.name);
		});

		return json({
			path,
			parent: path === '/' ? null : join(path, '..'),
			entries
		});
	} catch (error) {
		console.error('Error listing directory:', error);
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: `Failed to list directory: ${message}` }, { status: 500 });
	}
};
