import { json } from '@sveltejs/kit';
import {
	getNotificationSettings,
	createNotificationSetting,
	type SmtpConfig,
	type AppriseConfig,
	type NotificationEventType
} from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { auditNotification } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * @openapi
 * summary: List all notification settings (SMTP and Apprise) with SMTP passwords masked
 * resp-200: array<{id:integer!, type:string!, name:string!, enabled:boolean!, config:{host:string, port:integer, from_email:string, to_emails:array<string>, urls:array<string>, password:string}, eventTypes:array<string>}>
 * resp-403: Permission denied (requires the notifications:view permission when auth is enabled)
 * resp-500: Failed to fetch notification settings
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('notifications', 'view')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const settings = await getNotificationSettings();
		// Don't expose passwords
		const safeSettings = settings.map(s => ({
			...s,
			config: s.type === 'smtp' ? {
				...s.config,
				password: s.config.password ? '********' : undefined
			} : s.config
		}));
		return json(safeSettings);
	} catch (error) {
		console.error('Error fetching notification settings:', error);
		return json({ error: 'Failed to fetch notification settings' }, { status: 500 });
	}
};

/**
 * @openapi
 * summary: Create a notification setting (SMTP or Apprise); the response masks any SMTP password
 * body: {type:string!, name:string!, enabled:boolean, config:{host:string, port:integer, secure:boolean, username:string, password:string, from_email:string, from_name:string, to_emails:array<string>, urls:array<string>}, eventTypes:array<string>, event_types:array<string>}
 * body-example: {"type":"smtp","name":"Ops Alerts","enabled":true,"config":{"host":"smtp.example.com","port":587,"secure":false,"from_email":"dockhand@example.com","to_emails":["ops@example.com"],"password":"***"},"eventTypes":["container_unhealthy"]}
 * resp-200: {id:integer!, type:string!, name:string!, enabled:boolean!, config:{}, eventTypes:array<string>}
 * resp-400: Missing or invalid fields — type/name/config required, type must be smtp or apprise, SMTP needs host/port/from_email/to_emails, Apprise needs at least one URL
 * resp-403: Permission denied (requires the notifications:create permission)
 * resp-500: Failed to create notification setting
 */
export const POST: RequestHandler = async (event) => {
	const { request, cookies } = event;
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('notifications', 'create')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const body = await request.json();
		const { type, name, enabled, config, event_types, eventTypes } = body;
		// Support both snake_case (legacy) and camelCase (new) for event types
		const resolvedEventTypes = eventTypes || event_types;

		if (!type || !name || !config) {
			return json({ error: 'Type, name, and config are required' }, { status: 400 });
		}

		if (type !== 'smtp' && type !== 'apprise') {
			return json({ error: 'Type must be smtp or apprise' }, { status: 400 });
		}

		// Validate config based on type
		if (type === 'smtp') {
			const smtpConfig = config as SmtpConfig;
			if (!smtpConfig.host || !smtpConfig.port || !smtpConfig.from_email || !smtpConfig.to_emails?.length) {
				return json({ error: 'SMTP config requires host, port, from_email, and to_emails' }, { status: 400 });
			}
		} else if (type === 'apprise') {
			const appriseConfig = config as AppriseConfig;
			if (!appriseConfig.urls?.length) {
				return json({ error: 'Webhook config requires at least one URL' }, { status: 400 });
			}
		}

		const setting = await createNotificationSetting({
			type,
			name,
			enabled: enabled !== false,
			config,
			eventTypes: resolvedEventTypes as NotificationEventType[]
		});

		// Audit log
		await auditNotification(event, 'create', setting.id, setting.name);

		// Don't expose passwords in response
		const safeSetting = setting.type === 'smtp' ? {
			...setting,
			config: {
				...setting.config,
				password: setting.config.password ? '********' : undefined
			}
		} : setting;
		return json(safeSetting);
	} catch (error: any) {
		console.error('Error creating notification setting:', error);
		return json({ error: error.message || 'Failed to create notification setting' }, { status: 500 });
	}
};
