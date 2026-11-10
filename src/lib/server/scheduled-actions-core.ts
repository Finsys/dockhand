/**
 * Scheduled container start and stop: the rules that need no Docker or database,
 * so they can be tested on their own. A time is `HH:MM` (every day) or a five-field
 * cron expression, in the environment's timezone. The `dockhand.start.at` and
 * `dockhand.stop.at` labels win over a schedule set in the UI.
 */
import { isSystemContainer } from './scheduler/tasks/update-utils';
import { actionTimeToCron } from '../utils/scheduled-action-time';

export { actionTimeToCron };

export const START_AT_LABEL = 'dockhand.start.at';
export const STOP_AT_LABEL = 'dockhand.stop.at';

export type ScheduledAction = 'start' | 'stop';

/** Where a row's times come from: the container settings or the container's labels. */
export type ScheduledActionSource = 'ui' | 'label';

/** The start and stop times a container's labels set; a blank or invalid label is not set. */
export function labelActionTimes(labels: Record<string, string> | null | undefined): {
	startAt: string | null;
	stopAt: string | null;
	errors: string[];
} {
	const errors: string[] = [];
	const read = (key: string): string | null => {
		const value = labels?.[key]?.trim();
		if (!value) return null;
		const parsed = actionTimeToCron(value);
		if ('error' in parsed) {
			errors.push(`${key}: ${parsed.error}`);
			return null;
		}
		return value;
	};
	return { startAt: read(START_AT_LABEL), stopAt: read(STOP_AT_LABEL), errors };
}

export interface LabelSyncContainer {
	name: string;
	image: string;
	labels: Record<string, string> | null | undefined;
}

export interface LabelSyncRow {
	id: number;
	containerName: string;
	source: ScheduledActionSource;
	startAt: string | null;
	stopAt: string | null;
}

export interface LabelSyncPlan {
	/** Rows to create or overwrite from labels. */
	upserts: { containerName: string; startAt: string | null; stopAt: string | null }[];
	/** Label rows whose container no longer carries either label, or is gone. */
	deletes: number[];
	/** One line per label that was ignored, for the log. */
	warnings: string[];
}

/**
 * What one environment's labels change in its schedule rows. A container's labels
 * replace whatever its row holds; a label row goes with its labels or its container
 * (a stack brought up again gets it back from the labels). A row set in the UI is
 * left alone. System containers are never scheduled.
 */
export function planLabelSync(containers: LabelSyncContainer[], rows: LabelSyncRow[]): LabelSyncPlan {
	const plan: LabelSyncPlan = { upserts: [], deletes: [], warnings: [] };
	const rowsByName = new Map(rows.map((row) => [row.containerName, row]));

	for (const container of containers) {
		const { startAt, stopAt, errors } = labelActionTimes(container.labels);
		const row = rowsByName.get(container.name);
		const labelled = startAt !== null || stopAt !== null;
		for (const error of errors) plan.warnings.push(`${container.name}: ${error}`);

		if (labelled && isSystemContainer(container.image)) {
			plan.warnings.push(`${container.name}: system containers cannot be scheduled; labels ignored`);
			if (row?.source === 'label') plan.deletes.push(row.id);
			continue;
		}
		if (labelled) {
			const unchanged = row?.source === 'label' && row.startAt === startAt && row.stopAt === stopAt;
			if (!unchanged) plan.upserts.push({ containerName: container.name, startAt, stopAt });
		} else if (row?.source === 'label') {
			plan.deletes.push(row.id);
		}
	}
	const listed = new Set(containers.map((c) => c.name));
	for (const row of rows) {
		if (row.source === 'label' && !listed.has(row.containerName)) plan.deletes.push(row.id);
	}
	return plan;
}

/**
 * Whether a scheduled action has anything to do for a container in this Docker state.
 * A restarting or paused container is still up: a stop acts on it, a start leaves it
 * alone (a paused container is unpaused, not started).
 */
export function actionDecision(action: ScheduledAction, state: string): 'run' | 'already' {
	if (action === 'stop') return ['running', 'restarting', 'paused'].includes(state) ? 'run' : 'already';
	return ['running', 'restarting', 'paused'].includes(state) ? 'already' : 'run';
}
