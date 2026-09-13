/**
 * Pure MQTT URL parsing + message building for the MQTT notification channel.
 * No `mqtt` import and no I/O, so the URL grammar (creds, ports, topic, qos/retain)
 * is unit-testable without pulling the broker library. sendMqtt (mqtt.ts) consumes this.
 */
import { dangerousHostReason } from '../url-safety';
import type { NotificationPayload } from './shared';
import { titleWithEnv } from './shared';

export interface MqttTarget {
	brokerUrl: string; // mqtt:// or mqtts:// scheme+host+port only, for mqtt.connect
	host: string;
	topic: string;
	qos: 0 | 1 | 2;
	retain: boolean;
	username?: string;
	password?: string;
}

/**
 * Parse an Apprise-style mqtt(s):// URL into a connect target. Returns a reason
 * string on invalid input instead of throwing.
 *   mqtt://host/topic, mqtt://user:pass@host:port/a/b, mqtts://host/topic
 *   ?qos=0|1|2 (default 0), ?retain=true|false (default false)
 */
export function parseMqttUrl(raw: string): { ok: true; target: MqttTarget } | { ok: false; reason: string } {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { ok: false, reason: 'not a valid URL' };
	}
	if (u.protocol !== 'mqtt:' && u.protocol !== 'mqtts:') {
		return { ok: false, reason: `scheme ${u.protocol} not allowed (use mqtt or mqtts)` };
	}
	const secure = u.protocol === 'mqtts:';
	const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (!host) return { ok: false, reason: 'missing broker host' };
	if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost blocked' };
	const hostReason = dangerousHostReason(host);
	if (hostReason) return { ok: false, reason: hostReason };

	const port = u.port ? Number(u.port) : secure ? 8883 : 1883;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { ok: false, reason: `invalid port ${u.port}` };
	}

	const topic = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
	if (!topic) return { ok: false, reason: 'missing topic (add a path, e.g. mqtt://host/dockhand)' };
	// A PUBLISH topic must not contain subscription wildcards.
	if (topic.includes('+') || topic.includes('#')) {
		return { ok: false, reason: 'publish topic must not contain wildcards (+ or #)' };
	}

	const qosRaw = u.searchParams.get('qos');
	let qos: 0 | 1 | 2 = 0;
	if (qosRaw !== null) {
		if (qosRaw === '0' || qosRaw === '1' || qosRaw === '2') qos = Number(qosRaw) as 0 | 1 | 2;
		else return { ok: false, reason: `invalid qos ${qosRaw} (use 0, 1 or 2)` };
	}
	const retain = u.searchParams.get('retain') === 'true';

	const username = u.username ? decodeURIComponent(u.username) : undefined;
	const password = u.password ? decodeURIComponent(u.password) : undefined;

	const brokerUrl = `${secure ? 'mqtts' : 'mqtt'}://${u.hostname}:${port}`;

	return { ok: true, target: { brokerUrl, host, topic, qos, retain, username, password } };
}

/** Build the JSON message body published to the topic. Timestamp is injected by the caller. */
export function buildMqttMessage(payload: NotificationPayload, timestamp: string): string {
	return JSON.stringify({
		title: titleWithEnv(payload),
		message: payload.message,
		type: payload.type ?? 'info',
		eventType: payload.eventType,
		environmentId: payload.environmentId,
		environmentName: payload.environmentName,
		timestamp,
	});
}
