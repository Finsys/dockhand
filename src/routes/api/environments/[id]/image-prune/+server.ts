import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getImagePruneSettings,
	setImagePruneSettings,
	getEnvironment
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule, triggerImagePrune } from '$lib/server/scheduler';

/**
 * Get image prune settings for an environment.
 *
 * @openapi
 * summary: Get the automatic image-prune schedule settings for an environment
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: {settings:{enabled:boolean!, cronExpression:string!, pruneMode:string!}!}
 * resp-200-example: {"settings":{"enabled":false,"cronExpression":"0 3 * * 0","pruneMode":"dangling"}}
 * resp-403: Permission denied (RBAC 'environments:view' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while loading the settings
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);

		// Verify environment exists
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const settings = await getImagePruneSettings(id);

		return json({
			settings: settings || {
				enabled: false,
				cronExpression: '0 3 * * 0', // Default: 3 AM Sunday
				pruneMode: 'dangling'
			}
		});
	} catch (error) {
		console.error('Failed to get image prune settings:', error);
		return json({ error: 'Failed to get image prune settings' }, { status: 500 });
	}
};

/**
 * Save image prune settings for an environment.
 *
 * @openapi
 * summary: Save the automatic image-prune schedule for an environment (registers/unregisters the croner job)
 * path: id:integer! Environment id (from GET /api/environments)
 * body: {enabled:boolean, cronExpression:string, pruneMode:string}
 * body-example: {"enabled":true,"cronExpression":"0 3 * * 0","pruneMode":"dangling"}
 * resp-200: {success:boolean!, settings:{enabled:boolean!, cronExpression:string!, pruneMode:string!}!}
 * resp-403: Permission denied (RBAC 'environments:edit' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while saving the settings
 */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);

		// Verify environment exists
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const data = await request.json();

		// Get existing settings to preserve lastPruned and lastResult
		const existingSettings = await getImagePruneSettings(id);

		const settings = {
			enabled: data.enabled ?? false,
			cronExpression: data.cronExpression || '0 3 * * 0',
			pruneMode: data.pruneMode || 'dangling',
			lastPruned: existingSettings?.lastPruned,
			lastResult: existingSettings?.lastResult
		};

		// Save settings to database
		await setImagePruneSettings(id, settings);

		// Register or unregister schedule based on enabled state
		if (settings.enabled) {
			await registerSchedule(id, 'image_prune', id);
		} else {
			unregisterSchedule(id, 'image_prune');
		}

		return json({ success: true, settings });
	} catch (error) {
		console.error('Failed to save image prune settings:', error);
		return json({ error: 'Failed to save image prune settings' }, { status: 500 });
	}
};

/**
 * Manually trigger image prune for an environment.
 *
 * @openapi
 * summary: Immediately run an image prune for an environment (outside its schedule)
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: {success:boolean!}
 * resp-400: The prune operation itself failed (Docker error)
 * resp-403: Permission denied (RBAC 'environments:edit' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while triggering the prune
 */
export const PUT: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);

		// Verify environment exists
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const result = await triggerImagePrune(id);

		if (!result.success) {
			return json({ error: result.error }, { status: 400 });
		}

		return json({ success: true });
	} catch (error) {
		console.error('Failed to trigger image prune:', error);
		return json({ error: 'Failed to trigger image prune' }, { status: 500 });
	}
};
