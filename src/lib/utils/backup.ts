/**
 * Shared backup utilities — used by BackupPanel, BackupsTab, RestoreModal, backups page.
 */

import { HardDrive, Globe, Server } from 'lucide-svelte';
import { AmazonS3Icon, BackblazeIcon, AzureBlobIcon, GoogleCloudIcon, RestServerIcon } from '$lib/components/cloud-icons';
import cronstrue from 'cronstrue';
import { DEFAULT_SCHEDULED_RETENTION } from '$lib/shared/backup-retention';
import { computeExecutionTally, resolveRunRepo, type Execution, type ExecutionTally } from '$lib/utils/execution-tally';
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

export function getRepoTypeIcon(repository: string) {
	if (repository.startsWith('/') || repository.startsWith('./')) return HardDrive;
	if (repository.startsWith('s3:')) return AmazonS3Icon;
	if (repository.startsWith('b2:')) return BackblazeIcon;
	if (repository.startsWith('azure:')) return AzureBlobIcon;
	if (repository.startsWith('gs:')) return GoogleCloudIcon;
	if (repository.startsWith('rest:')) return RestServerIcon;
	if (repository.startsWith('sftp:')) return Server;
	return Globe;
}

export function getRepoTypeLabel(repository: string): string {
	if (repository.startsWith('/') || repository.startsWith('./')) return 'Local';
	if (repository.startsWith('s3:')) return 'S3';
	if (repository.startsWith('b2:')) return 'Backblaze B2';
	if (repository.startsWith('azure:')) return 'Azure Blob';
	if (repository.startsWith('gs:')) return 'Google Cloud';
	if (repository.startsWith('rest:')) return 'REST';
	if (repository.startsWith('sftp:')) return 'SFTP';
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

/** `locale` is a cronstrue locale (see $lib/i18n/cron); English when omitted. */
export function formatCron(cron: string | null, locale?: string): string {
	if (!cron) return '—';
	try { return cronstrue.toString(cron, { use24HourTimeFormat: true, ...(locale && { locale }) }); } catch { return cron; }
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

/** What a config edit saves: a manual one keeps no cron and stays off, so no schedule is invented. */
export function scheduleToSave(scheduled: boolean, schedule: string, enabled: boolean): { schedule: string; enabled: boolean } {
	return scheduled ? { schedule, enabled } : { schedule: '', enabled: false };
}

export interface RetentionFields { keepLast: number; keepDaily: number; keepWeekly: number; keepMonthly: number; keepYearly: number }

/**
 * The form's retention when the schedule toggle flips. Switching a schedule on with no
 * policy shows the default the server stores for it; switching off again before saving
 * gives back what was there, so a manual config does not pick up a policy on the way.
 * `saved` is what the switch-on replaced, carried between the two calls.
 */
export function retentionOnScheduleToggle(on: boolean, current: RetentionFields, saved: RetentionFields | null): { retention: RetentionFields; saved: RetentionFields | null } {
	const fromDefault = { keepLast: 0, keepYearly: 0, ...DEFAULT_SCHEDULED_RETENTION };
	const same = (a: RetentionFields, b: RetentionFields) => (Object.keys(a) as (keyof RetentionFields)[]).every((k) => a[k] === b[k]);
	if (on) {
		const empty = Object.values(current).every((v) => !v);
		return empty ? { retention: fromDefault, saved: current } : { retention: current, saved: null };
	}
	return saved && same(current, fromDefault) ? { retention: saved, saved: null } : { retention: current, saved: null };
}

/**
 * Whether a duplicated config should start enabled.
 *
 * A manual config is stored disabled because it has no schedule; its copy exists to
 * be given one, so it starts enabled. A copy of a scheduled config keeps whatever
 * the original was, so duplicating a paused schedule does not quietly resume it.
 */
export function duplicateStartsEnabled(source: { schedule?: string | null; enabled?: boolean }): boolean {
	if (!source.schedule) return true;
	return source.enabled !== false;
}

/**
 * Destination for a duplicated schedule: the first repository this target has no
 * schedule for yet, so the copy lands elsewhere by default; else the source's own.
 */
export function pickDuplicateDestinationId(
	sourceDestinationId: number,
	destinationIds: number[],
	usedDestinationIds: number[]
): number {
	return destinationIds.find((id) => !usedDestinationIds.includes(id)) ?? sourceDestinationId;
}

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
 *
 * `destById` (destinationId → {repository, name}) takes precedence per run: a run
 * records the destination it ACTUALLY wrote to in `details.destinationId`, so the
 * History reports that rather than the config's current destination, which changes
 * when the schedule is re-pointed (#1783). `repoByConfig` is the fallback for runs
 * that predate the stamp.
 */
export async function fetchBackupExecutions(
	configIds: number[],
	limit = 50,
	repoByConfig?: Map<number, { repository?: string; name?: string }>,
	destById?: Map<number, { repository?: string; name?: string }>
): Promise<ExecutionTally> {
	if (!configIds.length) return { executions: [], ok: 0, failed: 0 };
	const all: Execution[] = [];
	await Promise.all(configIds.map(async (id) => {
		try {
			const res = await fetch(`/api/schedules/executions?scheduleType=backup&scheduleId=${id}&limit=${limit}`);
			if (!res.ok) return;
			const data = await res.json();
			const configDest = repoByConfig?.get(id);
			for (const e of data.executions || []) {
				const exec = e as Execution;
				// The destination this run actually used wins; fall back to the config's
				// current destination for older runs with no stamp (#1783).
				const dest = resolveRunRepo(exec.details?.destinationId, destById, configDest);
				if (dest) { exec._repository = dest.repository; exec._destinationName = dest.name; }
				all.push(exec);
			}
		} catch { /* one config's history is best-effort */ }
	}));
	return computeExecutionTally(all);
}

/**
 * Does a snapshot (by its restic tags) belong to the stack/container Backups view for a
 * given set of ENV-SCOPED config ids? A same-name stack on another environment writes to
 * the same shared repo and carries the same `dockhand:name=<target>` tag, so filtering by
 * name alone mixed snapshots (and "latest") across environments (#1546). `configIds` are
 * already env-scoped by the caller and `dockhand:configid` uniquely identifies a
 * (target, env) config, so we match on that. When no config ids are known (should not
 * happen once a target has any backup config) fall back to the name tag rather than hide
 * everything. Pure + unit-testable.
 */
export function snapshotMatchesConfigScope(
	tags: string[] | undefined,
	configIds: number[],
	targetName: string
): boolean {
	const t = tags ?? [];
	if (configIds.length > 0) {
		for (const tag of t) {
			if (tag.startsWith('dockhand:configid=')) {
				const n = Number(tag.slice('dockhand:configid='.length));
				if (Number.isInteger(n) && configIds.includes(n)) return true;
			}
		}
		return false;
	}
	return t.includes(`dockhand:name=${targetName}`);
}

/**
 * Pick THIS target's snapshots from one destination's raw restic list and stamp each with
 * the destination it came from - the exact filter+map the Backups panel applies per
 * destination. Extracted so the wired call site (not just snapshotMatchesConfigScope in
 * isolation) is covered by a test: a regression back to a name-only filter changes this
 * helper's output and fails the suite (#1546).
 */
export function selectOwnSnapshotsFromDestination<S extends { tags?: string[] }>(
	snaps: S[],
	dest: { id: number; name: string; repository: string },
	configIds: number[],
	targetName: string
): (S & { _destinationId: number; _destinationName: string; _destinationRepository: string })[] {
	return snaps
		.filter((s) => snapshotMatchesConfigScope(s.tags, configIds, targetName))
		.map((s) => ({ ...s, _destinationId: dest.id, _destinationName: dest.name, _destinationRepository: dest.repository }));
}

/**
 * Every live config's snapshots of this install, from each destination's full listing:
 * a config's from every destination holding them (a schedule moved to another destination
 * keeps its older ones there), each id once, newest first. Everything else (a deleted
 * config's or another install's) is an orphan, grouped by destination and target name.
 */
export function indexDestinationSnapshots<S extends { id: string; time: string; tags?: string[] | null }>(
	byDestination: Map<number, S[]>,
	liveConfigIds: Set<number>,
	thisInstance: string
): { perConfig: Map<number, S[]>; orphans: Array<{ key: string; destinationId: number; targetName: string; snapshots: S[] }> } {
	const tagVal = (snap: S, prefix: string) => (snap.tags || []).find((t) => t.startsWith(prefix))?.slice(prefix.length);
	const add = <K>(m: Map<K, S[]>, k: K, snap: S) => {
		const list = m.get(k);
		if (list) list.push(snap); else m.set(k, [snap]);
	};
	const perConfig = new Map<number, S[]>();
	const orphans: Array<{ key: string; destinationId: number; targetName: string; snapshots: S[] }> = [];
	for (const [destinationId, snaps] of byDestination) {
		const orphanByName = new Map<string, S[]>();
		for (const snap of snaps) {
			const cid = Number(tagVal(snap, 'dockhand:configid='));
			if (tagVal(snap, 'dockhand:instance=') === thisInstance && Number.isInteger(cid) && liveConfigIds.has(cid)) add(perConfig, cid, snap);
			else add(orphanByName, tagVal(snap, 'dockhand:name=') || 'unknown', snap);
		}
		for (const [targetName, list] of orphanByName) {
			orphans.push({ key: `orphan-${targetName}-${destinationId}`, destinationId, targetName, snapshots: newestFirst(list) });
		}
	}
	for (const [cid, list] of perConfig) perConfig.set(cid, newestFirst(list));
	return { perConfig, orphans };
}

/** Newest first, a snapshot seen on two destinations sharing a repository once. */
function newestFirst<S extends { id: string; time: string }>(list: S[]): S[] {
	const seen = new Set<string>();
	return list
		.filter((s) => {
			if (seen.has(s.id)) return false;
			seen.add(s.id);
			return true;
		})
		.map((s) => ({ s, t: new Date(s.time).getTime() }))
		.sort((a, b) => b.t - a.t)
		.map(({ s }) => s);
}

/** The lists with one config's snapshots of this install dropped from one destination, once they are forgotten there. */
export function withoutConfigSnapshots<S extends { tags?: string[] | null }>(
	byDestination: Map<number, S[]>,
	destinationId: number,
	configId: number,
	thisInstance: string
): Map<number, S[]> {
	const list = byDestination.get(destinationId);
	if (!list) return byDestination;
	const own = (s: S) => (s.tags || []).includes(`dockhand:configid=${configId}`) && (s.tags || []).includes(`dockhand:instance=${thisInstance}`);
	return new Map(byDestination).set(destinationId, list.filter((s) => !own(s)));
}

/**
 * A destination's listing applied to the page state: a list replaces the previous one and
 * clears its error; a failure records the error and keeps the previous list on screen.
 */
export function applyDestinationListing<S>(
	lists: Map<number, S[]>,
	errors: Map<number, string>,
	destinationId: number,
	result: { snapshots: S[] } | { error: string }
): { lists: Map<number, S[]>; errors: Map<number, string> } {
	const nextErrors = new Map(errors);
	if ('error' in result) {
		nextErrors.set(destinationId, result.error);
		return { lists, errors: nextErrors };
	}
	nextErrors.delete(destinationId);
	return { lists: new Map(lists).set(destinationId, result.snapshots), errors: nextErrors };
}

/**
 * The destinations whose listing can change a config's row: its current one, every one
 * it lists snapshots from, and any not read yet (it may hold some).
 */
export function rowDestinationIds(
	currentId: number,
	snapshots: Array<{ _destinationId?: number }>,
	destinationIds: number[],
	isListed: (id: number) => boolean
): number[] {
	return destinationIds.filter((id) => id === currentId || !isListed(id) || snapshots.some((s) => s._destinationId === id));
}

/** restic diffs two snapshots of ONE repository, so a pair from two destinations cannot be compared. */
export function canDiffSnapshots(a: { _destinationId?: number }, b: { _destinationId?: number }): boolean {
	return a._destinationId === b._destinationId;
}

/**
 * Group snapshots by their destination id, returning `{ destinationId, snapshotIds }`
 * batches. Bulk delete needs this because `restic forget` runs against ONE repo at a
 * time, so a selection spanning multiple destinations becomes one batch call per dest.
 * Pure so the grouping is unit-tested independently of the UI.
 */
export function groupSnapshotIdsByDestination<S extends { id: string; _destinationId: number }>(
	snaps: S[]
): { destinationId: number; snapshotIds: string[] }[] {
	const byDest = new Map<number, string[]>();
	for (const s of snaps) {
		const arr = byDest.get(s._destinationId) ?? [];
		arr.push(s.id);
		byDest.set(s._destinationId, arr);
	}
	return [...byDest.entries()].map(([destinationId, snapshotIds]) => ({ destinationId, snapshotIds }));
}

export interface BulkDeleteResult {
	deleted: number;
	skipped: number;
	/** true if any destination's batch call returned a non-2xx. */
	failed: boolean;
	/** Raw restic error from the first failing destination (repo locked, timeout, etc.),
	 * surfaced verbatim so the user sees the real reason instead of a generic message. */
	error?: string;
}

/**
 * Delete many snapshots via the batch endpoint, grouped by destination (one
 * `restic forget --prune` per repo). Shared by every snapshot list (containers/stacks
 * backup modal, the Backups page, the Settings repo browser) so the delete logic is one
 * place. Callers own the UI (toasts, reload); this only performs the calls and tallies.
 */
export async function bulkDeleteSnapshots(
	targets: { id: string; _destinationId: number }[]
): Promise<BulkDeleteResult> {
	let deleted = 0, skipped = 0, failed = false, error: string | undefined;
	for (const { destinationId, snapshotIds } of groupSnapshotIdsByDestination(targets)) {
		try {
			const res = await fetch('/api/backup/snapshots/batch-delete', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ destinationId, snapshotIds })
			});
			const data = await res.json().catch(() => ({}));
			deleted += data.deleted?.length ?? 0;
			if (res.ok) skipped += data.skipped?.length ?? 0;
			else {
				failed = true;
				if (!error && data.error) error = String(data.error);
			}
		} catch {
			failed = true;
		}
	}
	return { deleted, skipped, failed, error };
}

/**
 * A hard restic failure that warrants the full-error dialog (repo locked, timeout,
 * etc.) rather than a toast. Returns the raw restic error and how many were still
 * deleted, or null when there is no such failure (toast handles success/skipped).
 * A `failed` with no `error` (e.g. a thrown fetch) also returns null - nothing
 * verbatim to show - so the caller falls back to the toast.
 */
export function bulkDeleteFailure(r: BulkDeleteResult): { error: string; deleted: number } | null {
	if (r.failed && r.error) return { error: r.error, deleted: r.deleted };
	return null;
}

/**
 * Consistent toast wording for a bulk-delete result, shared by every snapshot list.
 * Returns { type, message } so each caller fires its own toast (import stays local).
 * A hard restic failure with a verbatim error is handled by the caller via
 * bulkDeleteFailure + the error dialog, not here.
 */
export function bulkDeleteToast(r: BulkDeleteResult): { type: 'success' | 'error'; message: string } {
	if (r.failed) return { type: 'error', message: r.deleted > 0 ? `Deleted ${r.deleted}, but some snapshots could not be deleted` : 'Snapshots could not be deleted' };
	if (r.deleted === 0 && r.skipped > 0) return { type: 'error', message: `${r.skipped} snapshot${r.skipped === 1 ? '' : 's'} could not be deleted (not owned or no access)` };
	return { type: 'success', message: `Deleted ${r.deleted} snapshot${r.deleted === 1 ? '' : 's'}${r.skipped > 0 ? ` (${r.skipped} skipped)` : ''}` };
}
