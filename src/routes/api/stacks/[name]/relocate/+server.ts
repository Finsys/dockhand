import { json } from '@sveltejs/kit';
import { parseEnvFileForForm } from '$lib/utils/env-file-values';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getStackSource, updateStackSource } from '$lib/server/db';
import { findStackDir } from '$lib/server/stacks';
import { isForbiddenStackPath, holdsForbiddenStackPath } from '$lib/server/fs-guard';
import { moveDirEntries } from '$lib/server/stack-relocate-move';
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/**
 * POST /api/stacks/[name]/relocate
 *
 * @openapi
 * summary: Move all stack files from the old directory to a new location, update the stored compose/env paths, and return the refreshed compose/env content
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * body: {oldDir:string!, newComposePath:string!, newEnvPath:string}
 * body-example: {"oldDir":"/opt/stacks/old","newComposePath":"/opt/stacks/web/compose.yaml","newEnvPath":"/opt/stacks/web/.env"}
 * resp-200: {success:boolean!, movedFiles:array<string>!, errors:array<string>, composeContent:string!, rawEnvContent:string!, envVars:array<{key:string!, value:string!, isSecret:boolean!}>!}
 * resp-200-example: {"success":true,"movedFiles":["compose.yaml",".env"],"composeContent":"services: {}","rawEnvContent":"FOO=bar\n","envVars":[{"key":"FOO","value":"bar","isSecret":false}]}
 * resp-400: oldDir and newComposePath are required, or the source directory does not exist
 * resp-403: Permission denied (requires stacks:edit), a supplied path is not allowed, or oldDir is not the stack's current directory
 * resp-404: No stack source row for this name and environment
 * resp-500: Failed to relocate stack
 */
export const POST: RequestHandler = async ({ params, request, url, cookies }) => {
	const auth = await authorize(cookies);
	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	if (auth.authEnabled && !(await auth.can('stacks', 'edit', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const envAccessDenied = await auth.requireEnvAccess(envIdNum ?? null);
	if (envAccessDenied) return envAccessDenied;

	try {
		const body = await request.json();
		const { oldDir, newComposePath, newEnvPath } = body;

		if (!oldDir || !newComposePath) {
			return json({ error: 'oldDir and newComposePath are required' }, { status: 400 });
		}

		const newDir = dirname(newComposePath);

		// Every caller-supplied path is read from / written to / deleted below, so
		// they must not reach Dockhand's own secrets (.encryption_key, db/, /proc) through
		// the stack-path guard. Without it stacks:edit could read the master key or
		// /proc/self/environ back through the response.
		for (const p of [oldDir, newComposePath, newDir, newEnvPath].filter(Boolean)) {
			if (isForbiddenStackPath(p)) {
				return json({ error: 'Path is not allowed' }, { status: 403 });
			}
		}
		// Every entry of oldDir is moved into newDir, so neither may hold a protected
		// location (DATA_DIR holds db/ and the key; / holds /proc).
		if (holdsForbiddenStackPath(oldDir) || holdsForbiddenStackPath(newDir)) {
			return json({ error: 'Path is not allowed' }, { status: 403 });
		}

		// Relocate only manages an existing stack's own source row. Reject an unknown
		// stack name up front so this can't be used as a generic move/read primitive
		// against an arbitrary route name.
		const source = await getStackSource(name, envIdNum ?? null);
		if (!source) {
			return json({ error: 'Stack not found' }, { status: 404 });
		}

		// Only this stack's own directory can be moved; the target may be anywhere allowed.
		const currentDir = source.composePath ? dirname(source.composePath) : await findStackDir(name, envIdNum ?? null);
		if (!currentDir || resolve(oldDir) !== resolve(currentDir)) {
			return json({ error: 'oldDir must be the stack\'s current directory' }, { status: 403 });
		}

		// Verify old directory exists
		if (!existsSync(oldDir)) {
			return json({ error: 'Source directory does not exist' }, { status: 400 });
		}

		// Create new directory if it doesn't exist
		if (!existsSync(newDir)) {
			mkdirSync(newDir, { recursive: true });
		}

		const { movedFiles, errors } = moveDirEntries(oldDir, newDir);

		// Remove old directory if it's now empty
		try {
			const remaining = readdirSync(oldDir);
			if (remaining.length === 0) {
				rmSync(oldDir, { recursive: true, force: true });
			}
		} catch {
			// Ignore errors when checking/removing old directory
		}

		// Update database with new paths
		await updateStackSource(name, envIdNum ?? null, {
			composePath: newComposePath,
			envPath: newEnvPath || null
		});

		// Read content from new location
		let composeContent = '';
		let rawEnvContent = '';
		const envVars: { key: string; value: string; isSecret: boolean }[] = [];

		// Read compose file. Guarded again: an entry moved into place can be a link.
		if (existsSync(newComposePath) && !isForbiddenStackPath(newComposePath)) {
			composeContent = readFileSync(newComposePath, 'utf-8');
		}

		// Read env file if it exists. Re-guard the resolved path: when newEnvPath is
		// omitted the fallback is join(newDir, '.env'), which readFileSync would follow
		// through a final symlink - so guard it here too, matching the explicit form.
		const envFilePath = newEnvPath || join(newDir, '.env');
		if (existsSync(envFilePath) && !isForbiddenStackPath(envFilePath)) {
			rawEnvContent = readFileSync(envFilePath, 'utf-8');

			for (const { key, value } of parseEnvFileForForm(rawEnvContent)) {
				envVars.push({ key, value, isSecret: false });
			}
		}

		return json({
			success: true,
			movedFiles,
			errors: errors.length > 0 ? errors : undefined,
			composeContent,
			rawEnvContent,
			envVars
		});
	} catch (error: any) {
		console.error(`Error relocating stack ${name}:`, error);
		return json({ error: error.message || 'Failed to relocate stack' }, { status: 500 });
	}
};
