import { json } from '@sveltejs/kit';
import {
	getNotificationSetting,
	updateNotificationSetting,
	deleteNotificationSetting,
	type SmtpConfig,
	type AppriseConfig,
	type NotificationEventType
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditNotification } from '$lib/server/audit';
import { computeAuditDiff } from '$lib/utils/diff';
import { maskAppriseUrl } from '$lib/server/notifications/events-core';
import { notificationRetryPolicy } from '$lib/utils/notification-retries';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: Get a single notification setting by ID, with any SMTP password masked
 * path: id:integer! Notification setting ID (from GET /api/notifications)
 * resp-200: {id:integer!, type:string!, name:string!, enabled:boolean!, config:{host:string, port:integer, from_email:string, to_emails:array<string>, urls:array<string>, password:string}, eventTypes:array<string>}
 * resp-400: Invalid ID (not a number)
 * resp-403: Permission denied (requires the notifications:view permission)
 * resp-404: Notification setting not found
 * resp-500: Failed to fetch notification setting
 */
export const GET: RequestHandler = async ({ params, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('notifications', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid ID' }, { status: 400 });
		}

		const setting = await getNotificationSetting(id);
		if (!setting) {
			return json({ error: 'Notification setting not found' }, { status: 404 });
		}

		// Withhold secrets: the SMTP password, and the Apprise URLs (bot tokens in path).
		const safeSetting = {
			...setting,
			config: setting.type === 'smtp'
				? { ...setting.config, password: setting.config.password ? '********' : undefined }
				: { ...setting.config, urls: Array.isArray(setting.config.urls) ? setting.config.urls.map(maskAppriseUrl) : setting.config.urls }
		};

		return json(safeSetting);
	} catch (error) {
		console.error('Error fetching notification setting:', error);
		return json({ error: 'Failed to fetch notification setting' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Update a notification setting; a masked SMTP password ("********") keeps the stored value
 * path: id:integer! Notification setting ID (from GET /api/notifications)
 * body: {name:string, enabled:boolean, config:{host:string, port:integer, secure:boolean, username:string, password:string, from_email:string, from_name:string, to_emails:array<string>, urls:array<string>}, eventTypes:array<string>, event_types:array<string>}
 * body-example: {"name":"Ops Alerts","enabled":false,"config":{"host":"smtp.example.com","port":587,"from_email":"dockhand@example.com","to_emails":["ops@example.com"],"password":"********"},"eventTypes":["container_unhealthy","container_oom"]}
 * resp-200: {id:integer!, type:string!, name:string!, enabled:boolean!, config:{}, eventTypes:array<string>}
 * resp-400: Invalid ID, or config validation failed (SMTP needs host/port/from_email/to_emails, Apprise needs at least one URL)
 * resp-403: Permission denied (requires the notifications:edit permission)
 * resp-404: Notification setting not found
 * resp-500: Failed to update notification setting
 */
export const PUT: RequestHandler = async (event) => {
	const { params, request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('notifications', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid ID' }, { status: 400 });
		}

		const existing = await getNotificationSetting(id);
		if (!existing) {
			return json({ error: 'Notification setting not found' }, { status: 404 });
		}

		const body = await request.json();
		const { name, enabled, config, event_types, eventTypes } = body;
		// Support both snake_case (legacy) and camelCase (new) for event types
		const resolvedEventTypes = eventTypes || event_types;

		// If updating config, validate based on type
		if (config) {
			if (existing.type === 'smtp') {
				const smtpConfig = config as SmtpConfig;
				if (!smtpConfig.host || !smtpConfig.port || !smtpConfig.from_email || !smtpConfig.to_emails?.length) {
					return json({ error: 'SMTP config requires host, port, from_email, and to_emails' }, { status: 400 });
				}
				// If password is masked, keep the existing one
				if (smtpConfig.password === '********') {
					smtpConfig.password = (existing.config as SmtpConfig).password;
				}
			} else if (existing.type === 'apprise') {
				const appriseConfig = config as AppriseConfig;
				if (!Array.isArray(appriseConfig.urls) || appriseConfig.urls.some(u => typeof u !== 'string')) {
					return json({ error: 'Webhook config requires an array of URLs' }, { status: 400 });
				}
				// The GET masks each URL to "scheme://********". On save, restore the stored
				// value for a masked entry (the user did not change it) while keeping edited
				// and newly added URLs - per entry, so a partial edit or a deletion is not
				// lost. Match a masked entry to a stored URL by its masked form, consuming
				// each stored URL once so duplicate schemes still map one-to-one. A masked
				// entry that matches no unused stored URL (a copied placeholder line) is
				// dropped - never persist the bare "scheme://********", which Apprise cannot
				// deliver to.
				const stored = (existing.config as AppriseConfig).urls ?? [];
				const used = new Set<number>();
				appriseConfig.urls = (appriseConfig.urls ?? [])
					.map((u) => {
						if (!(u.includes('://********') || u === '********')) return u;
						const i = stored.findIndex((s, idx) => !used.has(idx) && maskAppriseUrl(s) === u);
						if (i === -1) return null;
						used.add(i);
						return stored[i];
					})
					.filter((u): u is string => u !== null);
				if (!appriseConfig.urls.length) {
					return json({ error: 'Webhook config requires at least one URL' }, { status: 400 });
				}
				try { appriseConfig.retry = notificationRetryPolicy(appriseConfig.retry); }
				catch (error) { return json({ error: (error as Error).message }, { status: 400 }); }
				if (appriseConfig.retry.enabled && !appriseConfig.urls.some(u => /^jsons?:\/\//i.test(u))) {
					return json({ error: 'Persistent webhook retries require a json:// or jsons:// URL' }, { status: 400 });
				}
			}
		}

		const updated = await updateNotificationSetting(id, {
			name,
			enabled,
			config,
			eventTypes: resolvedEventTypes as NotificationEventType[]
		});
		if (!updated) {
			return json({ error: 'Failed to update notification setting' }, { status: 500 });
		}

		// Compute diff for audit (exclude config to avoid logging sensitive data)
		const diff = computeAuditDiff(
			{ name: existing.name, enabled: existing.enabled, eventTypes: existing.eventTypes },
			{ name: updated.name, enabled: updated.enabled, eventTypes: updated.eventTypes }
		);

		// Audit log
		await auditNotification(event, 'update', updated.id, updated.name, diff);

		// Withhold secrets from the response, the same way the GET does.
		const safeSetting = {
			...updated,
			config: updated.type === 'smtp'
				? { ...updated.config, password: updated.config.password ? '********' : undefined }
				: { ...updated.config, urls: Array.isArray(updated.config.urls) ? updated.config.urls.map(maskAppriseUrl) : updated.config.urls }
		};

		return json(safeSetting);
	} catch (error: any) {
		console.error('Error updating notification setting:', error);
		return json({ error: error.message || 'Failed to update notification setting' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Delete a notification setting by ID
 * path: id:integer! Notification setting ID (from GET /api/notifications)
 * resp-200: {success:boolean!}
 * resp-200-example: {"success":true}
 * resp-400: Invalid ID (not a number)
 * resp-403: Permission denied (requires the notifications:delete permission)
 * resp-404: Notification setting not found
 * resp-500: Failed to delete notification setting
 */
export const DELETE: RequestHandler = async (event) => {
	const { params, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('notifications', 'delete')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const id = parseInt(params.id);
		if (isNaN(id)) {
			return json({ error: 'Invalid ID' }, { status: 400 });
		}

		// Get notification name before deletion for audit log
		const setting = await getNotificationSetting(id);
		if (!setting) {
			return json({ error: 'Notification setting not found' }, { status: 404 });
		}

		const deleted = await deleteNotificationSetting(id);
		if (!deleted) {
			return json({ error: 'Failed to delete notification setting' }, { status: 500 });
		}

		// Audit log
		await auditNotification(event, 'delete', id, setting.name);

		return json({ success: true });
	} catch (error) {
		console.error('Error deleting notification setting:', error);
		return json({ error: 'Failed to delete notification setting' }, { status: 500 });
	}
};
