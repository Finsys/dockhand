import nodemailer from 'nodemailer';
import {
	getEnabledNotificationSettings,
	getEnabledEnvironmentNotifications,
	getEnvironment,
	type NotificationSettingData,
	type SmtpConfig,
	type AppriseConfig,
	type NotificationEventType
} from './db';

// Escape special characters for Telegram Markdown
function escapeTelegramMarkdown(text: string): string {
	// Escape characters that have special meaning in Telegram Markdown
	return text
		.replace(/\\/g, '\\\\')  // Escape backslashes first
		.replace(/_/g, '\\_')    // Underscore (italic)
		.replace(/\*/g, '\\*')   // Asterisk (bold)
		.replace(/\[/g, '\\[')   // Opening bracket (link)
		.replace(/\]/g, '\\]')   // Closing bracket (link)
		.replace(/`/g, '\\`');   // Backtick (code)
}

export interface NotificationPayload {
	title: string;
	message: string;
	type?: 'info' | 'success' | 'warning' | 'error';
	environmentId?: number;
	environmentName?: string;
}

// Result type for functions that can return detailed errors
export interface NotificationResult {
	success: boolean;
	error?: string;
}

// Send notification via SMTP
async function sendSmtpNotification(config: SmtpConfig, payload: NotificationPayload): Promise<NotificationResult> {
	try {
		const transporter = nodemailer.createTransport({
			host: config.host,
			port: config.port,
			secure: config.secure,
			auth: config.username ? {
				user: config.username,
				pass: config.password
			} : undefined,
			tls: config.skipTlsVerify ? {
				rejectUnauthorized: false
			} : undefined
		});

		const envBadge = payload.environmentName
			? `<span style="display: inline-block; background: #3b82f6; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-left: 8px;">${payload.environmentName}</span>`
			: '';
		const envText = payload.environmentName ? ` [${payload.environmentName}]` : '';

		const html = `
			<div style="font-family: sans-serif; padding: 20px;">
				<h2 style="margin: 0 0 10px 0;">${payload.title}${envBadge}</h2>
				<p style="margin: 0; white-space: pre-wrap;">${payload.message}</p>
				<hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
				<p style="margin: 0; font-size: 12px; color: #666;">Sent by Dockhand</p>
			</div>
		`;

		await transporter.sendMail({
			from: config.from_name ? `"${config.from_name}" <${config.from_email}>` : config.from_email,
			to: config.to_emails.join(', '),
			subject: `[Dockhand]${envText} ${payload.title}`,
			text: `${payload.title}${envText}\n\n${payload.message}`,
			html
		});

		return { success: true };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return { success: false, error: `SMTP error: ${errorMsg}` };
	}
}

// Parse Apprise URL and send notification
async function sendAppriseNotification(config: AppriseConfig, payload: NotificationPayload): Promise<NotificationResult> {
	const errors: string[] = [];

	for (const url of config.urls) {
		try {
			const result = await sendToAppriseUrl(url, payload);
			if (!result.success && result.error) {
				errors.push(result.error);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			errors.push(`Failed to send: ${errorMsg}`);
		}
	}

	if (errors.length > 0) {
		return { success: false, error: errors.join('; ') };
	}
	return { success: true };
}

// Send to a single Apprise URL
async function sendToAppriseUrl(url: string, payload: NotificationPayload): Promise<NotificationResult> {
	try {
		// Extract protocol from Apprise URL format (protocol://...)
		// Note: Can't use new URL() because custom schemes like 'tgram://' are not valid URLs
		const protocolMatch = url.match(/^([a-z]+):\/\//i);
		if (!protocolMatch) {
			return { success: false, error: 'Invalid Apprise URL format - missing protocol' };
		}
		const protocol = protocolMatch[1].toLowerCase();

		// Handle different notification services
		switch (protocol) {
			case 'discord':
			case 'discords':
				return await sendDiscord(url, payload);
			case 'slack':
			case 'slacks':
				return await sendSlack(url, payload);
			case 'tgram':
				return await sendTelegram(url, payload);
			case 'gotify':
			case 'gotifys':
				return await sendGotify(url, payload);
			case 'ntfy':
			case 'ntfys':
				return await sendNtfy(url, payload);
			case 'pushover':
				return await sendPushover(url, payload);
			case 'json':
			case 'jsons':
				return await sendGenericWebhook(url, payload);
			default:
				return { success: false, error: `Unsupported Apprise protocol: ${protocol}` };
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return { success: false, error: `Failed to parse Apprise URL: ${errorMsg}` };
	}
}

// Discord webhook
async function sendDiscord(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// discord://webhook_id/webhook_token or discords://...
	const url = appriseUrl.replace(/^discords?:\/\//, 'https://discord.com/api/webhooks/');
	const titleWithEnv = payload.environmentName ? `${payload.title} [${payload.environmentName}]` : payload.title;

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				embeds: [{
					title: titleWithEnv,
					description: payload.message,
					color: payload.type === 'error' ? 0xff0000 : payload.type === 'warning' ? 0xffaa00 : payload.type === 'success' ? 0x00ff00 : 0x0099ff,
					...(payload.environmentName && {
						footer: { text: `Environment: ${payload.environmentName}` }
					})
				}]
			})
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Discord error ${response.status}: ${text || response.statusText}` };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: `Discord connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// Slack webhook
async function sendSlack(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// slack://token_a/token_b/token_c or webhook URL
	let url: string;
	if (appriseUrl.includes('hooks.slack.com')) {
		url = appriseUrl.replace(/^slacks?:\/\//, 'https://');
	} else {
		const parts = appriseUrl.replace(/^slacks?:\/\//, '').split('/');
		url = `https://hooks.slack.com/services/${parts.join('/')}`;
	}

	const envTag = payload.environmentName ? ` \`${payload.environmentName}\`` : '';

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				text: `*${payload.title}*${envTag}\n${payload.message}`
			})
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Slack error ${response.status}: ${text || response.statusText}` };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: `Slack connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// Telegram
async function sendTelegram(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// tgram://bot_token/chat_id
	const match = appriseUrl.match(/^tgram:\/\/([^/]+)\/(.+)/);
	if (!match) {
		return { success: false, error: 'Invalid Telegram URL format. Expected: tgram://bot_token/chat_id' };
	}

	const [, botToken, chatId] = match;
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

	// Escape markdown special characters in title and message
	const escapedTitle = escapeTelegramMarkdown(payload.title);
	const escapedMessage = escapeTelegramMarkdown(payload.message);
	const envTag = payload.environmentName ? ` \\[${escapeTelegramMarkdown(payload.environmentName)}\\]` : '';

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: `*${escapedTitle}*${envTag}\n${escapedMessage}`,
				parse_mode: 'Markdown'
			})
		});

		if (!response.ok) {
			const errorData = await response.json().catch(() => ({})) as { description?: string };
			const errorMsg = errorData.description || response.statusText;
			return { success: false, error: `Telegram error ${response.status}: ${errorMsg}` };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: `Telegram connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// Gotify
async function sendGotify(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// gotify://hostname/token or gotifys://hostname/token
	const match = appriseUrl.match(/^gotifys?:\/\/([^/]+)\/(.+)/);
	if (!match) {
		return { success: false, error: 'Invalid Gotify URL format. Expected: gotify://hostname/token' };
	}

	const [, hostname, token] = match;
	const protocol = appriseUrl.startsWith('gotifys') ? 'https' : 'http';
	const url = `${protocol}://${hostname}/message?token=${token}`;

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: payload.title,
				message: payload.message,
				priority: payload.type === 'error' ? 8 : payload.type === 'warning' ? 5 : 2
			})
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Gotify error ${response.status}: ${text || response.statusText}` };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: `Gotify connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// ntfy
async function sendNtfy(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// Supported formats:
	// ntfy://topic (public ntfy.sh)
	// ntfy://host/topic (custom server, no auth)
	// ntfy://user:pass@host/topic (custom server with auth)
	// ntfys:// variants for HTTPS
	const isSecure = appriseUrl.startsWith('ntfys');
	const path = appriseUrl.replace(/^ntfys?:\/\//, '');

	let url: string;
	let auth: string | null = null;

	// Check for user:pass@host/topic format
	const authMatch = path.match(/^([^:]+):([^@]+)@(.+)$/);
	if (authMatch) {
		const [, user, pass, hostAndTopic] = authMatch;
		auth = Buffer.from(`${user}:${pass}`).toString('base64');
		url = `${isSecure ? 'https' : 'http'}://${hostAndTopic}`;
	} else if (path.includes('/')) {
		// Custom server without auth
		url = `${isSecure ? 'https' : 'http'}://${path}`;
	} else {
		// Default ntfy.sh
		url = `https://ntfy.sh/${path}`;
	}

	const headers: Record<string, string> = {
		'Title': payload.title,
		'Priority': payload.type === 'error' ? '5' : payload.type === 'warning' ? '4' : '3',
		'Tags': payload.type || 'info'
	};

	if (auth) {
		headers['Authorization'] = `Basic ${auth}`;
	}

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: payload.message
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `ntfy error ${response.status}: ${text || response.statusText}` };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: `ntfy connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// Pushover
async function sendPushover(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// pushover://user_key/api_token
	const match = appriseUrl.match(/^pushover:\/\/([^/]+)\/(.+)/);
	if (!match) {
		return { success: false, error: 'Invalid Pushover URL format. Expected: pushover://user_key/api_token' };
	}

	const [, userKey, apiToken] = match;
	const url = 'https://api.pushover.net/1/messages.json';

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token: apiToken,
				user: userKey,
				title: payload.title,
				message: payload.message,
				priority: payload.type === 'error' ? 1 : 0
			})
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Pushover error ${response.status}: ${text || response.statusText}` };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: `Pushover connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// Generic JSON webhook
async function sendGenericWebhook(appriseUrl: string, payload: NotificationPayload): Promise<NotificationResult> {
	// json://hostname/path or jsons://hostname/path
	const url = appriseUrl.replace(/^jsons?:\/\//, appriseUrl.startsWith('jsons') ? 'https://' : 'http://');

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: payload.title,
				message: payload.message,
				type: payload.type || 'info',
				timestamp: new Date().toISOString()
			})
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Webhook error ${response.status}: ${text || response.statusText}` };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: `Webhook connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// Send notification to all enabled channels
export async function sendNotification(payload: NotificationPayload): Promise<{ success: boolean; results: { name: string; success: boolean }[] }> {
	const settings = await getEnabledNotificationSettings();
	const results: { name: string; success: boolean }[] = [];

	for (const setting of settings) {
		let result: NotificationResult = { success: false };

		if (setting.type === 'smtp') {
			result = await sendSmtpNotification(setting.config as SmtpConfig, payload);
		} else if (setting.type === 'apprise') {
			result = await sendAppriseNotification(setting.config as AppriseConfig, payload);
		}

		results.push({ name: setting.name, success: result.success });
	}

	return {
		success: results.every(r => r.success),
		results
	};
}

// Test a specific notification setting
export async function testNotification(setting: NotificationSettingData): Promise<NotificationResult> {
	const payload: NotificationPayload = {
		title: 'Dockhand Test Notification',
		message: 'This is a test notification from Dockhand. If you receive this, your notification settings are configured correctly.',
		type: 'info'
	};

	if (setting.type === 'smtp') {
		return await sendSmtpNotification(setting.config as SmtpConfig, payload);
	} else if (setting.type === 'apprise') {
		return await sendAppriseNotification(setting.config as AppriseConfig, payload);
	}

	return { success: false, error: 'Unknown notification type' };
}

// Map Docker action to notification event type
function mapActionToEventType(action: string): NotificationEventType | null {
	const mapping: Record<string, NotificationEventType> = {
		'start': 'container_started',
		'stop': 'container_stopped',
		'restart': 'container_restarted',
		'die': 'container_exited',
		'kill': 'container_exited',
		'oom': 'container_oom',
		'health_status: unhealthy': 'container_unhealthy',
		'pull': 'image_pulled'
	};
	return mapping[action] || null;
}

// Scanner image patterns to exclude from notifications
const SCANNER_IMAGE_PATTERNS = [
	'anchore/grype',
	'aquasec/trivy',
	'ghcr.io/anchore/grype',
	'ghcr.io/aquasecurity/trivy'
];

function isScannerContainer(image: string | null | undefined): boolean {
	if (!image) return false;
	const lowerImage = image.toLowerCase();
	return SCANNER_IMAGE_PATTERNS.some(pattern => lowerImage.includes(pattern.toLowerCase()));
}

// Send notification for an environment-specific event
export async function sendEnvironmentNotification(
	environmentId: number,
	action: string,
	payload: Omit<NotificationPayload, 'environmentId' | 'environmentName'>,
	image?: string | null
): Promise<{ success: boolean; sent: number }> {
	const eventType = mapActionToEventType(action);
	if (!eventType) {
		// Not a notifiable event type
		return { success: true, sent: 0 };
	}

	// Get environment name
	const env = await getEnvironment(environmentId);
	if (!env) {
		return { success: false, sent: 0 };
	}

	// Get enabled notification channels for this environment and event type
	const envNotifications = await getEnabledEnvironmentNotifications(environmentId, eventType);
	if (envNotifications.length === 0) {
		return { success: true, sent: 0 };
	}

	const enrichedPayload: NotificationPayload = {
		...payload,
		environmentId,
		environmentName: env.name
	};

	// Check if this is a scanner container
	const isScanner = isScannerContainer(image);

	let sent = 0;
	let allSuccess = true;

	// Skip all notifications for scanner containers (Trivy, Grype)
	if (isScanner) {
		return { success: true, sent: 0 };
	}

	for (const notif of envNotifications) {
		try {
			let result: NotificationResult = { success: false };
			if (notif.channelType === 'smtp') {
				result = await sendSmtpNotification(notif.config as SmtpConfig, enrichedPayload);
			} else if (notif.channelType === 'apprise') {
				result = await sendAppriseNotification(notif.config as AppriseConfig, enrichedPayload);
			}
			if (result.success) sent++;
			else allSuccess = false;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(`[Notifications] Failed to send to channel ${notif.channelName}:`, errorMsg);
			allSuccess = false;
		}
	}

	return { success: allSuccess, sent };
}

// Send notification for a specific event type (not mapped from Docker action)
// Used for auto-update, git sync, vulnerability, and system events
export async function sendEventNotification(
	eventType: NotificationEventType,
	payload: NotificationPayload,
	environmentId?: number
): Promise<{ success: boolean; sent: number }> {
	// Get environment name if provided
	let enrichedPayload = { ...payload };
	if (environmentId) {
		const env = await getEnvironment(environmentId);
		if (env) {
			enrichedPayload.environmentId = environmentId;
			enrichedPayload.environmentName = env.name;
		}
	}

	// Get enabled notification channels for this event type
	let channels: Array<{
		channel_type: 'smtp' | 'apprise';
		channel_name: string;
		config: SmtpConfig | AppriseConfig;
	}> = [];

	if (environmentId) {
		// Environment-specific: get channels subscribed to this env and event type
		const envNotifications = await getEnabledEnvironmentNotifications(environmentId, eventType);
		channels = envNotifications
			.filter(n => n.channelType && n.channelName)
			.map(n => ({
				channel_type: n.channelType!,
				channel_name: n.channelName!,
				config: n.config
			}));
	} else {
		// System-wide: get all globally enabled channels that subscribe to this event type
		const globalSettings = await getEnabledNotificationSettings();
		channels = globalSettings
			.filter(s => s.eventTypes?.includes(eventType))
			.map(s => ({
				channel_type: s.type,
				channel_name: s.name,
				config: s.config
			}));
	}

	if (channels.length === 0) {
		return { success: true, sent: 0 };
	}

	let sent = 0;
	let allSuccess = true;

	for (const channel of channels) {
		try {
			let result: NotificationResult = { success: false };
			if (channel.channel_type === 'smtp') {
				result = await sendSmtpNotification(channel.config as SmtpConfig, enrichedPayload);
			} else if (channel.channel_type === 'apprise') {
				result = await sendAppriseNotification(channel.config as AppriseConfig, enrichedPayload);
			}
			if (result.success) sent++;
			else allSuccess = false;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(`[Notifications] Failed to send to channel ${channel.channel_name}:`, errorMsg);
			allSuccess = false;
		}
	}

	return { success: allSuccess, sent };
}
