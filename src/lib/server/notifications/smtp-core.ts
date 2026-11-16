/**
 * Pure SMTP body builders, split out so they are unit-testable without importing
 * nodemailer (which the bun unit runner cannot load).
 */

import { dangerousHostReason } from '../url-safety';

/**
 * SSRF host policy for the SMTP channel, matching the MQTT channel: reject loopback
 * (incl. the `localhost` name), link-local cloud metadata (169.254.169.254) and
 * reserved ranges, while allowing a private-LAN mail server (10.x / 192.168.x /
 * 172.16-31.x), which is a normal self-hosted configuration. Returns a reason string
 * for a blocked host, or null when the host is acceptable.
 */
export function smtpHostReason(host: string | null | undefined): string | null {
	const h = (host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
	if (!h) return 'missing SMTP host';
	if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback address (localhost) blocked';
	return dangerousHostReason(h);
}

/**
 * Escape the five HTML-significant characters. The title/message can carry
 * remote-agent-supplied strings (container names, image tags), so they are
 * escaped before interpolation into the HTML mail body.
 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Build the HTML mail body. Every interpolated value is HTML-escaped. */
export function buildSmtpHtml(title: string, message: string, environmentName?: string): string {
	const envBadge = environmentName
		? `<span style="display: inline-block; background: #3b82f6; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-left: 8px;">${escapeHtml(environmentName)}</span>`
		: '';

	return `
			<div style="font-family: sans-serif; padding: 20px;">
				<h2 style="margin: 0 0 10px 0;">${escapeHtml(title)}${envBadge}</h2>
				<p style="margin: 0; white-space: pre-wrap;">${escapeHtml(message)}</p>
				<hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
				<p style="margin: 0; font-size: 12px; color: #666;">Sent by Dockhand</p>
			</div>
		`;
}
