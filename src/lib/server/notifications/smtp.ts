/** SMTP email notifications via nodemailer. */
import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../db';
import type { NotificationPayload, NotificationResult } from './shared';

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
			html,
			...(payload.attachments?.length ? { attachments: payload.attachments } : {})
		});

		return { success: true };
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return { success: false, error: `SMTP error: ${errorMsg}` };
	}
}
