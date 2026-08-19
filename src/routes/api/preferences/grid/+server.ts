import { json, type RequestHandler } from '@sveltejs/kit';
import { getGridPreferences, setGridPreferences, deleteGridPreferences, resetAllGridPreferences } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import type { GridColumnPreferences } from '$lib/types';

// GET - retrieve all grid preferences
/**
 * @openapi
 * summary: Retrieve all saved data-grid column preferences (per-user when auth is enabled)
 * resp-200: {preferences:{}}
 * resp-200-example: {"preferences":{"containers":{"columns":[{"id":"name","visible":true}]}}}
 * resp-500: Failed to get grid preferences
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	try {
		// userId for per-user storage when auth is enabled
		const userId = auth.authEnabled ? auth.user?.id : undefined;
		const preferences = await getGridPreferences(userId);

		return json({ preferences });
	} catch (error) {
		console.error('Failed to get grid preferences:', error);
		return json({ error: 'Failed to get grid preferences' }, { status: 500 });
	}
};

// POST - update grid preferences for a specific grid
/**
 * @openapi
 * summary: Save column preferences for one data grid and return all grid preferences
 * body: {gridId:string!, columns:array<{id:string!, visible:boolean!}>}
 * body-example: {"gridId":"containers","columns":[{"id":"name","visible":true},{"id":"image","visible":false}]}
 * resp-200: {preferences:{}}
 * resp-400: gridId is required, columns array is required, or a column is missing id (string) / visible (boolean)
 * resp-500: Failed to save grid preferences
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	try {
		const body = await request.json();
		const { gridId, columns } = body;

		if (!gridId || typeof gridId !== 'string') {
			return json({ error: 'gridId is required' }, { status: 400 });
		}

		if (!columns || !Array.isArray(columns)) {
			return json({ error: 'columns array is required' }, { status: 400 });
		}

		// Validate column structure
		for (const col of columns) {
			if (typeof col.id !== 'string' || typeof col.visible !== 'boolean') {
				return json({ error: 'Each column must have id (string) and visible (boolean)' }, { status: 400 });
			}
		}

		const prefs: GridColumnPreferences = { columns };

		// userId for per-user storage when auth is enabled
		const userId = auth.authEnabled ? auth.user?.id : undefined;
		await setGridPreferences(gridId, prefs, userId);

		// Return updated preferences
		const preferences = await getGridPreferences(userId);
		return json({ preferences });
	} catch (error) {
		console.error('Failed to save grid preferences:', error);
		return json({ error: 'Failed to save grid preferences' }, { status: 500 });
	}
};

// DELETE - reset grid preferences (single grid or all)
/**
 * @openapi
 * summary: Reset grid preferences — a single grid when gridId is given, otherwise all grids
 * query: gridId:string Grid ID to reset; omit to reset every grid
 * resp-200: {preferences:{}}
 * resp-500: Failed to reset grid preferences
 */
export const DELETE: RequestHandler = async ({ url, cookies }) => {
	const auth = await authorize(cookies);

	try {
		const gridId = url.searchParams.get('gridId');
		const userId = auth.authEnabled ? auth.user?.id : undefined;

		if (gridId) {
			await deleteGridPreferences(gridId, userId);
		} else {
			// Reset all grids
			await resetAllGridPreferences(userId);
		}

		const preferences = await getGridPreferences(userId);
		return json({ preferences });
	} catch (error) {
		console.error('Failed to reset grid preferences:', error);
		return json({ error: 'Failed to reset grid preferences' }, { status: 500 });
	}
};
