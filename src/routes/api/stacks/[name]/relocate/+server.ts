import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getStackSource, updateStackSource } from '$lib/server/db';
import { existsSync, readdirSync, renameSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * POST /api/stacks/[name]/relocate
 *
 * Move all stack files from old directory to new location.
 * Updates the database with new paths and returns refreshed content.
 */
export const POST: RequestHandler = async ({ params, request, url, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('stacks', 'edit'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const { name } = params;
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	try {
		const body = await request.json();
		const { oldDir, newComposePath, newEnvPath } = body;

		if (!oldDir || !newComposePath) {
			return json({ error: 'oldDir and newComposePath are required' }, { status: 400 });
		}

		const newDir = dirname(newComposePath);

		// Verify old directory exists
		if (!existsSync(oldDir)) {
			return json({ error: 'Source directory does not exist' }, { status: 400 });
		}

		// Create new directory if it doesn't exist
		if (!existsSync(newDir)) {
			mkdirSync(newDir, { recursive: true });
		}

		// Move all files from old directory to new directory
		const files = readdirSync(oldDir);
		const movedFiles: string[] = [];
		const errors: string[] = [];

		for (const file of files) {
			const oldFilePath = join(oldDir, file);
			const newFilePath = join(newDir, file);

			try {
				// Use rename for atomic move (same filesystem) or copy+delete for cross-filesystem
				renameSync(oldFilePath, newFilePath);
				movedFiles.push(file);
			} catch (renameErr: any) {
				if (renameErr.code === 'EXDEV') {
					// Cross-filesystem move - copy then delete
					try {
						const data = readFileSync(oldFilePath);
						writeFileSync(newFilePath, data);
						unlinkSync(oldFilePath);
						movedFiles.push(file);
					} catch (copyErr: any) {
						errors.push(`Failed to copy ${file}: ${copyErr.message}`);
					}
				} else {
					errors.push(`Failed to move ${file}: ${renameErr.message}`);
				}
			}
		}

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

		// Read compose file
		if (existsSync(newComposePath)) {
			composeContent = readFileSync(newComposePath, 'utf-8');
		}

		// Read env file if it exists
		const envFilePath = newEnvPath || join(newDir, '.env');
		if (existsSync(envFilePath)) {
			rawEnvContent = readFileSync(envFilePath, 'utf-8');

			// Parse env vars from raw content
			const lines = rawEnvContent.split('\n');
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;
				const eqIndex = trimmed.indexOf('=');
				if (eqIndex > 0) {
					const key = trimmed.substring(0, eqIndex);
					const value = trimmed.substring(eqIndex + 1);
					envVars.push({ key, value, isSecret: false });
				}
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
