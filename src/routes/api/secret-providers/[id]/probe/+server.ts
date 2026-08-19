import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSecretProviderById } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { getProvider } from '$lib/server/secretproviders';
import { UnsupportedOperationError, parseProviderError } from '$lib/server/secretproviders/shared';
import { probeBulkKeysCached } from '$lib/server/secretproviders/probe-cache';

/**
 * Live probe of a stored provider: given a bulk selector and/or inline op://
 * references, return which KEY NAMES currently exist in the provider. Only names
 * are returned - secret values never leave the server. Powers the editor's live
 * "IN VAULT" marker.
 *
 * @openapi
 * summary: Live-probe which key NAMES exist in a stored provider (names only, values never leave the server)
 * path: id:integer The secret provider id
 * body: {selector:string, refs:array<string>}
 * body-example: {"selector":"prod","refs":["op://vault/db/password"]}
 * resp-200: {ok:boolean!, bulkKeys:array<string>, resolvedRefs:array<string>, error:string}
 * resp-200-desc: ok=true returns the key names found via the bulk selector and the resolved op:// refs; ok=false folds a provider error in (still 200) so a slow or auth-gated provider never breaks the editor
 * resp-400: Invalid ID or unknown provider type
 * resp-403: Permission denied (needs secrets:view)
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
	try {
		const body = await request.json();
		if (typeof body?.selector === 'string' && body.selector.trim()) {
			selector = body.selector.trim();
		}
		if (Array.isArray(body?.refs)) {
			refs = body.refs.filter((r: unknown): r is string => typeof r === 'string' && !!r.trim());
		}
	} catch {
		// empty/invalid body: nothing to probe
	}

	let bulkKeys: string[] = [];
	let resolvedRefs: string[] = [];

	// A provider missing a mode throws UnsupportedOperationError; that is not a
	// failure - it just means that mode contributes no keys. Any other throw
	// (network, bad token, bad path) is a real probe failure.
	if (selector && provider.supportsBulk) {
		try {
			bulkKeys = await probeBulkKeysCached(id, provider, row.config, selector);
		} catch (e) {
			if (!(e instanceof UnsupportedOperationError)) {
				return json({ ok: false, error: shortError(e) }, { status: 200 });
			}
		}
	}

	if (refs.length && provider.supportsReferences) {
		try {
			const resolved = await provider.resolveSecretReferences(row.config, refs);
			resolvedRefs = [...resolved.keys()];
		} catch (e) {
			if (!(e instanceof UnsupportedOperationError)) {
				return json({ ok: false, error: shortError(e) }, { status: 200 });
			}
		}
	}

	return json({ ok: true, bulkKeys, resolvedRefs });
};

/** A short, non-reflecting error message for the probe-failed UI line. */
function shortError(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	return parseProviderError(raw) ?? raw.slice(0, 200);
}
