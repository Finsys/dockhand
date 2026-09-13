import { json, type RequestHandler } from '@sveltejs/kit';
import { getSidebarPreferences, setSidebarPreferences, deleteSidebarPreferences } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import type { SidebarPreferences } from '$lib/server/db';

// GET - retrieve sidebar menu preferences
/**
 * @openapi
 * summary: Retrieve the saved sidebar menu preferences (order and hidden items)
 * resp-200: {preferences:{order:array<string>, hidden:array<string>}}
 * resp-200-example: {"preferences":{"order":["dashboard","containers"],"hidden":["volumes"]}}
 * resp-500: Failed to get sidebar preferences
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	try {
		// userId for per-user storage when auth is enabled
		const userId = auth.authEnabled ? auth.user?.id : undefined;
		const preferences = await getSidebarPreferences(userId);

		return json({ preferences });
	} catch (error) {
		console.error('Failed to get sidebar preferences:', error);
		return json({ error: 'Failed to get sidebar preferences' }, { status: 500 });
	}
};

// POST - update sidebar menu preferences
/**
 * @openapi
 * summary: Save the sidebar menu preferences (order and hidden items)
 * body: {order:array<string>!, hidden:array<string>!}
 * body-example: {"order":["dashboard","containers","stacks"],"hidden":["volumes"]}
 * resp-200: {preferences:{order:array<string>, hidden:array<string>}}
 * resp-400: order must be an array of strings, or hidden must be an array of strings
 * resp-500: Failed to save sidebar preferences
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	try {
		const body = await request.json();
		const { order, hidden } = body;

		if (!Array.isArray(order) || order.some((h) => typeof h !== 'string')) {
			return json({ error: 'order must be an array of strings' }, { status: 400 });
		}

		if (!Array.isArray(hidden) || hidden.some((h) => typeof h !== 'string')) {
			return json({ error: 'hidden must be an array of strings' }, { status: 400 });
		}

		const prefs: SidebarPreferences = { order, hidden };

		// userId for per-user storage when auth is enabled
		const userId = auth.authEnabled ? auth.user?.id : undefined;
		await setSidebarPreferences(prefs, userId);

		const preferences = await getSidebarPreferences(userId);
		return json({ preferences });
	} catch (error) {
		console.error('Failed to save sidebar preferences:', error);
		return json({ error: 'Failed to save sidebar preferences' }, { status: 500 });
	}
};

// DELETE - reset sidebar menu preferences to default
/**
 * @openapi
 * summary: Reset the sidebar menu preferences to their default order/visibility
 * resp-200: {preferences:{order:array<string>, hidden:array<string>}}
 * resp-500: Failed to reset sidebar preferences
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	try {
		const userId = auth.authEnabled ? auth.user?.id : undefined;
		await deleteSidebarPreferences(userId);

		const preferences = await getSidebarPreferences(userId);
		return json({ preferences });
	} catch (error) {
		console.error('Failed to reset sidebar preferences:', error);
		return json({ error: 'Failed to reset sidebar preferences' }, { status: 500 });
	}
};
