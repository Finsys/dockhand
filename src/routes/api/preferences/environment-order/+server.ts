import { json, type RequestHandler } from '@sveltejs/kit';
import { getEnvironmentOrder, setEnvironmentOrder, deleteEnvironmentOrder } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

/** Per-user when auth is on, app-wide when it is off - same as the sidebar's. */
async function ownerId(cookies: Parameters<RequestHandler>[0]['cookies']) {
	const auth = await authorize(cookies);
	return auth.authEnabled ? auth.user?.id : undefined;
}

/**
 * @openapi
 * summary: Retrieve the saved environment order (environment ids, most preferred first)
 * resp-200: {order:array<integer>}
 * resp-200-example: {"order":[3,1,2]}
 * resp-500: Failed to get the environment order
 */
export const GET: RequestHandler = async ({ cookies }) => {
	try {
		return json({ order: await getEnvironmentOrder(await ownerId(cookies)) });
	} catch (error) {
		console.error('Failed to get environment order:', error);
		return json({ error: 'Failed to get the environment order' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Save the environment order
 * description: Ids the caller cannot see are simply absent from their list; each user has their own order, so saving never affects anyone else's.
 * body: {order:array<integer>!}
 * body-example: {"order":[3,1,2]}
 * resp-200: {order:array<integer>}
 * resp-400: order must be an array of environment ids
 * resp-500: Failed to save the environment order
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	try {
		const { order } = await request.json();
		if (!Array.isArray(order) || order.some((id) => !Number.isInteger(id))) {
			return json({ error: 'order must be an array of environment ids' }, { status: 400 });
		}
		if (new Set(order).size !== order.length) {
			return json({ error: 'order must not repeat an environment id' }, { status: 400 });
		}

		const userId = await ownerId(cookies);
		await setEnvironmentOrder(order, userId);
		return json({ order: await getEnvironmentOrder(userId) });
	} catch (error) {
		console.error('Failed to save environment order:', error);
		return json({ error: 'Failed to save the environment order' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Reset the environment order back to the default (by name)
 * resp-200: {order:array<integer>}
 * resp-500: Failed to reset the environment order
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	try {
		const userId = await ownerId(cookies);
		await deleteEnvironmentOrder(userId);
		return json({ order: await getEnvironmentOrder(userId) });
	} catch (error) {
		console.error('Failed to reset environment order:', error);
		return json({ error: 'Failed to reset the environment order' }, { status: 500 });
	}
};
