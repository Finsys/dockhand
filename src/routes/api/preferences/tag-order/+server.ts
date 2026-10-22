import { json, type RequestHandler } from '@sveltejs/kit';
import { getTagOrder, setTagOrder, deleteTagOrder } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

/** Per-user when auth is on, app-wide when it is off - same as the sidebar's. */
async function ownerId(cookies: Parameters<RequestHandler>[0]['cookies']) {
	const auth = await authorize(cookies);
	return auth.authEnabled ? auth.user?.id : undefined;
}

/**
 * @openapi
 * summary: Retrieve the saved tag order (tag ids, most preferred first)
 * resp-200: {order:array<integer>}
 * resp-200-example: {"order":[3,1,2]}
 * resp-500: Failed to get the tag order
 */
export const GET: RequestHandler = async ({ cookies }) => {
	try {
		return json({ order: await getTagOrder(await ownerId(cookies)) });
	} catch (error) {
		console.error('Failed to get tag order:', error);
		return json({ error: 'Failed to get the tag order' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Save the tag order
 * description: The tag catalogue is shared, but the order is each user's own, so saving never changes anyone else's lists.
 * body: {order:array<integer>!}
 * body-example: {"order":[3,1,2]}
 * resp-200: {order:array<integer>}
 * resp-400: order must be an array of tag ids, or it repeats an id
 * resp-500: Failed to save the tag order
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	try {
		const { order } = await request.json();
		if (!Array.isArray(order) || order.some((id) => !Number.isInteger(id))) {
			return json({ error: 'order must be an array of tag ids' }, { status: 400 });
		}
		// A repeated id would put one tag in a keyed list twice, which throws on render.
		if (new Set(order).size !== order.length) {
			return json({ error: 'order must not repeat a tag id' }, { status: 400 });
		}

		const userId = await ownerId(cookies);
		await setTagOrder(order, userId);
		return json({ order: await getTagOrder(userId) });
	} catch (error) {
		console.error('Failed to save tag order:', error);
		return json({ error: 'Failed to save the tag order' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Reset the tag order back to the default (by name)
 * resp-200: {order:array<integer>}
 * resp-500: Failed to reset the tag order
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	try {
		const userId = await ownerId(cookies);
		await deleteTagOrder(userId);
		return json({ order: await getTagOrder(userId) });
	} catch (error) {
		console.error('Failed to reset tag order:', error);
		return json({ error: 'Failed to reset the tag order' }, { status: 500 });
	}
};
