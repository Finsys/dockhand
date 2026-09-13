import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import { requireBackups } from '$lib/server/backups/route-guards';
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
import { validateRepositoryForSave, validateAndSerializeFlags, validatePolicySchedules } from '$lib/server/backups/helpers';

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
	// TLS cert PEMs never reach the client; expose only whether each is set.
	result.hasCacert = !!dest.cacert;
	result.hasTlsClientCert = !!dest.tlsClientCert;
	delete result.cacert;
	delete result.tlsClientCert;
	return result;
}

/**
 * GET /api/backup/destinations - List backup destinations
 *
 * @openapi
 * summary: List all backup destinations (restic repositories); the password is stripped and cloud-credential env vars are omitted from the list view
 * description: Permission denial (403, "backups:view") is produced by the shared requireBackups route guard.
 * resp-200: Array of backup destination objects without secrets (no password, no envVars)
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'view');
	if (denied) return denied;

	const destinations = await getBackupDestinations();
	// LIST: strip envVars (cloud creds). Modal re-fetches single destination to edit.
	return json(destinations.map(d => prepareDestination(d, { includeEnvVars: false })));
};

/**
 * POST /api/backup/destinations - Create a backup destination
 *
 * @openapi
 * summary: Create a restic backup destination, auto-initialize and test the repository, and register its default maintenance schedules
 * description: Permission denial (403, "backups:manage") is produced by the shared requireBackups route guard.
 * body: {name:string!, repository:string!, password:string!, envVars:{}, flags:string, backupFlags:string, restoreFlags:string, hostPath:string, cacert:string, tlsClientCert:string, policies:string}
 * body-example: {"name":"S3 Offsite","repository":"s3:s3.amazonaws.com/my-bucket/restic","password":"***","envVars":{"AWS_ACCESS_KEY_ID":"***","AWS_SECRET_ACCESS_KEY":"***"}}
 * resp-201: The created backup destination object (includes decrypted envVars since the caller just supplied them; password is stripped)
 * resp-400: Invalid input — missing name/repository/password, unsupported/SSRF-blocked repository, invalid restic flags, or an invalid cron schedule in the policies
 * resp-409: A destination with this name already exists
 * resp-500: Failed to create the destination (persistence error)
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	const denied = await requireBackups(auth, 'manage');
	if (denied) return denied;

	const body = await request.json();

	if (!body.name || !body.repository || !body.password) {
		return json({ error: 'Missing required fields: name, repository, password' }, { status: 400 });
	}

	// Validate repository scheme + SSRF host (audit #7/#53) and restic flags (#7)
	// BEFORE persisting, so nothing is saved on bad input.
	const repoError = validateRepositoryForSave(body.repository);
	if (repoError) return json({ error: repoError }, { status: 400 });
	// Flags: prefer the split shape (backupFlags/restoreFlags); fall back to a legacy `flags`
	// string (treated as backup flags). Validate+serialize to the JSON stored in `flags`.
	let flagsColumn: string | null = null;
	try {
		flagsColumn = (body.backupFlags !== undefined || body.restoreFlags !== undefined)
			? validateAndSerializeFlags(body.backupFlags, body.restoreFlags)
			: validateAndSerializeFlags(body.flags, '');
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : 'Invalid restic flags' }, { status: 400 });
	}

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
			flags: flagsColumn,
			hostPath: body.hostPath ?? null,
			cacert: body.cacert || null,
			tlsClientCert: body.tlsClientCert || null,
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
