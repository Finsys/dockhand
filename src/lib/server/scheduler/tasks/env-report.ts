/**
 * Mail one environment's state report on a schedule.
 *
 * The report leaves the installation on a timer with nobody watching, so it goes to an SMTP
 * channel chosen by an administrator and nowhere else. A webhook channel has no way to carry
 * the file, which is why the configuration only offers SMTP.
 */

import {
	getEnvironment,
	getNotificationSetting,
	getEnvReportSettings,
	createScheduleExecution,
	updateScheduleExecution,
	appendScheduleExecutionLog
} from '../../db';
import { getLicenseType } from '../../license';
import { buildReport, reportToCSV, includeChanges, reportFilename, reportTier } from '../../environment-report-core';
import { collectEnvironment } from '../../environment-report';
import { sendSmtpNotification } from '../../notifications/smtp';
import { redactUrlCredentials } from '$lib/utils/rest-repository';

export async function runEnvReport(
	environmentId: number,
	triggeredBy: 'manual' | 'cron' = 'cron'
): Promise<void> {
	const startTime = Date.now();
	const env = await getEnvironment(environmentId);
	if (!env) {
		console.error(`[EnvReport] Environment ${environmentId} not found`);
		return;
	}

	const config = await getEnvReportSettings(environmentId);
	if (!config || !config.enabled) {
		console.log(`[EnvReport] Reporting is off for environment ${environmentId}`);
		return;
	}

	const execution = await createScheduleExecution({
		scheduleType: 'env_report',
		scheduleId: environmentId,
		environmentId,
		entityName: `Report: ${env.name}`,
		triggeredBy,
		status: 'running'
	});
	await updateScheduleExecution(execution.id, { startedAt: new Date().toISOString() });

	const log = async (message: string) => {
		console.log(`[EnvReport] ${message}`);
		await appendScheduleExecutionLog(execution.id, `[${new Date().toISOString()}] ${message}`);
	};

	const fail = async (message: string) => {
		await log(message);
		await updateScheduleExecution(execution.id, {
			status: 'failed',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			errorMessage: message
		});
	};

	try {
		await log(`Building the ${config.format.toUpperCase()} report for ${env.name}`);

		// The licence is the installation's, so the scheduler can answer for it without a
		// user. Only an administrator can configure this, and an administrator may read the
		// audit log, so the tier alone decides whether the change history rides along.
		const tier = reportTier(await getLicenseType());
		if (!tier) {
			await fail('A commercial license is required to send a state report');
			return;
		}

		if (config.notificationId == null) {
			await fail('No notification channel is configured for this report');
			return;
		}
		const channel = await getNotificationSetting(config.notificationId);
		if (!channel) {
			await fail(`Notification channel ${config.notificationId} no longer exists`);
			return;
		}
		if (channel.type !== 'smtp') {
			await fail(`The configured channel is ${channel.type}, which cannot carry an attachment`);
			return;
		}
		if (!channel.enabled) {
			await fail('The configured notification channel is disabled');
			return;
		}

		const withChanges = includeChanges(tier);
		const generatedAt = new Date().toISOString();
		const report = buildReport([await collectEnvironment(env.id, env.name, withChanges)], withChanges, {
			generatedAt,
			appVersion: typeof __APP_VERSION__ !== 'undefined' ? (__APP_VERSION__ ?? 'unknown') : 'unknown'
		});

		let filename: string;
		let content: Buffer;
		let contentType: string;
		if (config.format === 'pdf') {
			const { buildReportPdf, reportPdfFilename, readReportLogo } = await import(
				'../../environment-report-pdf'
			);
			content = await buildReportPdf(report, await readReportLogo());
			filename = reportPdfFilename(report, env.name);
			contentType = 'application/pdf';
		} else {
			content = Buffer.from(reportToCSV(report), 'utf8');
			filename = reportFilename(env.name, generatedAt, 'csv');
			contentType = 'text/csv; charset=utf-8';
		}

		const t = report.totals;
		const summary = [
			`${t.containers} containers across ${t.stacks} stacks`,
			`${t.scannedImages} scanned images`,
			t.critical > 0 || t.high > 0
				? `${t.critical} critical and ${t.high} high findings`
				: 'no critical or high findings'
		].join(', ');

		const result = await sendSmtpNotification(channel.config as never, {
			// The environment belongs in the subject: these arrive on a timer, and the reader
			// has to tell one from another without opening the attachment.
			title: `State report: ${env.name}`,
			message: `${summary}.\n\nGenerated ${generatedAt.replace('T', ' ').slice(0, 16)} UTC. The full report is attached as ${filename}.`,
			type: t.critical > 0 ? 'warning' : 'info',
			environmentId: env.id,
			environmentName: env.name,
			attachments: [{ filename, content, contentType }]
		});

		if (!result.success) {
			// The transport's own message names the mail host and port, which is more than
			// `schedules:view` should reveal. The detail goes to the server log; the row
			// records only that delivery failed.
			console.error(`[EnvReport] SMTP delivery failed: ${result.error || 'unknown error'}`);
			await fail('Could not send the report: the mail server rejected or refused the message');
			return;
		}

		await log(`Sent the ${config.format.toUpperCase()} report (${Math.round(content.length / 1024)} KB)`);
		await updateScheduleExecution(execution.id, {
			status: 'success',
			completedAt: new Date().toISOString(),
			duration: Date.now() - startTime,
			// Execution rows are read under `schedules:view`, which is weaker than the licence
			// plus `environments:view` the report itself requires. So the row records that a
			// report was sent, never what was in it.
			details: {
				format: config.format,
				bytes: content.length,
				includesChanges: withChanges
			}
		});
	} catch (error) {
		// The reason is needed to diagnose a failed run, but it can carry a URL with
		// credentials in it, and the row is readable under `schedules:view`.
		const message = error instanceof Error ? error.message : String(error);
		await fail(`Report failed: ${redactUrlCredentials(message)}`);
	}
}
