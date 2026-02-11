import { json, type RequestHandler } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { adoptSelectedStacks, type DiscoveredStack } from '$lib/server/stack-scanner';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('stacks', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const stacks = body.stacks as DiscoveredStack[];
		const environmentId = body.environmentId as number | undefined;

		if (!stacks || !Array.isArray(stacks) || stacks.length === 0) {
			return json({ error: 'No stacks provided' }, { status: 400 });
		}

		if (!environmentId || typeof environmentId !== 'number') {
			return json({ error: 'Environment ID is required' }, { status: 400 });
		}

		// Validate each stack has required fields
		for (const stack of stacks) {
			if (!stack.name || !stack.composePath) {
				return json({ error: 'Invalid stack data: missing name or composePath' }, { status: 400 });
			}
		}

		const result = await adoptSelectedStacks(stacks, environmentId);

		return json({
			adopted: result.adopted,
			failed: result.failed
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return json({ error: message }, { status: 500 });
	}
};
