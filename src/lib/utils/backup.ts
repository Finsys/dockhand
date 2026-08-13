/**
 * Shared backup utilities — used by BackupPanel, BackupsTab, RestoreModal, backups page.
 */

import { HardDrive, Globe } from 'lucide-svelte';
import { AmazonS3Icon, BackblazeIcon, AzureBlobIcon, GoogleCloudIcon, RestServerIcon } from '$lib/components/cloud-icons';
import cronstrue from 'cronstrue';
import type { Component } from 'svelte';
import { computeExecutionTally, type Execution, type ExecutionTally } from '$lib/utils/execution-tally';
export { computeExecutionTally, type Execution, type ExecutionTally };

// ---------------------------------------------------------------------------
// Job-result classification
// ---------------------------------------------------------------------------

/**
 * Classify a backup/restore job result. The engine now returns a discriminated
 * union keyed on `status` ('success' | 'warning' | 'skipped' | 'error') — it no
 * longer carries the old `{ success: boolean }` field. A 'skipped' result (a
 * concurrent-run rejection, or a retention "would wipe everything" guard) is
 * NOT a success and must not be reported as one; it is also not a hard error.
 *
 * `error` covers both the current shape and any legacy `{ success:false }` /
 * bare `{ error }` payload, so this is safe for callers that may still receive
 * an old-shaped result from a non-migrated route.
 */
export type BackupOutcome = 'success' | 'warning' | 'skipped' | 'error';

export function classifyJobResult(result: any): { outcome: BackupOutcome; message?: string } {
	if (!result || typeof result !== 'object') return { outcome: 'error', message: 'No result' };
	const status = result.status as string | undefined;
	if (status === 'error' || result.success === false || (result.error && !status)) {
		return { outcome: 'error', message: result.error || 'Operation failed' };
	}
	if (status === 'skipped') return { outcome: 'skipped', message: result.reason };
	if (status === 'warning') return { outcome: 'warning', message: result.warning };
	return { outcome: 'success' };
}

// ---------------------------------------------------------------------------
// Repository type helpers
// ---------------------------------------------------------------------------

export function getRepoTypeIcon(repository: string): Component {
	if (repository.startsWith('/') || repository.startsWith('./')) return HardDrive;
	if (repository.startsWith('s3:')) return AmazonS3Icon;
	if (repository.startsWith('b2:')) return BackblazeIcon;
	if (repository.startsWith('azure:')) return AzureBlobIcon;
	if (repository.startsWith('gs:')) return GoogleCloudIcon;
	if (repository.startsWith('rest:')) return RestServerIcon;
	return Globe;
}

export function getRepoTypeLabel(repository: string): string {
	if (repository.startsWith('/') || repository.startsWith('./')) return 'Local';
	if (repository.startsWith('s3:')) return 'S3';
	if (repository.startsWith('b2:')) return 'Backblaze B2';
	if (repository.startsWith('azure:')) return 'Azure Blob';
	if (repository.startsWith('gs:')) return 'Google Cloud';
	if (repository.startsWith('rest:')) return 'REST';
	return 'Unknown';
}

// Repository/environment predicates live in the lucide-free shared module so
// server routes can import them without pulling in this file's icon deps (#37).
export { isLocalRepo, isRemoteEnvironment, localRepoNeedsSameHost } from '$lib/shared/repo-predicates';
export {
	normalizeMounts,
	normalizeStackMounts,
	mountTypeFromHostPath,
	groupContainersForBackup,
	volumesForStack,
	type VolumeInfo,
	type BackupItem,
	type RawContainer
} from '$lib/utils/mounts';

// ---------------------------------------------------------------------------
// Retention helpers
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
	keepLast?: number;
	keepDaily?: number;
	keepWeekly?: number;
	keepMonthly?: number;
	keepYearly?: number;
}

export interface BackupOptions {
	compression?: string;
	limitUpload?: string;
	limitDownload?: string;
	excludePatterns?: string;
	excludeCaches?: boolean;
	webhookSuccess?: string;
	webhookFailure?: string;
	/** Stack-dir entries the user DEselected in the "Stack files on the host" picker; excluded
	 * from the stack-dir capture (never load-bearing compose/.env - the server re-guards). */
	excludedStackFiles?: string[];
}

export function parseRetention(retention: string | RetentionPolicy | null | undefined): RetentionPolicy {
	if (!retention) return {};
	if (typeof retention === 'object') return retention;
	try {
		const parsed = JSON.parse(retention);
		// Extract only retention fields (ignore any extra properties)
		const { keepLast, keepDaily, keepWeekly, keepMonthly, keepYearly } = parsed;
		return { keepLast, keepDaily, keepWeekly, keepMonthly, keepYearly };
	} catch { return {}; }
}

export function parseOptions(options: string | BackupOptions | null | undefined): BackupOptions {
	if (!options) return {};
	if (typeof options === 'object') return options;
	try { return JSON.parse(options); } catch { return {}; }
}

export function retentionSummary(retention: string | RetentionPolicy | null | undefined): string {
	const r = parseRetention(retention);
	const parts = [
		r.keepLast && `${r.keepLast} last`,
		r.keepDaily && `${r.keepDaily}d`,
		r.keepWeekly && `${r.keepWeekly}w`,
		r.keepMonthly && `${r.keepMonthly}m`,
		r.keepYearly && `${r.keepYearly}y`
	].filter(Boolean);
	return parts.length > 0 ? `Keep ${parts.join('/')}` : '';
}

// ---------------------------------------------------------------------------
// Cron helpers
// ---------------------------------------------------------------------------

export function formatCron(cron: string | null): string {
	if (!cron) return '—';
	try { return cronstrue.toString(cron, { use24HourTimeFormat: true }); } catch { return cron; }
}

// ---------------------------------------------------------------------------
// Config body assembly + action orchestration
//
// Shared between BackupPanel (the in-modal Backups tab) and CreateBackupModal
// (the standalone wizard) so neither can silently drift on what gets POSTed.
//
// The historical bug this exists to prevent: BackupPanel's old "Run once"
// path silently omitted selectedVolumes, letting the backend default to
// allVolumes=true. With buildBackupConfigBody as the single source of truth,
// any field added below is automatically sent by every action.
// ---------------------------------------------------------------------------

/**
 * Form state required to construct a /api/backup/configs body. `retention`
 * and `options` are optional — the wizard (CreateBackupModal) doesn't expose
 * them, the in-modal form (BackupPanel) does.
 */
export interface BackupFormState {
	targetName: string;
	type: 'container' | 'stack';
	environmentId: number | null | undefined;
	destinationId: number;
	stopBeforeBackup: boolean;
	allVolumes: boolean;
	selectedVolumes: string[];
	retention?: RetentionPolicy;
	options?: BackupOptions;
}

/**
 * Decides what happens after the config exists:
 *   save      — POST/PUT and stop. Schedule field is honored, enabled flag honored.
 *   save-run  — same as save, then immediately fires /run on the saved config.
 *   run-once  — POSTs a disabled config with no schedule, runs it, then deletes
 *               it. Snapshot remains in the repo (browseable, restorable as an
 *               orphan) but no zombie config row is left behind.
 */
export type BackupAction = 'save' | 'save-run' | 'run-once';

export interface BuildBodyOptions {
	enabled: boolean;
	/** Set to null to explicitly clear the schedule (run-once needs this). */
	schedule: string | null;
}

/** Pure: assemble the POST/PUT body. Single source of truth. */
export function buildBackupConfigBody(
	form: BackupFormState,
	opts: BuildBodyOptions
): Record<string, any> {
	return {
		targetName: form.targetName,
		type: form.type,
		destinationId: form.destinationId,
		environmentId: form.environmentId,
		enabled: opts.enabled,
		schedule: opts.schedule,
		retention: form.retention,
		options: form.options,
		stopBeforeBackup: form.stopBeforeBackup,
		// Persist allVolumes explicitly (audit #38) — the server's selection filter
		// keys on `!config.allVolumes`, so omitting it here left the DB column stale
		// on update and could apply/skip the filter incorrectly.
		allVolumes: form.allVolumes,
		selectedVolumes: form.allVolumes ? null : form.selectedVolumes
	};
}

export interface RunBackupActionInput {
	form: BackupFormState;
	action: BackupAction;
	/** Existing config to update (PUT). Omit for new-config flow (POST). */
	editingConfigId?: number | null;
	/** Cron expression to persist when action !== 'run-once'. Ignored for run-once. */
	schedule: string;
	enabled: boolean;
	/** Streams restic progress lines from the /run job. No-op by default. */
	onProgress?: (line: { event?: string; data: unknown }) => void;
	/** Called with the config id once the backup is about to run, so the caller can
	 * offer a Cancel button while it's in flight. */
	onStarted?: (configId: number) => void;
}

export interface RunBackupActionResult {
	ok: boolean;
	configId?: number;
	snapshotId?: string;
	error?: string;
}

/**
 * Orchestrate the full action sequence: POST/PUT the config, optionally /run
 * it, optionally delete it. Returns a tagged result so callers can decide what
 * toast to fire and what to do with the result.
 *
 * Errors are returned in the result rather than thrown — the caller has more
 * context (which target, which environment) to render a useful error toast.
 */
export async function runBackupAction(input: RunBackupActionInput): Promise<RunBackupActionResult> {
	const { form, action, editingConfigId, onProgress } = input;

	// Build the body that matches the requested action. Run-once forces
	// enabled=false + schedule=null regardless of what the user typed.
	const persistedBody = buildBackupConfigBody(form, {
		enabled: action === 'run-once' ? false : input.enabled,
		schedule: action === 'run-once' ? null : (input.schedule || null)
	});

	// A run-once now KEEPS its config, so running one twice for the same target
	// must not pile up duplicate configs. Reuse an existing config for the same
	// (target, type, env, destination) if one is already there — PUT it instead of
	// POSTing a new one. (Edits already carry editingConfigId and skip this.)
	let reuseId = editingConfigId ?? null;
	if (action === 'run-once' && reuseId == null) {
		try {
			const params = new URLSearchParams({ type: form.type, target: form.targetName });
			if (form.environmentId != null) params.set('env', String(form.environmentId));
			const res = await fetch(`/api/backup/configs?${params}`);
			if (res.ok) {
				const list = await res.json();
				const arr = Array.isArray(list) ? list : (list?.id ? [list] : []);
				const match = arr.find((c: any) => c.destinationId === form.destinationId);
				if (match?.id) reuseId = match.id;
			}
		} catch { /* fall through to POST a fresh config */ }
	}

	// Step 1 — persist. PUT when we have a config to reuse (edit or a matching
	// run-once target), POST otherwise.
	let configId: number;
	try {
		const isPut = reuseId != null;
		const url = isPut ? `/api/backup/configs/${reuseId}` : '/api/backup/configs';
		const res = await fetch(url, {
			method: isPut ? 'PUT' : 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(persistedBody)
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			return { ok: false, error: data.error || `Failed to ${isPut ? 'update' : 'create'} backup config` };
		}
		const body = await res.json();
		configId = isPut ? (reuseId as number) : body.id;
	} catch (err: any) {
		return { ok: false, error: err?.message || 'Failed to save config' };
	}

	// Step 2 — if just saving, we're done.
	if (action === 'save') return { ok: true, configId };

	// Step 3 — run the backup. Both 'save-run' and 'run-once' land here.
	let snapshotId: string | undefined;
	let runError: string | undefined;
	// Report the config id now so the caller can offer a Cancel while it runs.
	input.onStarted?.(configId);
	try {
		// When the caller wants live output (onProgress), ask for the JOB-POLLING path
		// (returns { jobId } → we stream via watchJob). `Accept: application/json` takes
		// the SYNCHRONOUS server path instead, which produces NO progress lines — that's
		// only for tests/CLI that don't stream. Requesting the wrong one is why the log
		// modal was empty ("Backup completed" but 0 lines).
		const wantsStream = typeof onProgress === 'function';
		const runRes = await fetch(`/api/backup/configs/${configId}/run`, {
			method: 'POST',
			headers: { 'Accept': wantsStream ? 'text/event-stream' : 'application/json' }
		});
		const runData = await runRes.json().catch(() => ({}));

		if (runData.jobId) {
			// SSE-style job — poll until done. onProgress streams progress lines.
			// Imported lazily so this module stays Svelte-runtime-free at the
			// top level (callers in non-browser contexts can still buildBody).
			const { watchJob } = await import('$lib/utils/sse-fetch');
			const result: any = await watchJob(runData.jobId, (line) => { onProgress?.(line); });
			const { outcome, message } = classifyJobResult(result);
			// 'skipped' (concurrent overlap / prune guard) is neither success nor a
			// hard failure — surface the reason so the caller isn't told it succeeded.
			if (outcome === 'error' || outcome === 'skipped') {
				runError = message || 'Backup failed';
			} else {
				snapshotId = result?.snapshotId;
			}
		} else {
			// Synchronous JSON path (Accept: application/json). Same union shape.
			const { outcome, message } = classifyJobResult(runData);
			if (outcome === 'error' || outcome === 'skipped') {
				runError = message || 'Backup failed';
			} else {
				snapshotId = runData.snapshotId;
			}
		}
	} catch (err: any) {
		runError = err?.message || 'Backup failed';
	}

	// A 'run-once' backup KEEPS its config (enabled=false, schedule=null) so the
	// target stays on the backups list with a working "Run backup now" button and a
	// delete action. Previously the config was deleted here, which turned every
	// one-off backup into an orphan (no re-run possible). The user removes it
	// explicitly via the delete action when they no longer want it.
	if (runError) return { ok: false, configId, error: runError };
	return { ok: true, configId, snapshotId };
}

/**
 * Tag a progress line for LogConsole's source pills. Dockhand's own status lines
 * carry no `[source]` prefix, so tag them `[dockhand]`; restic/FS-op lines already
 * arrive tagged (`[restic]`/`[dockhand]`) and pass through unchanged. Shared by
 * every place that streams backup/restore progress into LogConsole.
 */
export function tagLogLine(msg: string): string {
	return /^\[[a-z0-9_-]+\]/i.test(msg) ? msg : `[dockhand] ${msg}`;
}

// ---------------------------------------------------------------------------
// Backup execution history + ok/fail tally
// ---------------------------------------------------------------------------

/**
 * Fetch backup executions for a target's config ids and compute an ok/fail tally.
 * Used by the container/stack modal (tab counters + History tab) and the main
 * Backups page. Merges across multiple configs (a target can back up to more than
 * one repo). Network shell around {@link computeExecutionTally}.
 *
 * Pass `repoByConfig` (configId → {repository, name}) to stamp each run with which
 * repo it wrote to — the History table shows a Repo column when this is present.
 */
export async function fetchBackupExecutions(
	configIds: number[],
	limit = 50,
	repoByConfig?: Map<number, { repository?: string; name?: string }>
): Promise<ExecutionTally> {
	if (!configIds.length) return { executions: [], ok: 0, failed: 0 };
	const all: Execution[] = [];
	await Promise.all(configIds.map(async (id) => {
		try {
			const res = await fetch(`/api/schedules/executions?scheduleType=backup&scheduleId=${id}&limit=${limit}`);
			if (!res.ok) return;
			const data = await res.json();
			const dest = repoByConfig?.get(id);
			for (const e of data.executions || []) {
				const exec = e as Execution;
				if (dest) { exec._repository = dest.repository; exec._destinationName = dest.name; }
				all.push(exec);
			}
		} catch { /* one config's history is best-effort */ }
	}));
	return computeExecutionTally(all);
}
