import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { getBackupDestination, decryptBackupDestination, updateBackupDestinationTestStatus } from '$lib/server/db';
import { spawn } from 'child_process';
import { buildResticEnv, cleanErrorMsg, isRepoNotInitializedError, RESTIC_EXIT_REPO_NOT_FOUND, validateRepositoryForSave } from '$lib/server/backups/helpers';

/**
 * Test a backup destination configuration.
 * - With `destinationId`: uses saved credentials from DB
 * - Without: uses inline credentials from request body (for testing before save)
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const body = await request.json();

	let repository: string;
	let password: string;
	let envVars: Record<string, string> = {};

	if (body.destinationId) {
		// Use saved destination from DB
		const dest = await getBackupDestination(body.destinationId);
		if (!dest) return json({ error: 'Destination not found' }, { status: 404 });
		const decrypted = decryptBackupDestination(dest);
		repository = dest.repository;
		password = decrypted.decryptedPassword;
		envVars = decrypted.decryptedEnvVars;
	} else {
		// Inline test (before save)
		if (!body.repository || !body.password) {
			return json({ error: 'Repository and password are required' }, { status: 400 });
		}
		// Reject unsupported backends AND SSRF-dangerous hosts (loopback/metadata)
		// before spawning restic — same guard the save path uses, so an inline test
		// can't probe an internal host that a saved destination couldn't reach.
		const repoError = validateRepositoryForSave(body.repository);
		if (repoError) {
			return json({ error: repoError }, { status: 400 });
		}
		repository = body.repository;
		password = body.password;
		if (body.envVars && typeof body.envVars === 'object') {
			for (const [key, value] of Object.entries(body.envVars)) {
				if (typeof value === 'string') envVars[key] = value;
			}
		}
	}

	const env = buildResticEnv(process.env, { repository, password, envVars });

	try {
		const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
			const proc = spawn('restic', ['snapshots', '--json', '--no-lock', '--latest', '1'], { env, timeout: 30000 });
			let stdout = '';
			let stderr = '';
			proc.stdout.on('data', (d) => { stdout += d; });
			proc.stderr.on('data', (d) => { stderr += d; });
			proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
			proc.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }));
		});

		if (result.code === 0) {
			if (body.destinationId) await updateBackupDestinationTestStatus(body.destinationId, 'success');
			return json({ success: true });
		}

		// Detect the repo-not-initialized case (audit #24): restic exits 10, or
		// stderr matches the "no repository" family of messages. Return a distinct,
		// friendlier status so the UI can offer to initialize.
		const rawStderr = result.stderr.trim();
		const notInitialized =
			result.code === RESTIC_EXIT_REPO_NOT_FOUND ||
			isRepoNotInitializedError({ exitCode: result.code }) ||
			/unable to open (config|repository)|Is there a repository/i.test(rawStderr);

		if (notInitialized) {
			if (body.destinationId) await updateBackupDestinationTestStatus(body.destinationId, 'needs_init', 'Repository not initialized');
			return json({ success: false, needsInit: true, error: 'Repository not initialized' });
		}

		// Surface the real restic error (audit #8): derive detail from stderr,
		// cleaned of embedded JSON/ANSI, falling back to the exit code.
		const detail = rawStderr ? cleanErrorMsg(rawStderr) : `restic exited with code ${result.code}`;
		if (body.destinationId) await updateBackupDestinationTestStatus(body.destinationId, 'failed', detail);
		return json({ success: false, error: detail });
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (body.destinationId) await updateBackupDestinationTestStatus(body.destinationId, 'failed', errorMsg);
		return json({ success: false, error: errorMsg });
	}
};
