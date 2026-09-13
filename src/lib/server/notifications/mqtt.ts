/**
 * MQTT notification channel. Publishes each event as a JSON message to a broker
 * topic, so anything (Home Assistant, automations, other services) can subscribe.
 *
 * Apprise-style URL (parsed by mqtt-core.ts, unit-tested without a broker):
 *   mqtt://host/topic, mqtt://user:pass@host:port/a/b, mqtts://host/topic
 *   ?qos=0|1|2 (default 0), ?retain=true|false (default false)
 */
import mqtt from 'mqtt';
import type { NotificationPayload, NotificationResult } from './shared';
import { parseMqttUrl, buildMqttMessage } from './mqtt-core';

/** Timeout for the connect+publish round-trip, overridable like the HTTP channels. */
const MQTT_TIMEOUT_MS = (() => {
	const parsed = Number(process.env.NOTIFICATION_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();

/** Publish a notification to an MQTT broker. Connects, publishes once, disconnects. */
export async function sendMqtt(url: string, payload: NotificationPayload): Promise<NotificationResult> {
	const parsed = parseMqttUrl(url);
	if (!parsed.ok) return { success: false, error: `Invalid MQTT URL: ${parsed.reason}` };
	const t = parsed.target;

	return new Promise<NotificationResult>((resolve) => {
		let settled = false;
		// One overall watchdog that is NEVER cleared until the promise resolves, so no
		// path (connect, publish, or a stalled teardown) can hang past the timeout. If a
		// graceful close wedges after the publish succeeded, the watchdog force-ends and
		// still resolves success - the message was already PUBACK'd.
		let pendingSuccess = false;
		const overall = setTimeout(() => {
			try { client.end(true); } catch { /* already closing */ }
			finish(pendingSuccess ? { success: true } : { success: false, error: 'MQTT publish timed out' });
		}, MQTT_TIMEOUT_MS);

		const finish = (r: NotificationResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(overall);
			resolve(r);
		};

		const client = mqtt.connect(t.brokerUrl, {
			username: t.username,
			password: t.password,
			connectTimeout: MQTT_TIMEOUT_MS,
			reconnectPeriod: 0, // one-shot: never auto-reconnect for a single publish
		});

		client.on('connect', () => {
			const body = buildMqttMessage(payload, new Date().toISOString());
			client.publish(t.topic, body, { qos: t.qos, retain: t.retain }, (err) => {
				if (err) {
					try { client.end(true); } catch { /* already closing */ }
					finish({ success: false, error: `MQTT publish failed: ${err.message}` });
					return;
				}
				// Publish OK. Close GRACEFULLY (DISCONNECT) so the broker fully processes it -
				// a forced end() right after the PUBACK can drop a retained message. The
				// overall watchdog still guards a teardown that never completes.
				pendingSuccess = true;
				try { client.end(false, {}, () => finish({ success: true })); }
				catch { finish({ success: true }); }
			});
		});
		client.on('error', (err) => {
			try { client.end(true); } catch { /* already closing */ }
			finish({ success: false, error: `MQTT connection failed: ${err.message}` });
		});
	});
}
