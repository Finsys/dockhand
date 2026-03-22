import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';
import { authorize } from '$lib/server/authorize';

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
 * Body: { path: string }
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
 * Query params:
 * - path: Directory path to list
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	if (auth.authEnabled && !await auth.can('stacks', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const path = url.searchParams.get('path') || '/';

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
