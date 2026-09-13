/**
 * Notification router — picks the right per-provider sender based on the
 * channel type (SMTP / Apprise URL) and (for Apprise URLs) the URL scheme.
 *
 * Public surface used by API routes and the rest of the app:
 *   - sendNotification           (fan out to every enabled channel)
 *   - testNotification           (one channel, with a fixed test payload)
 *   - sendEnvironmentNotification  (Docker container event → matching channels)
 *   - sendEventNotification      (auto-update / git / vuln / system events)
 *   - NotificationPayload, NotificationResult types
 *
 * Per-provider implementations live in sibling files (./bark, ./discord, …).
 * This file orchestrates only — it never knows what's inside a Bark or
 * Telegram URL.
 */

import {
	getEnabledNotificationSettings,
	getEnabledEnvironmentNotifications,
	getEnvironment,
	type NotificationSettingData,
	type SmtpConfig,
	type AppriseConfig,
	type NotificationEventType
} from '../db';

import type { NotificationPayload, NotificationResult } from './shared';
export type { NotificationPayload, NotificationResult } from './shared';
// The pure docker-action -> event-type map lives in events-core (unit-testable).
import { mapActionToEventType } from './events-core';
export { mapActionToEventType } from './events-core';

import { sendSmtpNotification } from './smtp';
import { sendDiscord } from './discord';
import { sendSlack } from './slack';
import { sendMattermost } from './mattermost';
import { sendTelegram } from './telegram';
import { sendGotify } from './gotify';
import { sendNtfy } from './ntfy';
import { sendBark } from './bark';
import { sendSignal } from './signal';
import { sendApprise } from './apprise';
import { sendPushover } from './pushover';
import { sendMqtt } from './mqtt';
import { sendGenericWebhook } from './generic-webhook';
import { sendWorkflows } from './workflows';
import { sendZabbix } from './zabbix';

// Send to every URL in an Apprise channel. Errors are aggregated so a single
// bad URL doesn't silently mask a healthy one.
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

// Route a single Apprise URL to the right sender. The switch is the ONLY
// place that needs to grow when a new provider is added.
async function sendToAppriseUrl(url: string, payload: NotificationPayload): Promise<NotificationResult> {
	try {
		// Custom schemes like 'tgram://' aren't valid URLs to new URL(),
		// so we match the prefix directly.
		const protocolMatch = url.match(/^([a-z]+):\/\//i);
		if (!protocolMatch) {
			return { success: false, error: 'Invalid Apprise URL format - missing protocol' };
		}
		const protocol = protocolMatch[1].toLowerCase();

		switch (protocol) {
			case 'discord':
			case 'discords':
				return await sendDiscord(url, payload);
			case 'slack':
			case 'slacks':
				return await sendSlack(url, payload);
			case 'mmost':
			case 'mmosts':
				return await sendMattermost(url, payload);
			case 'tgram':
				return await sendTelegram(url, payload);
			case 'gotify':
			case 'gotifys':
				return await sendGotify(url, payload);
			case 'ntfy':
			case 'ntfys':
				return await sendNtfy(url, payload);
			case 'bark':
			case 'barks':
				return await sendBark(url, payload);
			case 'signal':
			case 'signals':
				return await sendSignal(url, payload);
			case 'apprise':
			case 'apprises':
				return await sendApprise(url, payload);
			case 'pushover':
			case 'pover':
				return await sendPushover(url, payload);
			case 'mqtt':
			case 'mqtts':
				return await sendMqtt(url, payload);
			case 'json':
			case 'jsons':
				return await sendGenericWebhook(url, payload);
			case 'workflows':
				return await sendWorkflows(url, payload);
			case 'zabbix':
			case 'zabbixs':
				return await sendZabbix(url, payload);
			default:
				return { success: false, error: `Unsupported Apprise protocol: ${protocol}` };
		}
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return { success: false, error: `Failed to parse Apprise URL: ${errorMsg}` };
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

export async function testNotification(setting: NotificationSettingData): Promise<NotificationResult> {
	const payload: NotificationPayload = {
		title: 'Dockhand Test Notification',
		message: 'This is a test notification from Dockhand. If you receive this, your notification settings are configured correctly.',
		type: 'info',
		eventType: 'test'
	};

	if (setting.type === 'smtp') {
		return await sendSmtpNotification(setting.config as SmtpConfig, payload);
	} else if (setting.type === 'apprise') {
		return await sendAppriseNotification(setting.config as AppriseConfig, payload);
	}

	return { success: false, error: 'Unknown notification type' };
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

export async function sendEnvironmentNotification(
	environmentId: number,
	action: string,
	payload: Omit<NotificationPayload, 'environmentId' | 'environmentName'>,
	image?: string | null
): Promise<{ success: boolean; sent: number }> {
	const eventType = mapActionToEventType(action);
	if (!eventType) {
		return { success: true, sent: 0 };
	}

	const env = await getEnvironment(environmentId);
	if (!env) {
		return { success: false, sent: 0 };
	}

	const envNotifications = await getEnabledEnvironmentNotifications(environmentId, eventType);
	if (envNotifications.length === 0) {
		return { success: true, sent: 0 };
	}

	const enrichedPayload: NotificationPayload = {
		...payload,
		eventType,
		environmentId,
		environmentName: env.name
	};

	// Skip all notifications for scanner containers (Trivy, Grype)
	if (isScannerContainer(image)) {
		return { success: true, sent: 0 };
	}

	let sent = 0;
	let allSuccess = true;

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

export async function sendEventNotification(
	eventType: NotificationEventType,
	payload: NotificationPayload,
	environmentId?: number
): Promise<{ success: boolean; sent: number }> {
	let enrichedPayload: NotificationPayload = { ...payload, eventType };
	if (environmentId) {
		const env = await getEnvironment(environmentId);
		if (env) {
			enrichedPayload.environmentId = environmentId;
			enrichedPayload.environmentName = env.name;
		}
	}

	let channels: Array<{
		channel_type: 'smtp' | 'apprise';
		channel_name: string;
		config: SmtpConfig | AppriseConfig;
	}> = [];

	if (environmentId) {
		const envNotifications = await getEnabledEnvironmentNotifications(environmentId, eventType);
		channels = envNotifications
			.filter(n => n.channelType && n.channelName)
			.map(n => ({
				channel_type: n.channelType!,
				channel_name: n.channelName!,
				config: n.config
			}));
	} else {
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
