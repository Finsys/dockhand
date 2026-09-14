import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { authorize } from '$lib/server/authorize';
import { getStackEnvVars, setStackEnvVars, getStackSource, getStackInjectedSecretKeys } from '$lib/server/db';
import { getStackDir, getStackContainers, revertStackVersion, saveStackComposeFile, writeRawStackEnvFile } from '$lib/server/stacks';
import { saveStackVersion, computeRevertedEnvVars, serializeEnvVars, parseEnvVars } from '$lib/server/stack-version-wiring';
import { upsertStackSourcePointer, readStackSourcePointer } from '$lib/server/stack-source-pointers';
import { listVersions, versionContentEquals, filterSecretVars } from '$lib/server/stack-versions';

/**
 * GET /api/stacks/[name]/history?env=X&type=compose|env
 *
 * List a stack's bounded, secret-free saved versions (compose or env) newest-first,
 * together with the `stack_sources` last_saved_at / last_deployed_at pointers so a
 * client can show a saved-vs-deployed indicator. An empty version list is a 200 with
 * `versions: []` (never a 404 — a stack with no saved versions is a valid state).
 *
 * Also returns `currentVersionId`: the id of the NEWEST version whose content equals
 * the live source for `type` right now (secret-free basis), or null when nothing
 * matches (e.g. the live source is missing). The shared last_saved_at pointer cannot
 * identify this per type (one column serves both compose and env), so it is computed
 * here from the live content. The panel uses it to mark the version the editor
 * currently displays.
 */

/**
 * Read the live source for a version type in its STORED form (compose: raw YAML
 * string; env: secret-free Record<string,string>), or undefined when the live
 * source is missing (env: no .env file). Path resolution mirrors the save/revert
 * paths: source.composePath / source.envPath, else the internal defaults.
 */
async function readLiveContentForType(
	type: 'compose' | 'env',
	stackName: string,
	envId: number | null,
	stackDir: string
): Promise<string | Record<string, string> | undefined> {
	const source = await getStackSource(stackName, envId);
	if (type === 'compose') {
		const composePath = source?.composePath || join(stackDir, 'compose.yaml');
		if (!existsSync(composePath)) return undefined;
		return readFileSync(composePath, 'utf8');
	}
	// type === 'env'
	if (source?.sourceType === 'git') {
		// GIT env: the DB is the live source; non-secret vars only (versions are
		// secret-free, so the comparison basis must be too).
		const vars = await getStackEnvVars(stackName, envId, false);
		const record: Record<string, string> = {};
		for (const v of vars) {
			if (!v.isSecret) record[v.key] = v.value;
		}
		return record;
	}
	// internal / adopted: the live .env file (same resolution as the revert path).
	const envPath =
		source?.envPath ||
		(source?.composePath ? join(dirname(source.composePath), '.env') : join(stackDir, '.env'));
	if (!existsSync(envPath)) return undefined;
	const parsed = parseEnvVars(readFileSync(envPath, 'utf8'));
	return filterSecretVars(parsed, [...(await getStackInjectedSecretKeys(stackName, envId))]);
}
/**
 * @openapi
 * summary: List a stack's saved versions (compose or env) with saved/deployed pointers
 * description: Returns the bounded, secret-free version list for `type` (compose or env, defaults to compose) newest-first, plus the stack_sources last_saved_at / last_deployed_at pointers so a client can show a saved-vs-deployed indicator. versions are {id, timestamp}; the pointers are ISO-8601 strings or null (never saved / never deployed).
 * path: name:string The stack name
 * query: env:integer Environment id the stack belongs to
 * query: type:string Version kind to list (compose or env); defaults to compose
 * resp-200: {type:string!, versions:array<{id:string!, timestamp:string!}>!, lastSavedAt:string, lastDeployedAt:string, currentVersionId:string, deployStartedAt:string}
 * resp-400: Invalid type (must be compose or env)
 * resp-403: Permission denied (needs stacks:view)
 * resp-500: Failed to read versions
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	const env = url.searchParams.get('env');
	const envIdNum = env ? parseInt(env) : null;
	const type = url.searchParams.get('type') ?? 'compose';

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	// `type` must be one of the two version kinds (it defaults to 'compose' above).
	if (type !== 'compose' && type !== 'env') {
		return json({ error: 'Invalid type' }, { status: 400 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		const stackDir = await getStackDir(stackName, envIdNum ?? null);
		const versions = listVersions(stackDir, type);
		const pointer = await readStackSourcePointer(stackName, envIdNum ?? null);

		// External-deploy detection (read-only): when the stack has running containers,
		// report the OLDEST running container's creation time as `deployStartedAt`.
		// The panel uses it as the deployed-version reference when the
		// last_deployed_at pointer is null (the stack was deployed outside Dockhand —
		// docker CLI, `docker compose up` — so no pointer exists). `created` is epoch
		// seconds; restarts preserve it (content = deploy-time content), re-creates
		// update it. Null when no container is running.
		let deployStartedAt: string | null = null;
		const runningContainers = (await getStackContainers(stackName, envIdNum ?? null)).filter(
			(c) => c.state === 'running'
		);
		if (runningContainers.length > 0) {
			const oldest = Math.min(...runningContainers.map((c) => c.created));
			deployStartedAt = new Date(oldest * 1000).toISOString();
		}

		// The version whose content is live right now (secret-free basis): match the
		// live content against the versions (newest-first -> .find yields the NEWEST
		// match, the single representative after cross-list dedup). A missing live
		// source or no match -> null (the panel falls back to the pointer match).
		let currentVersionId: string | null = null;
		if (versions.length > 0) {
			const live = await readLiveContentForType(type, stackName, envIdNum ?? null, stackDir);
			if (live !== undefined) {
				currentVersionId = versions.find((v) => versionContentEquals(v.content, live))?.id ?? null;
			}
		}

		return json({
			type,
			versions: versions.map((v) => ({ id: v.id, timestamp: v.timestamp })),
			lastSavedAt: pointer?.lastSavedAt ?? null,
			lastDeployedAt: pointer?.lastDeployedAt ?? null,
			currentVersionId,
			deployStartedAt
		});
	} catch (error) {
		console.error('Error reading stack versions:', error);
		return json({ error: 'Failed to read versions' }, { status: 500 });
	}
};

/**
 * POST /api/stacks/[name]/history?env=X
 *
 * Save a new stack version or revert to a past version.
 * Body: { action: 'save' | 'revert', type: 'compose' | 'env', content?: string, versionId?: string }.
 *
 * - `action=save` persists `content` (compose YAML for type=compose; KEY=VALUE .env text
 *   for type=env) as a new bounded secret-free version and advances last_saved_at.
 * - `action=revert` restores the version with `versionId` to the live source and advances
 *   last_saved_at.
 *
 * Secrets are never written to a version: for a GIT stack the DB is the live env source
 * (existing secrets are preserved via a non-destructive merge), and for an internal /
 * adopted stack the raw .env file is written via the S03 versioned + locked path.
 */
/**
 * @openapi
 * summary: Save a new stack version or revert to a past version
 * description: action=save persists `content` (compose YAML for type=compose; KEY=VALUE .env text for type=env) as a new bounded secret-free version and advances last_saved_at; action=revert restores the version with `versionId` to the live source (internal compose.yaml, or the env .env file for internal stacks / the DB non-secret subset for GIT stacks with existing secrets preserved) and advances last_saved_at. Secrets are never written to a version.
 * path: name:string The stack name
 * query: env:integer Environment id the stack belongs to
 * body: {action:string!, type:string!, content:string, versionId:string}
 * body-example: {"action":"revert","type":"compose","versionId":"abc123"}
 * resp-200: {success:boolean!, timestamp:string}
 * resp-400: Invalid action, type, or missing content/versionId
 * resp-403: Permission denied (needs stacks:edit)
 * resp-404: Revert target version not found
 * resp-500: Failed to save or revert
 */
export const POST: RequestHandler = async ({ params, url, cookies, request }) => {
	const auth = await authorize(cookies);
	const env = url.searchParams.get('env');
	const envIdNum = env ? parseInt(env) : null;

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'edit', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		const stackName = decodeURIComponent(params.name);
		const body = await request.json();
		const { action, type, content, versionId } = body;

		// `action` must be 'save' or 'revert'; `type` must be 'compose' or 'env'.
		if ((action !== 'save' && action !== 'revert') || (type !== 'compose' && type !== 'env')) {
			return json({ error: 'Invalid action or type' }, { status: 400 });
		}

		if (action === 'revert') {
			// Reverting requires the target version id.
			if (typeof versionId !== 'string' || !versionId) {
				return json({ error: 'versionId is required for revert' }, { status: 400 });
			}
			const r = await revertStackVersion(stackName, envIdNum ?? null, type, versionId);
			if (!r.success) {
				// The version id does not exist in this stack's bounded history.
				return json({ error: r.error ?? 'Version not found' }, { status: 404 });
			}
			return json({ success: true, timestamp: r.timestamp });
		}

		// action === 'save'
		if (typeof content !== 'string' || !content) {
			return json({ error: 'content is required for save' }, { status: 400 });
		}

		if (type === 'compose') {
			const r = await saveStackComposeFile(stackName, content, false, envIdNum ?? null, {});
			if (!r.success) {
				return json({ error: r.error }, { status: 500 });
			}
		} else {
			// type === 'env'
			const source = await getStackSource(stackName, envIdNum ?? null);
			if (source?.sourceType === 'git') {
				// GIT stack: the DB is the live env source. Merge the submitted non-secret
				// vars over the current vars so existing secrets are PRESERVED (a secret key
				// cannot appear in the secret-free parsed record, so every current secret
				// survives). setStackEnvVars deletes-then-inserts the (stack, env) row.
				const parsed = parseEnvVars(content);
				const currentVars = await getStackEnvVars(stackName, envIdNum ?? null, false);
				const merged = computeRevertedEnvVars(currentVars, parsed);
				await setStackEnvVars(stackName, envIdNum ?? null, merged);

				// Best-effort: record a secret-free env version + advance last_saved_at.
				// A version-record failure must NOT fail the env save that already succeeded.
				try {
					const stackDir = await getStackDir(stackName, envIdNum ?? null);
					const secretKeys = [...await getStackInjectedSecretKeys(stackName, envIdNum ?? null)];
					const pointer = await readStackSourcePointer(stackName, envIdNum ?? null);
					await saveStackVersion({
						stackDir,
						type: 'env',
						content: serializeEnvVars(parsed),
						secretKeys,
						lastDeployedAt: pointer?.lastDeployedAt ?? null,
						advancePointer: (v) => upsertStackSourcePointer(stackName, envIdNum ?? null, v)
					});
				} catch (err) {
					console.warn('[history] Failed to record env version:', err);
				}
			} else {
				// internal / adopted: write the raw .env file (versioned + locked by S03).
				await writeRawStackEnvFile(stackName, content, envIdNum ?? null);
			}
		}

		return json({ success: true });
	} catch (error) {
		console.error('Error saving or reverting stack version:', error);
		return json({ error: 'Failed to save or revert' }, { status: 500 });
	}
};
