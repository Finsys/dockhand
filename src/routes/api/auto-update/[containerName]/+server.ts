import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	getAutoUpdateSetting,
	upsertAutoUpdateSetting,
	deleteAutoUpdateSetting,
	deleteAutoUpdateSchedule
} from '$lib/server/db';
import { registerSchedule, unregisterSchedule } from '$lib/server/scheduler';
import { authorize } from '$lib/server/authorize';

/**
 * @openapi
 * summary: Get the auto-update setting for a container (returns sensible defaults when none is stored)
 * path: containerName:string! Container name (URL-encoded)
 * query: env:integer Environment the container belongs to (from GET /api/environments)
 * resp-200: {enabled:boolean!, scheduleType:string!, cronExpression:string, vulnerabilityCriteria:string!}
 * resp-200-example: {"enabled":false,"scheduleType":"daily","cronExpression":"0 3 * * *","vulnerabilityCriteria":"never"}
 * resp-500: Failed to get auto-update setting
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);

	const permDenied = await auth.requirePermission('schedules', 'view');
	if (permDenied) return permDenied;

	try {
		const containerName = decodeURIComponent(params.containerName);
		const envIdParam = url.searchParams.get('env');
		const envId = envIdParam ? parseInt(envIdParam) : undefined;

		const envDenied = await auth.requireEnvAccess(envId);
		if (envDenied) return envDenied;

		const setting = await getAutoUpdateSetting(containerName, envId);

		if (!setting) {
			return json({
				enabled: false,
				scheduleType: 'daily',
				cronExpression: '0 3 * * *',
				vulnerabilityCriteria: 'never'
			});
		}

		// Return with camelCase keys
		return json({
			...setting,
			scheduleType: setting.scheduleType,
			cronExpression: setting.cronExpression,
			vulnerabilityCriteria: setting.vulnerabilityCriteria || 'never'
		});
	} catch (error) {
		console.error('Failed to get auto-update setting:', error);
		return json({ error: 'Failed to get auto-update setting' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Create or update a container's auto-update setting; enabled=false deletes it and its schedule
 * path: containerName:string! Container name (URL-encoded)
 * query: env:integer Environment the container belongs to (from GET /api/environments)
 * body: {enabled:boolean, cronExpression:string, cron_expression:string, vulnerabilityCriteria:string, vulnerability_criteria:string}
 * body-example: {"enabled":true,"cronExpression":"0 3 * * *","vulnerabilityCriteria":"never"}
 * resp-200: {id:integer!, enabled:boolean!, scheduleType:string!, cronExpression:string, vulnerabilityCriteria:string!, deleted:boolean, success:boolean}
 * resp-200-example: {"success":true,"deleted":true}
 * resp-500: Failed to save auto-update setting
 */
export const POST: RequestHandler = async ({ params, url, request, cookies }) => {
	const auth = await authorize(cookies);

	const permDenied = await auth.requirePermission('schedules', 'edit');
	if (permDenied) return permDenied;

	try {
		const containerName = decodeURIComponent(params.containerName);
		const envIdParam = url.searchParams.get('env');
		const envId = envIdParam ? parseInt(envIdParam) : undefined;

		const envDenied = await auth.requireEnvAccess(envId);
		if (envDenied) return envDenied;

		const body = await request.json();
		// Accept both camelCase and snake_case for backward compatibility
		const enabled = body.enabled;
		const cronExpression = body.cronExpression ?? body.cron_expression;
		const vulnerabilityCriteria = body.vulnerabilityCriteria ?? body.vulnerability_criteria;

		// Hard delete when disabled
		if (enabled === false) {
			await deleteAutoUpdateSchedule(containerName, envId);
			return json({ success: true, deleted: true });
		}

		// Auto-detect schedule type from cron expression for backward compatibility
		let scheduleType: 'daily' | 'weekly' | 'custom' = 'custom';
		if (cronExpression) {
			const parts = cronExpression.split(' ');
			if (parts.length === 5) {
				const [, , day, month, dow] = parts;
				if (dow !== '*' && day === '*' && month === '*') {
					scheduleType = 'weekly';
				} else if (day === '*' && month === '*' && dow === '*') {
					scheduleType = 'daily';
				}
			}
		}

		const setting = await upsertAutoUpdateSetting(
			containerName,
			{
				enabled: Boolean(enabled),
				scheduleType: scheduleType,
				cronExpression: cronExpression || null,
				vulnerabilityCriteria: vulnerabilityCriteria || 'never'
			},
			envId
		);

		// Register or unregister schedule with croner
		if (setting.enabled && setting.cronExpression) {
			await registerSchedule(setting.id, 'container_update', setting.environmentId);
		} else {
			unregisterSchedule(setting.id, 'container_update');
		}

		// Return with camelCase keys
		return json({
			...setting,
			scheduleType: setting.scheduleType,
			cronExpression: setting.cronExpression,
			vulnerabilityCriteria: setting.vulnerabilityCriteria || 'never'
		});
	} catch (error) {
		console.error('Failed to save auto-update setting:', error);
		return json({ error: 'Failed to save auto-update setting' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Delete a container's auto-update setting and unregister its schedule
 * path: containerName:string! Container name (URL-encoded)
 * query: env:integer Environment the container belongs to (from GET /api/environments)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-500: Failed to delete auto-update setting
 */
export const DELETE: RequestHandler = async ({ params, url, cookies }) => {
	const auth = await authorize(cookies);

	const permDenied = await auth.requirePermission('schedules', 'edit');
	if (permDenied) return permDenied;

	try {
		const containerName = decodeURIComponent(params.containerName);
		const envIdParam = url.searchParams.get('env');
		const envId = envIdParam ? parseInt(envIdParam) : undefined;

		const envDenied = await auth.requireEnvAccess(envId);
		if (envDenied) return envDenied;

		// Get the setting ID before deleting
		const setting = await getAutoUpdateSetting(containerName, envId);
		const settingId = setting?.id;

		const deleted = await deleteAutoUpdateSetting(containerName, envId);

		// Unregister schedule from croner
		if (deleted && settingId) {
			unregisterSchedule(settingId, 'container_update');
		}

		return json({ success: deleted });
	} catch (error) {
		console.error('Failed to delete auto-update setting:', error);
		return json({ error: 'Failed to delete auto-update setting' }, { status: 500 });
	}
};
