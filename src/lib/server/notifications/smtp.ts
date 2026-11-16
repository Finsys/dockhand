/** SMTP email notifications via nodemailer. */
import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../db';
import { resolvedHostReason, type NotificationPayload, type NotificationResult } from './shared';
import { buildSmtpHtml, smtpHostReason } from './smtp-core';

export async function sendSmtpNotification(config: SmtpConfig, payload: NotificationPayload): Promise<NotificationResult> {
	try {
		// Reject link-local metadata and reserved ranges, by address and by where a name
		// points; a relay on loopback or the LAN is allowed. The connection is the sink,
		// so the guard sits here too, not only at save time.
		const hostReason = smtpHostReason(config.host) ?? await resolvedHostReason(config.host, undefined, { allowLoopback: true });
		if (hostReason) {
			return { success: false, error: `SMTP error: ${hostReason}` };
		}

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

		const envText = payload.environmentName ? ` [${payload.environmentName}]` : '';

		const html = buildSmtpHtml(payload.title, payload.message, payload.environmentName);

		await transporter.sendMail({
			from: config.from_name ? `"${config.from_name}" <${config.from_email}>` : config.from_email,
			to: config.to_emails.join(', '),
			subject: `[Dockhand]${envText} ${payload.title}`,
			text: `${payload.title}${envText}\n\n${payload.message}`,
			html,
			...(payload.attachments?.length ? { attachments: payload.attachments } : {})
		});

		return { success: true };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return { success: false, error: `SMTP error: ${errorMsg}` };
	}
}
