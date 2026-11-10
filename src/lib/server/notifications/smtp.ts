/** SMTP email notifications via nodemailer. */
import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../db';
import type { NotificationPayload, NotificationResult } from './shared';
import { buildSmtpHtml } from './smtp-core';

export async function sendSmtpNotification(config: SmtpConfig, payload: NotificationPayload): Promise<NotificationResult> {
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
