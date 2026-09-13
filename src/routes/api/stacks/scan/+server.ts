import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { scanExternalPaths, scanPaths, detectRunningStacks } from '$lib/server/stack-scanner';

/**
 * @openapi
 * summary: Scan a given filesystem path (or all configured external paths when none is given) for compose stacks, flagging which discovered stacks are already running
 * body: {path:string}
 * body-example: {"path":"/opt/stacks"}
 * resp-200: {discovered:array<{name:string!}>!, adopted:array<string>!, skipped:array<string>!, errors:array<{path:string!, error:string!}>!}
 * resp-200-example: {"discovered":[{"name":"web"}],"adopted":[],"skipped":[],"errors":[]}
 * resp-403: Permission denied (requires stacks:create)
 * resp-500: Unexpected error while scanning
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('stacks', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json().catch(() => ({}));
		const { path } = body;

		let result;
		if (path) {
			// Scan a specific path provided by the user
			result = await scanPaths([path]);
		} else {
			// Scan all configured external paths (legacy behavior)
			result = await scanExternalPaths();
		}

		// Detect which stacks are already running on any environment
		const discoveredWithRunning = await detectRunningStacks(result.discovered);
		discoveredWithRunning.sort((a, b) => a.name.localeCompare(b.name));

		return json({
			...result,
			discovered: discoveredWithRunning
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: message }, { status: 500 });
	}
};
