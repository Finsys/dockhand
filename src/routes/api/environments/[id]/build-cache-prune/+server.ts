import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorize } from '$lib/server/authorize';
import {
	getBuildCachePruneSettings,
	setBuildCachePruneSettings,
	getEnvironment
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule, triggerBuildCachePrune } from '$lib/server/scheduler';

/**
 * Get build cache prune settings for an environment.
 *
 * @openapi
 * summary: Get the automatic build-cache-prune schedule settings for an environment
 * path: id:integer! Environment id (from GET /api/environments)
 * resp-200: {settings:{enabled:boolean!, cronExpression:string!, pruneMode:string!, until:string, reservedSpace:integer}!}
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
	const id = parseInt(params.id);
	const envAccessDenied = await auth.requireEnvAccess(id);
	if (envAccessDenied) return envAccessDenied;

	try {
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const settings = await getBuildCachePruneSettings(id);

		return json({
			settings: settings || {
				enabled: false,
				cronExpression: '0 3 * * 0', // Default: 3 AM Sunday
				pruneMode: 'dangling'
			}
		});
	} catch (error) {
		console.error('Failed to get build cache prune settings:', error);
		return json({ error: 'Failed to get build cache prune settings' }, { status: 500 });
	}
};

/**
 * Save build cache prune settings for an environment.
 *
 * @openapi
 * summary: Save the automatic build-cache-prune schedule for an environment (registers/unregisters the croner job)
 * path: id:integer! Environment id (from GET /api/environments)
 * body: {enabled:boolean, cronExpression:string, pruneMode:string, until:string, reservedSpace:integer}
 * body-example: {"enabled":true,"cronExpression":"0 3 * * 0","pruneMode":"dangling","until":"336h"}
 * resp-200: {success:boolean!, settings:{enabled:boolean!, cronExpression:string!, pruneMode:string!, until:string, reservedSpace:integer}!}
 * resp-403: Permission denied (RBAC 'environments:edit' missing)
 * resp-404: Environment not found
 * resp-500: Unexpected error while saving the settings
 */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('environments', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	const id = parseInt(params.id);
	const envAccessDenied = await auth.requireEnvAccess(id);
	if (envAccessDenied) return envAccessDenied;

	try {
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const data = await request.json();

		// Preserve lastPruned and lastResult across a settings edit.
		const existingSettings = await getBuildCachePruneSettings(id);

		const reservedSpace = typeof data.reservedSpace === 'number' && data.reservedSpace > 0
			? Math.floor(data.reservedSpace)
			: undefined;
		const until = typeof data.until === 'string' && data.until.trim() !== ''
			? data.until.trim()
			: undefined;

		const settings = {
			enabled: data.enabled ?? false,
			cronExpression: data.cronExpression || '0 3 * * 0',
			pruneMode: data.pruneMode === 'all' ? 'all' as const : 'dangling' as const,
			until,
			reservedSpace,
			lastPruned: existingSettings?.lastPruned,
			lastResult: existingSettings?.lastResult
		};

		await setBuildCachePruneSettings(id, settings);

		if (settings.enabled) {
			await registerSchedule(id, 'build_cache_prune', id);
		} else {
			unregisterSchedule(id, 'build_cache_prune');
		}

		return json({ success: true, settings });
	} catch (error) {
		console.error('Failed to save build cache prune settings:', error);
		return json({ error: 'Failed to save build cache prune settings' }, { status: 500 });
	}
};

/**
 * Manually trigger a build cache prune for an environment.
 *
 * @openapi
 * summary: Immediately run a build cache prune for an environment (outside its schedule)
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
	const id = parseInt(params.id);
	const envAccessDenied = await auth.requireEnvAccess(id);
	if (envAccessDenied) return envAccessDenied;

	try {
		const env = await getEnvironment(id);
		if (!env) {
			return json({ error: 'Environment not found' }, { status: 404 });
		}

		const result = await triggerBuildCachePrune(id);

		if (!result.success) {
			return json({ error: result.error }, { status: 400 });
		}

		return json({ success: true });
	} catch (error) {
		console.error('Failed to trigger build cache prune:', error);
		return json({ error: 'Failed to trigger build cache prune' }, { status: 500 });
	}
};
