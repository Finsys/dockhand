/**
 * Turns one recorded stack-deploy run (GET /api/stacks/{name}/deploys) into the
 * display strings the Deploys tab shows for it. Every function here is pure text
 * composition -- no fetch, no store, no formatting that depends on user settings
 * (relative/exact timestamps stay in the component, which already has
 * formatRelativeTime/formatDateTime available for that).
 *
 * Deliberately dependency-free (mirrors deploy-summary-core.ts / run-status.ts):
 * no import from $lib/server (better-sqlite3 isn't importable under Bun, and would
 * drag down every other test file sharing this process) and no import from
 * $lib/stores or $app -- those need a mounted Svelte/SvelteKit runtime this test
 * file doesn't have. The shapes below intentionally mirror (not import)
 * deploy-run-record-core.ts / deploy-summary-core.ts on the server: client code
 * never imports $lib/server, even for types (see StackModal.svelte's own local
 * BackupConfig for the same pattern).
 */

export interface DeployRunOptions {
	pull: boolean;
	build: boolean;
	forceRecreate: boolean;
}

export interface DeployRunSummary {
	containersCreated: number;
	containersRecreated: number;
	containersStarted: number;
	imagesBuilt: string[];
	imagesPulled: string[];
	buildSteps: number;
	buildStepsCached: number;
	digest?: string;
}

export interface DeployRunDetails {
	options?: DeployRunOptions;
	summary?: DeployRunSummary;
	/** Set when the run's output hit deploy-log-store's size budget and was cut off. */
	truncated?: boolean;
	/** Set by deploy-log-reconcile once it confirms the on-disk log file is gone
	 *  (see deploy-log-reconcile.ts) -- never cleared, and never set for a run
	 *  that is still in progress (the reconcile job skips those). */
	logMissing?: boolean;
}

export interface DeployRun {
	id: number;
	triggeredBy: string;
	/** Null for a run that never got past the queued state. Display-only here --
	 *  formatting (relative + exact) stays in the component, which already has
	 *  the user's time-format settings available for it. */
	startedAt?: string | null;
	duration: number | null;
	status: string;
	errorMessage?: string | null;
	details?: DeployRunDetails | null;
}

/** Everything the Deploys tab renders for one run, pre-composed so the component
 *  only ever binds -- it never branches on raw run/details/summary shape itself. */
export interface DeployRunView {
	statusLabel: string;
	trigger: string;
	duration: string;
	containerSummary: string;
	buildStatus: string;
	optionChips: string[];
	imagesBuilt: string[];
	imagesPulled: string[];
	/** Shortened last line of errorMessage -- only ever set for a failed run. */
	errorSummary: string | null;
	truncated: boolean;
}

export function formatStatusLabel(status: string): string {
	switch (status) {
		case 'success':
			return 'Success';
		case 'failed':
			return 'Failed';
		case 'running':
			return 'Running';
		default:
			// An unrecognized status is a schema drift worth seeing as-is, not one
			// more row silently rendered "Success" or hidden entirely.
			return status;
	}
}

export function formatTrigger(triggeredBy: string): string {
	switch (triggeredBy) {
		case 'cron':
			return 'Scheduled';
		case 'webhook':
			return 'Webhook';
		case 'startup':
			return 'Startup';
		case 'manual':
			return 'Manual';
		default:
			return triggeredBy;
	}
}

/** Mirrors ExecutionHistoryList.svelte's local formatDuration so the two run-history
 *  surfaces (backups, deploys) read the same way. Kept here (not imported from
 *  there) because that one is a component-local, unexported function. */
export function formatRunDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '—';
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

/**
 * A run with NO summary at all (compose produced zero output lines -- see
 * deploy-run-record.ts: `summary: this.lines.length > 0 ? summarize(this.lines) :
 * undefined`) is not the same fact as a run whose summary says every count is
 * zero. The first means "we don't know what happened"; the second means "we know,
 * and nothing changed". Collapsing them into one "0 containers" string would
 * report the first case as a fact it never established.
 */
export function formatContainerSummary(summary: DeployRunSummary | undefined): string {
	if (!summary) return 'No summary recorded for this run';
	const parts: string[] = [];
	if (summary.containersCreated > 0) parts.push(`${summary.containersCreated} created`);
	if (summary.containersRecreated > 0) parts.push(`${summary.containersRecreated} recreated`);
	if (summary.containersStarted > 0) parts.push(`${summary.containersStarted} started`);
	return parts.length > 0 ? parts.join(', ') : 'No container changes';
}

/**
 * "Was anything built, and how much of that came from the build cache" -- the one
 * question this whole feature was built to answer (see the task brief). Same
 * unknown-vs-zero distinction as formatContainerSummary: no summary reads as
 * "unknown", a summary with buildSteps === 0 reads as "nothing built" -- never the
 * same string.
 */
export function formatBuildStatus(summary: DeployRunSummary | undefined): string {
	if (!summary) return 'Build status unknown';
	const { buildSteps, buildStepsCached } = summary;
	if (buildSteps === 0) return 'Nothing built';
	if (buildStepsCached === buildSteps) {
		return buildSteps === 1 ? 'Built from cache' : `Built from cache (${buildSteps} steps)`;
	}
	if (buildStepsCached === 0) {
		return buildSteps === 1 ? 'Built (1 step)' : `Built (${buildSteps} steps)`;
	}
	return `Built (${buildSteps} steps, ${buildStepsCached} from cache)`;
}

export function formatOptionChips(options: DeployRunOptions | undefined): string[] {
	if (!options) return [];
	const chips: string[] = [];
	if (options.pull) chips.push('Pull');
	if (options.build) chips.push('Build');
	if (options.forceRecreate) chips.push('Force recreate');
	return chips;
}

/**
 * The last non-empty line of a (possibly multi-line) error, cut to maxLen with a
 * trailing "…" marker. errorMessage is compose's raw stdout/stderr tail (already
 * redacted server-side, see deploy-run-record.ts) -- often several lines of
 * progress before the actual failure, so the LAST line is the one worth showing
 * collapsed; the full text stays available via the run's log file.
 */
export function lastErrorLine(errorMessage: string | null | undefined, maxLen = 200): string | null {
	if (!errorMessage) return null;
	const lines = errorMessage
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const last = lines.length > 0 ? lines[lines.length - 1] : errorMessage.trim();
	if (last.length === 0) return null;
	if (last.length <= maxLen) return last;
	return `${last.slice(0, maxLen - 1)}…`;
}

/**
 * What the Deploys tab's expanded row shows for a run's LOG PANEL specifically --
 * a separate, narrower question from buildDeployRunView's "how does the row
 * summarize" above it. Three independent facts, each driving its own piece of
 * UI (see the component): whether the log is worth fetching at all, whether a
 * truncation notice belongs above it, and whether a delete action makes sense
 * for a run that might still be writing to that very file.
 *
 * logMissing short-circuits the fetch entirely -- a run already marked missing
 * by deploy-log-reconcile will 404 on GET .../log every time, so there is no
 * reason to make that round trip just to learn what the record already says.
 */
export interface DeployLogPanelState {
	/** True when the record already knows the log file is gone (details.logMissing).
	 *  The panel shows "log no longer available" and never fires a GET for it. */
	logMissing: boolean;
	/** True when the stored log was cut off at deploy-log-store's size budget --
	 *  same underlying flag DeployRunView.truncated surfaces for the collapsed
	 *  row, repeated here so the log panel doesn't need the raw run for it too. */
	truncated: boolean;
	/** False for a run still in progress. Its log file may still be growing on
	 *  disk, and deleting the record out from under an active write would race
	 *  the writer -- so no delete action is offered until the run has settled. */
	deletable: boolean;
}

export function buildDeployLogPanelState(run: DeployRun): DeployLogPanelState {
	return {
		logMissing: run.details?.logMissing === true,
		truncated: run.details?.truncated === true,
		deletable: run.status !== 'running'
	};
}

export function buildDeployRunView(run: DeployRun): DeployRunView {
	const summary = run.details?.summary;
	return {
		statusLabel: formatStatusLabel(run.status),
		trigger: formatTrigger(run.triggeredBy),
		duration: formatRunDuration(run.duration),
		containerSummary: formatContainerSummary(summary),
		buildStatus: formatBuildStatus(summary),
		optionChips: formatOptionChips(run.details?.options),
		imagesBuilt: summary?.imagesBuilt ?? [],
		imagesPulled: summary?.imagesPulled ?? [],
		errorSummary: run.status === 'failed' ? lastErrorLine(run.errorMessage) : null,
		truncated: run.details?.truncated === true
	};
}
