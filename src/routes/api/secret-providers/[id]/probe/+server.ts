import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecretProviderById, getGitStackByName } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { getProvider } from '$lib/server/secretproviders';
import { UnsupportedOperationError, parseProviderError } from '$lib/server/secretproviders/shared';
import { probeCombinedCached } from '$lib/server/secretproviders/probe-cache';
import { readGitStackEnvFileContent } from '$lib/server/git';
import { isSopsDotenv } from '$lib/server/secretproviders/sops-core';

/**
 * Live probe of a stored provider: given a bulk selector and/or inline op://
 * references, return which KEY NAMES currently exist in the provider. Only names
 * are returned - secret values never leave the server. Powers the editor's live
 * "IN VAULT" marker.
 *
 * @openapi
 * summary: Live-probe which key NAMES exist in a stored provider (names only, values never leave the server)
 * path: id:integer The secret provider id
 * body: {selector:string, refs:array<string>, stack:string, env:integer}
 * body-example: {"selector":"prod","refs":["op://vault/db/password"]}
 * resp-200: {ok:boolean!, bulkKeys:array<string>, resolvedRefs:array<string>, error:string}
 * resp-200-desc: ok=true returns the key names found via the bulk selector and the resolved op:// refs; for a provider that decrypts the stack's env file (SOPS), `stack`+`env` name a git stack and bulkKeys are the names its synced env file decrypts to (needs stacks:view there). ok=false folds a provider error in (still 200) so a slow or auth-gated provider never breaks the editor
 * resp-400: Invalid ID or unknown provider type
 * resp-403: Permission denied (needs secrets:view, and stacks:view for a stack probe)
 * resp-404: Secret provider not found
 */
export const POST: RequestHandler = async ({ params, cookies, request }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !(await auth.can('secrets', 'view'))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const id = Number.parseInt(params.id);
	if (Number.isNaN(id)) {
		return json({ error: 'Invalid secret provider ID' }, { status: 400 });
	}

	const row = await getSecretProviderById(id);
	if (!row) {
		return json({ error: 'Secret provider not found' }, { status: 404 });
	}
	const provider = getProvider(row.type);
	if (!provider) {
		return json({ error: `Unknown secret provider type: ${row.type}` }, { status: 400 });
	}

	let selector: string | undefined;
	let refs: string[] = [];
	let stack: string | undefined;
	let env: number | null = null;
	try {
		const body = await request.json();
		if (typeof body?.selector === 'string' && body.selector.trim()) {
			selector = body.selector.trim();
		}
		if (Array.isArray(body?.refs)) {
			refs = body.refs.filter((r: unknown): r is string => typeof r === 'string' && !!r.trim());
		}
		if (typeof body?.stack === 'string' && body.stack.trim()) stack = body.stack.trim();
		if (Number.isInteger(body?.env)) env = body.env;
	} catch {
		// empty/invalid body: nothing to probe
	}

	// A provider that decrypts the stack's env file (SOPS) has no selector: its keys are
	// what the git stack's synced env file decrypts to, the same call a deploy makes.
	if (provider.decryptEnvFile && stack) {
		if (auth.authEnabled && !(await auth.can('stacks', 'view', env ?? undefined))) {
			return json({ error: 'Permission denied' }, { status: 403 });
		}
		// Same gate as a deploy: only a git stack's configured file that is SOPS-encrypted
		// is decrypted; anything else contributes no keys, as before.
		const none = { ok: true, bulkKeys: [], resolvedRefs: [] };
		const gitStack = await getGitStackByName(stack, env);
		if (!gitStack?.envFilePath) return json(none);
		const read = await readGitStackEnvFileContent(gitStack.id, gitStack.envFilePath);
		if (read.content === undefined) return json({ ok: false, error: read.error });
		if (!isSopsDotenv(read.content)) return json(none);
		try {
			const vars = await provider.decryptEnvFile(row.config, read.content);
			return json({ ok: true, bulkKeys: Object.keys(vars), resolvedRefs: [] });
		} catch (e) {
			return json({ ok: false, error: shortError(e) });
		}
	}

	let bulkKeys: string[] = [];
	let resolvedRefs: string[] = [];

	// Both halves in one call: a CLI provider that can serve them from a single
	// backend session does so, instead of paying a login per half.
	//
	// A provider missing a mode throws UnsupportedOperationError; that is not a
	// failure - it just means that mode contributes no keys. Any other throw
	// (network, bad token, bad path) is a real probe failure.
	try {
		const combined = await probeCombinedCached(id, provider, row.config, selector, refs);
		bulkKeys = combined.bulkKeys;
		resolvedRefs = combined.resolvedRefs;
	} catch (e) {
		if (!(e instanceof UnsupportedOperationError)) {
			return json({ ok: false, error: shortError(e) }, { status: 200 });
		}
	}

	return json({ ok: true, bulkKeys, resolvedRefs });
};

/** A short, non-reflecting error message for the probe-failed UI line. */
function shortError(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	return parseProviderError(raw) ?? raw.slice(0, 200);
}
