import { json, type RequestHandler } from '@sveltejs/kit';
import {
	setScheduleCleanupEnabled,
	setEventCleanupEnabled,
	setScannerCleanupEnabled,
	getScheduleCleanupEnabled,
	getEventCleanupEnabled,
	getScannerCleanupEnabled
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { refreshSystemJobs } from '$lib/server/scheduler';

const SYSTEM_SCHEDULE_CLEANUP_ID = 1;
const SYSTEM_EVENT_CLEANUP_ID = 2;
const SYSTEM_SCANNER_CLEANUP_ID = 4;

export const POST: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const { id } = params;
		const systemId = parseInt(id, 10);

		if (isNaN(systemId)) {
			return json({ error: 'Invalid system schedule ID' }, { status: 400 });
		}

		if (systemId === SYSTEM_SCHEDULE_CLEANUP_ID) {
			const currentEnabled = await getScheduleCleanupEnabled();
			await setScheduleCleanupEnabled(!currentEnabled);
			return json({ success: true, enabled: !currentEnabled });
		} else if (systemId === SYSTEM_EVENT_CLEANUP_ID) {
			const currentEnabled = await getEventCleanupEnabled();
			await setEventCleanupEnabled(!currentEnabled);
			return json({ success: true, enabled: !currentEnabled });
		} else if (systemId === SYSTEM_SCANNER_CLEANUP_ID) {
			const currentEnabled = await getScannerCleanupEnabled();
			await setScannerCleanupEnabled(!currentEnabled);
			await refreshSystemJobs();
			return json({ success: true, enabled: !currentEnabled });
		} else {
			return json({ error: 'Unknown system schedule' }, { status: 400 });
		}
	} catch (error: any) {
		console.error('Failed to toggle system schedule:', error);
		return json({ error: 'Failed to toggle system schedule' }, { status: 500 });
	}
};
