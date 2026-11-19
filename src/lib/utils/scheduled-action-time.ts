/**
 * A scheduled start or stop time: HH:MM (every day) or a five-field cron expression.
 * Shared by the server and the container settings form.
 */
import { Cron } from 'croner';

/** The cron expression for a schedule time, or an error saying why it is not one. */
export function actionTimeToCron(value: string): { cron: string } | { error: string } {
	const trimmed = value.trim();
	const time = trimmed.match(/^(\d{1,2}):(\d{2})$/);
	if (time) {
		const hour = Number(time[1]);
		const minute = Number(time[2]);
		if (hour > 23 || minute > 59) return { error: `"${trimmed}" is not a time of day` };
		return { cron: `${minute} ${hour} * * *` };
	}
	if (trimmed.split(/\s+/).length !== 5) {
		return { error: `"${trimmed}" is neither HH:MM nor a five-field cron expression` };
	}
	try {
		new Cron(trimmed, { paused: true, legacyMode: false });
		return { cron: trimmed };
	} catch (error) {
		return { error: `"${trimmed}" is not a valid cron expression: ${error instanceof Error ? error.message : String(error)}` };
	}
}
