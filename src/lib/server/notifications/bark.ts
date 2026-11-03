/**
 * Bark — iOS push via bark-server (https://github.com/Finb/bark-server).
 *
 * Supported formats:
 *   bark://device_key                      → uses official api.day.app over HTTPS
 *   bark://host/device_key                 → custom server over HTTP
 *   bark://host[:port]/k1/k2/...           → multi-device batch (Apprise convention)
 *   barks://host[:port]/...                → HTTPS variant
 *
 * Query params honored (per https://bark.day.app/#/en-us/tutorial):
 *   ?sound=name, ?level=active|timeSensitive|critical|passive,
 *   ?group=, ?icon=, ?url=, ?badge=N, ?copy=, ?subtitle=,
 *   ?volume=, ?ttl=, ?call=1, ?autoCopy=1, ?isArchive=1, ?action=none
 */
import { notificationFetch } from './shared';
import type { NotificationPayload, NotificationResult } from './shared';

export async function sendBark(appriseUrl: string, payload: NotificationPayload, skipTlsVerify = false): Promise<NotificationResult> {
	const isSecure = appriseUrl.startsWith('barks');
	const path = appriseUrl.replace(/^barks?:\/\//, '');

	// Split off query string before slicing the path so '?' in a device key
	// (in principle possible, though Bark's keys are 22-char base62) doesn't
	// confuse the parser.
	let cleanPath = path;
	let queryParams = new URLSearchParams();
	const qIndex = path.indexOf('?');
	if (qIndex !== -1) {
		queryParams = new URLSearchParams(path.substring(qIndex + 1));
		cleanPath = path.substring(0, qIndex);
	}

	if (!cleanPath) {
		return { success: false, error: 'Invalid Bark URL format. Expected: bark://device_key, bark://host/device_key, or barks://host/device_key' };
	}

	let baseUrl: string;
	let deviceKeys: string[];
	if (!cleanPath.includes('/')) {
		// bark://device_key → official server, HTTPS regardless of bark:// vs barks://
		baseUrl = 'https://api.day.app';
		deviceKeys = [cleanPath];
	} else {
		const parts = cleanPath.split('/').filter(Boolean);
		if (parts.length < 2) {
			return { success: false, error: 'Invalid Bark URL format. Expected: bark://device_key, bark://host/device_key, or barks://host/device_key' };
		}
		const hostPort = parts[0];
		deviceKeys = parts.slice(1);
		baseUrl = `${isSecure ? 'https' : 'http'}://${hostPort}`;
	}

	// Map our payload type to Bark's `level`. Query-supplied level wins.
	//   info    → active        (banner + sound, doesn't bypass DND)
	//   warning → timeSensitive  (cuts through Focus modes)
	//   error   → critical       (cuts through silent mode; user must enable)
	const defaultLevel = payload.type === 'error'
		? 'critical'
		: payload.type === 'warning'
			? 'timeSensitive'
			: 'active';
	const level = queryParams.get('level') || defaultLevel;

	const titleWithEnv = payload.environmentName
		? `${payload.title} [${payload.environmentName}]`
		: payload.title;

	const body: Record<string, unknown> = {
		title: titleWithEnv,
		body: payload.message,
		level
	};
	// Single-target uses device_key; batch uses device_keys (per Bark API v2).
	if (deviceKeys.length === 1) {
		body.device_key = deviceKeys[0];
	} else {
		body.device_keys = deviceKeys;
	}

	// String passthroughs Bark understands. Unknown params are dropped on the
	// server side anyway so no point forwarding them.
	const passthroughString = ['sound', 'group', 'icon', 'url', 'copy', 'subtitle', 'category', 'ciphertext', 'isArchive', 'autoCopy', 'call', 'action', 'volume'];
	for (const key of passthroughString) {
		const v = queryParams.get(key);
		if (v !== null && v !== '') body[key] = v;
	}
	// Numeric passthroughs.
	for (const key of ['badge', 'ttl']) {
		const v = queryParams.get(key);
		if (v !== null && v !== '') {
			const n = parseInt(v, 10);
			if (!Number.isNaN(n)) body[key] = n;
		}
	}

	try {
		const response = await notificationFetch(`${baseUrl}/push`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify(body)
		}, skipTlsVerify);

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return { success: false, error: `Bark error ${response.status}: ${text || response.statusText}` };
		}
		// Bark returns HTTP 200 with { code, message, timestamp } — `code !== 200`
		// signals a logical failure (e.g. invalid device key) that we'd otherwise
		// swallow as a success.
		const json: any = await response.json().catch(() => null);
		if (json && typeof json.code === 'number' && json.code !== 200) {
			return { success: false, error: `Bark error: ${json.message || `code ${json.code}`}` };
		}
		return { success: true };
	} catch (error) {
		return { success: false, error: `Bark connection failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

