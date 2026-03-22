import { json, type RequestHandler } from '@sveltejs/kit';
import { getUserPreference, setUserPreference } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

// Store all dashboard prefs as a single JSON blob to avoid the chained .where() bug
// in getUserPreference/setUserPreference (chained .where() replaces instead of ANDing)
const DASHBOARD_PREFS_KEY = 'dashboard_prefs';

interface StoredDashboardPrefs {
	gridLayout: any[];
	locked: boolean;
	viewMode: 'grid' | 'list';
}

async function getPrefs(userId: number | null): Promise<StoredDashboardPrefs> {
	const stored = await getUserPreference<StoredDashboardPrefs>({
		userId,
		environmentId: null,
		key: DASHBOARD_PREFS_KEY
	});

	if (stored && typeof stored === 'object' && Array.isArray(stored.gridLayout)) {
		return {
			gridLayout: stored.gridLayout,
			locked: stored.locked ?? false,
			viewMode: stored.viewMode ?? 'grid'
		};
	}

	// Migration: try reading from old dashboard_layout key
	const oldLayout = await getUserPreference<any[]>({
		userId,
		environmentId: null,
		key: 'dashboard_layout'
	});

	return {
		gridLayout: Array.isArray(oldLayout) ? oldLayout : [],
		locked: false,
		viewMode: 'grid'
	};
}

async function savePrefs(userId: number | null, prefs: StoredDashboardPrefs): Promise<void> {
	await setUserPreference(
		{ userId, environmentId: null, key: DASHBOARD_PREFS_KEY },
		prefs
	);
}

export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);

	try {
		const userId = auth.user?.id ?? null;
		const prefs = await getPrefs(userId);
		return json(prefs);
	} catch (error) {
		console.error('Failed to get dashboard preferences:', error);
		return json({ error: 'Failed to get dashboard preferences' }, { status: 500 });
	}
};

export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);

	try {
		const body = await request.json();
		const userId = auth.user?.id ?? null;

		// Load current prefs and merge changes
		const current = await getPrefs(userId);

		if (body.gridLayout && Array.isArray(body.gridLayout)) {
			current.gridLayout = body.gridLayout;
		}
		if (body.locked !== undefined) {
			current.locked = body.locked;
		}
		if (body.viewMode !== undefined) {
			current.viewMode = body.viewMode;
		}

		await savePrefs(userId, current);
		return json(current);
	} catch (error) {
		console.error('Failed to save dashboard preferences:', error);
		return json({ error: 'Failed to save dashboard preferences' }, { status: 500 });
	}
};
