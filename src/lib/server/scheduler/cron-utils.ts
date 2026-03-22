import { Cron } from 'croner';

/**
 * Get the next run time for a cron expression.
 * Uses legacyMode: false so day-of-month + day-of-week use AND logic.
 * @param cronExpression - The cron expression
 * @param timezone - Optional IANA timezone (e.g., 'Europe/Warsaw'). Defaults to local timezone.
 */
export function getNextRun(cronExpression: string, timezone?: string): Date | null {
	try {
		const options = timezone ? { timezone, legacyMode: false } : { legacyMode: false };
		const job = new Cron(cronExpression, options);
		const next = job.nextRun();
		job.stop();
		return next;
	} catch {
		return null;
	}
}

/**
 * Check if a cron expression is valid.
 */
export function isValidCron(cronExpression: string): boolean {
	try {
		const job = new Cron(cronExpression, { legacyMode: false });
		job.stop();
		return true;
	} catch {
		return false;
	}
}
