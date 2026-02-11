import { json } from '@sveltejs/kit';
import { testNotification } from '$lib/server/notifications';
import { authorize } from '$lib/server/authorize';
import type { RequestHandler } from './$types';

// Test notification with provided config (without saving)
export const POST: RequestHandler = async ({ request, cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !await auth.can('settings', 'edit')) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const data = await request.json();

		if (!data.type || !data.config) {
			return json({ error: 'Type and config are required' }, { status: 400 });
		}

		// Validate SMTP config
		if (data.type === 'smtp') {
			const config = data.config;
			if (!config.host || !config.from_email || !config.to_emails?.length) {
				return json({ error: 'Host, from email, and at least one recipient are required' }, { status: 400 });
			}
		}

		// Validate Apprise config
		if (data.type === 'apprise') {
			const config = data.config;
			if (!config.urls?.length) {
				return json({ error: 'At least one Apprise URL is required' }, { status: 400 });
			}
		}

		// Create a fake notification setting object for testing
		const setting = {
			id: 0,
			name: data.name || 'Test',
			type: data.type as 'smtp' | 'apprise',
			enabled: true,
			config: data.config,
			eventTypes: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};

		const result = await testNotification(setting);

		return json({
			success: result.success,
			message: result.success ? 'Test notification sent successfully' : undefined,
			error: result.error || (result.success ? undefined : 'Failed to send test notification')
		});
	} catch (error: any) {
		console.error('Error testing notification:', error);
		return json({
			success: false,
			error: error.message || 'Failed to test notification'
		}, { status: 500 });
	}
};
