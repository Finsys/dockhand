import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { scanExternalPaths, scanPaths, detectRunningStacks } from '$lib/server/stack-scanner';

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

		return json({
			...result,
			discovered: discoveredWithRunning
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: message }, { status: 500 });
	}
};
