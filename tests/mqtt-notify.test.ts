/**
 * Unit tests for the MQTT notification channel's pure URL parser + message builder
 * (mqtt-core.ts). No broker, no `mqtt` import - just the Apprise-URL grammar and the
 * SSRF host guard.
 *
 * Run with: bun test tests/mqtt-notify.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { parseMqttUrl, buildMqttMessage } from '../src/lib/server/notifications/mqtt-core';

describe('parseMqttUrl', () => {
	test('basic mqtt://host/topic defaults to tcp port 1883, qos 0, retain false', () => {
		const r = parseMqttUrl('mqtt://192.168.1.5/dockhand');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.target.brokerUrl).toBe('mqtt://192.168.1.5:1883');
		expect(r.target.host).toBe('192.168.1.5');
		expect(r.target.topic).toBe('dockhand');
		expect(r.target.qos).toBe(0);
		expect(r.target.retain).toBe(false);
		expect(r.target.username).toBeUndefined();
	});

	test('credentials, custom port, multi-segment topic, qos and retain', () => {
		const r = parseMqttUrl('mqtt://user:s3cret@broker.lan:1884/dockhand/events?qos=1&retain=true');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.target.brokerUrl).toBe('mqtt://broker.lan:1884');
		expect(r.target.topic).toBe('dockhand/events');
		expect(r.target.qos).toBe(1);
		expect(r.target.retain).toBe(true);
		expect(r.target.username).toBe('user');
		expect(r.target.password).toBe('s3cret');
	});

	test('mqtts:// uses TLS default port 8883', () => {
		const r = parseMqttUrl('mqtts://broker.example.com/topic');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.target.brokerUrl).toBe('mqtts://broker.example.com:8883');
	});

	test('percent-encoded credentials are decoded', () => {
		const r = parseMqttUrl('mqtt://user%40host:p%3Ass@broker.lan/topic');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.target.username).toBe('user@host');
		expect(r.target.password).toBe('p:ss');
	});

	test('rejects a non-mqtt scheme', () => {
		const r = parseMqttUrl('http://broker/topic');
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toContain('not allowed');
	});

	test('rejects a missing topic', () => {
		const r = parseMqttUrl('mqtt://broker.lan');
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toContain('topic');
	});

	test('rejects a wildcard in the publish topic', () => {
		expect(parseMqttUrl('mqtt://broker.lan/a/+/b').ok).toBe(false);
		// A literal '#' in a URL is the fragment delimiter, so it must be percent-encoded
		// to reach the topic; once decoded, the wildcard guard rejects it.
		expect(parseMqttUrl('mqtt://broker.lan/a/%23').ok).toBe(false);
	});

	test('rejects an invalid qos', () => {
		const r = parseMqttUrl('mqtt://broker.lan/topic?qos=3');
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toContain('qos');
	});

	// SSRF: a private LAN broker is allowed (self-hosted Mosquitto), but loopback and
	// cloud-metadata are blocked - same policy as the HTTP notification channels.
	test('allows a private LAN broker (v4 and v6)', () => {
		expect(parseMqttUrl('mqtt://10.0.0.9/topic').ok).toBe(true);
		expect(parseMqttUrl('mqtt://192.168.1.50/topic').ok).toBe(true);
		expect(parseMqttUrl('mqtt://[fd00::1]/topic').ok).toBe(true); // IPv6 ULA
	});

	test('blocks loopback, metadata, and IPv6/IPv4-mapped loopback brokers', () => {
		expect(parseMqttUrl('mqtt://127.0.0.1/topic').ok).toBe(false);
		expect(parseMqttUrl('mqtt://localhost/topic').ok).toBe(false);
		expect(parseMqttUrl('mqtt://169.254.169.254/topic').ok).toBe(false);
		expect(parseMqttUrl('mqtt://[::1]/topic').ok).toBe(false); // IPv6 loopback
		expect(parseMqttUrl('mqtt://[::ffff:127.0.0.1]/topic').ok).toBe(false); // v4-mapped loopback
	});
});

describe('buildMqttMessage', () => {
	test('produces JSON with title (env-qualified), message, type and the given timestamp', () => {
		const body = buildMqttMessage(
			{ title: 'Container started', message: 'nginx started', type: 'success', eventType: 'container_started', environmentId: 2, environmentName: 'prod' },
			'2026-01-01T00:00:00.000Z'
		);
		const parsed = JSON.parse(body);
		expect(parsed.message).toBe('nginx started');
		expect(parsed.type).toBe('success');
		expect(parsed.eventType).toBe('container_started');
		expect(parsed.environmentName).toBe('prod');
		expect(parsed.timestamp).toBe('2026-01-01T00:00:00.000Z');
		// title runs through titleWithEnv, so it still contains the base title
		expect(parsed.title).toContain('Container started');
	});

	test('defaults type to info when absent', () => {
		const parsed = JSON.parse(buildMqttMessage({ title: 't', message: 'm' }, '2026-01-01T00:00:00.000Z'));
		expect(parsed.type).toBe('info');
	});
});
