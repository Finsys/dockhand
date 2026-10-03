import { json } from '@sveltejs/kit';
import { findStackDir, getStackDir, withStackLock } from '$lib/server/stacks';
import { getStackSource, getSecretKeysToMask } from '$lib/server/db';
import { parseEnvParam } from '$lib/server/env-param';
import { saveStackVersion } from '$lib/server/stack-version-wiring';
import { readStackSourcePointer, upsertStackSourcePointer } from '$lib/server/stack-source-pointers';
import { authorize } from '$lib/server/authorize';
import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { RequestHandler } from './$types';

/**
 * GET /api/stacks/[name]/env/raw?env=X
 *
 * @openapi
 * summary: Get the raw .env file content as-is (comments and formatting preserved) for a stack
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * resp-200: {content:string!, noEnvFile:boolean}
 * resp-200-example: {"content":"FOO=bar\n# comment\nBAZ=qux\n"}
 * resp-403: Permission denied (requires stacks:view, or environment access denied on enterprise)
 * resp-500: Failed to get environment file
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);
	// ?env= is validated as an actual integer or null (parseEnvParam) - never NaN
	// (PR #1548 review point 12, same hardening as the history route).
	const envIdNum = parseEnvParam(url.searchParams.get('env'));

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'view', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		// params.name is already URI-decoded by SvelteKit; do NOT decode it a
		// second time (PR #1548 review point 4, same hardening as the history
		// route) - use it as-is.
		const stackName = params.name;

		// Check if this stack has custom paths configured
		const source = await getStackSource(stackName, envIdNum);

		// Determine the env file path based on path resolution rules:
		// - envPath = '' (empty string) → explicitly no env file
		// - envPath = '/path/.env' → use custom path
		// - envPath = null with composePath → suggest .env next to compose
		// - envPath = null without composePath → use default location
		let envFilePath: string | null = null;

		if (source?.envPath === '') {
			// Empty string = explicitly no env file
			return json({ content: '', noEnvFile: true });
		} else if (source?.envPath) {
			// Custom env path specified
			envFilePath = source.envPath;
		} else if (source?.composePath) {
			// Custom compose path but no env path - suggest .env next to compose
			envFilePath = join(dirname(source.composePath), '.env');
		} else {
			// Default location - .env in stack directory
			const stackDir = await findStackDir(stackName, envIdNum);
			if (stackDir) {
				envFilePath = join(stackDir, '.env');
			}
		}

		let content = '';
		if (envFilePath && existsSync(envFilePath)) {
			try {
				content = readFileSync(envFilePath, 'utf-8');
			} catch {
				// File read failed
			}
		}

		return json({ content });
	} catch (error) {
		console.error('Error getting raw env file:', error);
		return json({ error: 'Failed to get environment file' }, { status: 500 });
	}
};

/**
 * PUT /api/stacks/[name]/env/raw?env=X
 *
 * @openapi
 * summary: Write raw .env file content to disk for a stack; empty content deletes the .env file, and masked "***" placeholders are rejected to avoid corrupting secrets
 * path: name:string! Stack name (from GET /api/stacks)
 * query: env:integer Environment ID the stack belongs to (from GET /api/environments)
 * body: {content:string!}
 * body-example: {"content":"FOO=bar\nBAZ=qux\n"}
 * resp-200: {success:boolean!, noEnvFile:boolean, deleted:boolean}
 * resp-200-example: {"success":true}
 * resp-400: Invalid body (content string required) or refusal to write a masked "***" placeholder
 * resp-403: Permission denied (requires stacks:edit, or environment access denied on enterprise)
 * resp-500: Failed to save environment file
 */
export const PUT: RequestHandler = async ({ params, url, cookies, request }) => {
	const auth = await authorize(cookies);
	// ?env= is validated as an actual integer or null (parseEnvParam) - never NaN
	// (PR #1548 review point 12, same hardening as the history route).
	const envIdNum = parseEnvParam(url.searchParams.get('env'));

	// Permission check with environment context
	if (auth.authEnabled && !await auth.can('stacks', 'edit', envIdNum ?? undefined)) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	// Environment access check (enterprise only)
	if (envIdNum && auth.isEnterprise && !await auth.canAccessEnvironment(envIdNum)) {
		return json({ error: 'Access denied to this environment' }, { status: 403 });
	}

	try {
		// params.name is already URI-decoded by SvelteKit; do NOT decode it a
		// second time (PR #1548 review point 4, same hardening as the history
		// route) - use it as-is.
		const stackName = params.name;
		const body = await request.json();

		if (typeof body.content !== 'string') {
			return json({ error: 'Invalid request body: content string required' }, { status: 400 });
		}

		// Check if this stack has custom paths configured
		const source = await getStackSource(stackName, envIdNum);

		// PR #1548 point 7: resolve the stack dir ONCE - findStackDir (the EXISTING
		// stack dir - custom / adopted layouts included) with getStackDir as
		// fallback - and REUSE that single resolution for both the live .env path
		// (default location, below) and the version record, so the .history/ dir
		// always sits next to the .env file that is actually written, consistently
		// with writeRawStackEnvFile.
		const stackDir =
			(await findStackDir(stackName, envIdNum)) || (await getStackDir(stackName, envIdNum));

		// Determine the env file path based on path resolution rules:
		// - envPath = '' (empty string) → explicitly no env file, don't write
		// - envPath = '/path/.env' → use custom path
		// - envPath = null with composePath → suggest .env next to compose
		// - envPath = null without composePath → .env in the resolved stack dir
		let envFilePath: string;

		if (source?.envPath === '') {
			// Empty string = explicitly no env file - don't allow writes
			return json({ success: true, noEnvFile: true });
		} else if (source?.envPath) {
			// Custom env path specified
			envFilePath = source.envPath;
		} else if (source?.composePath) {
			// Custom compose path but no env path - suggest .env next to compose
			envFilePath = join(dirname(source.composePath), '.env');
		} else {
			// Default location - .env in the single resolved stack dir above.
			envFilePath = join(stackDir, '.env');
		}

		let content = body.content;

		// If content is empty, delete the .env file instead of writing empty file
		if (!content || !content.trim()) {
			if (existsSync(envFilePath)) {
				rmSync(envFilePath);
				return json({ success: true, deleted: true });
			}
			return json({ success: true });
		}

		// Guard against writing masked secret placeholders (would corrupt the file)
		if (content.match(/^[A-Za-z_][A-Za-z0-9_]*=\*\*\*$/m)) {
			return json({
				error: 'Cannot write masked placeholder "***" to .env file - this would corrupt secret values'
			}, { status: 400 });
		}

		// Ensure content ends with newline
		if (!content.endsWith('\n')) {
			content += '\n';
		}

		if (source?.sourceType !== 'git') {
			// S05 + PR #1548 point 8: for internal/adopted stacks the .env file is
			// written EXACTLY ONCE - by the in-lock atomic write inside saveStackVersion
			// (the versioned save owns the live file). The old leading unlocked
			// writeFileSync here double-wrote the file and could leave the unlocked
			// copy as the final state. The write and the version record are now
			// all-or-nothing under the per-stack lock: a failure throws to the
			// handler catch (500) and leaves NO partial file (atomic rename) and no
			// orphan version - the same contract writeRawStackEnvFile has had since S03.
			// stackDir is the single resolution from above (PR #1548 point 7).
			// Mask the COMPLETE secret set (DB isSecret UNION provider-injected keys) -
			// getStackInjectedSecretKeys alone would let DB-stored secrets into the
			// version file (PR #1548 review point 1).
			const secretKeys = [...(await getSecretKeysToMask(stackName, envIdNum))];
			await withStackLock(stackName, async () => {
				// Read the pointer INSIDE the lock (PR #1548 point 10).
				const pointer = await readStackSourcePointer(stackName, envIdNum);
				await saveStackVersion({
					stackDir,
					livePath: envFilePath,
					type: 'env',
					content,
					secretKeys,
					lastDeployedAt: pointer?.lastDeployedAt ?? null,
					advancePointer: (values) => upsertStackSourcePointer(stackName, envIdNum, values)
				});
			});
		} else {
			// GIT stacks: the DB is the live env source (versions are recorded via
			// PUT /env), so the plain unlocked write is the ONLY write to this file.
			writeFileSync(envFilePath, content);
		}

		return json({ success: true });
	} catch (error) {
		console.error('Error saving raw env file:', error);
		return json({ error: 'Failed to save environment file' }, { status: 500 });
	}
};
