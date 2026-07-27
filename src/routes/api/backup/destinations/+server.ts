import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { auditBackupDestination } from '$lib/server/audit';
import {
	getBackupDestinations,
	createBackupDestination,
	decryptBackupDestination,
	updateBackupDestination,
	updateBackupDestinationTestStatus
} from '$lib/server/db';
import { initRepository, testRepository } from '$lib/server/backups';
import { registerSchedule } from '$lib/server/scheduler';
import { validateRepositoryForSave, validateFlags, validatePolicySchedules } from '$lib/server/backups/helpers';

/**
 * Prepare destination for API response — strip password, parse env vars.
 *
 * The LIST endpoint omits envVars entirely. Cloud-credential env vars
 * (AWS_SECRET_ACCESS_KEY, AZURE_ACCOUNT_KEY, etc.) used to ship decrypted to
 * any user with backups:view permission, even though the LIST view doesn't
 * need them. The edit modal re-fetches via GET /destinations/[id] (which
 * still returns envVars decrypted so the form can pre-fill credential
 * fields). Single GET is what populates the modal; LIST never needs them.
 */
function prepareDestination(dest: any, opts: { includeEnvVars: boolean }): any {
	const decrypted = decryptBackupDestination(dest);
	const result = { ...dest };
	delete result.password;
	if (opts.includeEnvVars) {
		result.envVars = decrypted.decryptedEnvVars;
	} else {
		delete result.envVars;
	}
	return result;
}

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const destinations = await getBackupDestinations();
	// LIST: strip envVars (cloud creds). Modal re-fetches single destination to edit.
	return json(destinations.map(d => prepareDestination(d, { includeEnvVars: false })));
};

export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('backups', 'manage')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const body = await request.json();

	if (!body.name || !body.repository || !body.password) {
		return json({ error: 'Missing required fields: name, repository, password' }, { status: 400 });
	}

	// Validate repository scheme + SSRF host (audit #7/#53) and restic flags (#7)
	// BEFORE persisting, so nothing is saved on bad input.
	const repoError = validateRepositoryForSave(body.repository);
	if (repoError) return json({ error: repoError }, { status: 400 });
	const flagError = validateFlags(body.flags);
	if (flagError) return json({ error: flagError }, { status: 400 });

	// Validate any cron schedules in the supplied policies (audit #7)
	const policyCronError = validatePolicySchedules(body.policies);
	if (policyCronError) {
		return json({ error: policyCronError }, { status: 400 });
	}

	try {
		// Set default policies if not provided
		const defaultPolicies = JSON.stringify({
			pruneEnabled: true, pruneSchedule: '0 0 1 * *', pruneMaxUnused: '10',
			checkEnabled: true, checkSchedule: '0 0 1 * *',
			verifyEnabled: false, verifySchedule: '0 0 1 * *', verifyDataSubset: '5%',
			autoUnlock: true
		});
		const destination = await createBackupDestination({
			name: body.name,
			repository: body.repository,
			password: body.password,
			envVars: body.envVars ? JSON.stringify(body.envVars) : null,
			flags: body.flags ?? null,
			hostPath: body.hostPath ?? null,
			policies: body.policies ?? defaultPolicies
		});

		// Auto-initialize the repository, then TEST it before recording success.
		// `restic init` succeeds on an already-existing repo without decrypting it,
		// so init alone doesn't prove the stored password is correct. testRepository
		// reads the repo config (which requires the password), so a wrong password
		// against a pre-existing repo is recorded as failed instead of success.
		try {
			await initRepository(destination.id);
			const test = await testRepository(destination.id);
			if (test.ok) {
				await updateBackupDestination(destination.id, {
					lastTestStatus: 'success',
					lastTestAt: new Date().toISOString()
				});
			} else {
				await updateBackupDestinationTestStatus(destination.id, 'failed', test.error ?? 'Repository is not reachable or the password is incorrect');
			}
		} catch (initErr) {
			// Init failed — destination saved but not initialized. Record the
			// failure on the destination so the UI reflects it (audit #9).
			const initMsg = initErr instanceof Error ? initErr.message : String(initErr);
			await updateBackupDestinationTestStatus(destination.id, 'failed', initMsg);
		}

		// Register repo maintenance schedules from default policies
		try {
			await registerSchedule(destination.id, 'repo_prune', null);
			await registerSchedule(destination.id, 'repo_check', null);
			await registerSchedule(destination.id, 'repo_verify', null);
		} catch {}

		await auditBackupDestination(event, 'create', destination.id, destination.name, { repository: body.repository });
		// POST returns envVars — user just provided them, no point re-hiding.
		return json(prepareDestination(destination, { includeEnvVars: true }), { status: 201 });
	} catch (error: any) {
		if (error.message?.includes('UNIQUE constraint')) {
			return json({ error: 'A destination with this name already exists' }, { status: 409 });
		}
		return json({ error: error.message }, { status: 500 });
	}
};
