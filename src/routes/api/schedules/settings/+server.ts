/**
 * Schedule Settings API - Get/set schedule display preferences
 *
 * GET /api/schedules/settings - Get current display settings
 * PUT /api/schedules/settings - Update display settings
 *
 * Note: Data retention settings are now managed in /api/settings/general
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSetting, setSetting } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';

// Setting key for hide system jobs preference
const getHideSystemJobsKey = (userId?: number) =>
	userId ? `user_${userId}_schedules_hide_system_jobs` : 'schedules_hide_system_jobs';

/**
 * @openapi
 * summary: Get the schedules-page display preference (hide system jobs), per-user with a global fallback
 * resp-200: {hideSystemJobs:boolean!}
 * resp-500: Unexpected error while loading the setting
 */
export const GET: RequestHandler = async ({ cookies }) => {
	try {
		const auth = await authorize(cookies);
		const userId = auth.isAuthenticated ? auth.user?.id : undefined;

		// Get user-specific setting, fallback to global
		let hideSystemJobs = await getSetting(getHideSystemJobsKey(userId));
		if (hideSystemJobs === null && userId) {
			hideSystemJobs = await getSetting(getHideSystemJobsKey());
		}
		if (hideSystemJobs === null) {
			hideSystemJobs = false; // Default to visible
		}

		return json({ hideSystemJobs });
	} catch (error: any) {
		console.error('Failed to get schedule settings:', error);
		return json({ error: error.message }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Update the schedules-page display preference (hide system jobs) for the current user
 * body: {hideSystemJobs:boolean}
 * body-example: {"hideSystemJobs":true}
 * resp-200: {success:boolean!, hideSystemJobs:boolean}
 * resp-400: hideSystemJobs is not a boolean
 * resp-500: Unexpected error while saving the setting
 */
export const PUT: RequestHandler = async ({ request, cookies }) => {
	try {
		const auth = await authorize(cookies);
		const userId = auth.isAuthenticated ? auth.user?.id : undefined;

		const body = await request.json();
		const { hideSystemJobs } = body;

		if (hideSystemJobs !== undefined) {
			if (typeof hideSystemJobs !== 'boolean') {
				return json({ error: 'Invalid hideSystemJobs (must be boolean)' }, { status: 400 });
			}
			// Save user-specific preference
			await setSetting(getHideSystemJobsKey(userId), hideSystemJobs);
		}

		return json({ success: true, hideSystemJobs });
	} catch (error: any) {
		console.error('Failed to update schedule settings:', error);
		return json({ error: error.message }, { status: 500 });
	}
};
