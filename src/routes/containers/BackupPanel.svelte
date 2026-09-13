<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import { Save, Play, Pause, RefreshCw, CheckCircle, XCircle, ChevronDown, Loader2, Plus, Trash2, Pencil, X, Check, HardDrive, Box, Layers, FileText, FolderOpen, AlertTriangle } from 'lucide-svelte';
	import RotateCwFadingClock from '$lib/components/icons/RotateCwFadingClock.svelte';
	import VolumePicker from '$lib/components/backup/VolumePicker.svelte';
	import StackFilesPicker from '$lib/components/backup/StackFilesPicker.svelte';
	import DestinationPicker from '$lib/components/backup/DestinationPicker.svelte';
	import LogConsole from '$lib/components/LogConsole.svelte';
	import SnapshotsPanel from './SnapshotsPanel.svelte';
	import ExecutionHistoryList from '$lib/components/ExecutionHistoryList.svelte';
	import ExecutionLogViewer from '$lib/components/ExecutionLogViewer.svelte';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { currentEnvironment, appendEnvParam, environments } from '$lib/stores/environment';
	import { formatDateTime } from '$lib/stores/settings';
	import { watchJob } from '$lib/utils/sse-fetch';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { getRepoTypeIcon, parseRetention, parseOptions, retentionSummary as getRetentionSummary, formatCron, runBackupAction, classifyJobResult, tagLogLine, fetchBackupExecutions, type BackupAction, type BackupFormState } from '$lib/utils/backup';
	import { reconcileSelectedVolumeKeys } from '$lib/utils/mounts';

	interface Props {
		containerName: string;
		volumes: { key: string; name: string; mountPoint: string; mountType?: 'volume' | 'bind' }[];
		type?: 'container' | 'stack';
		environmentId?: number;
		onConfigSaved?: () => void;
		autoShowRunForm?: boolean;
		/** Reports the ok/fail run tally so the parent modal can badge its Backups tab. */
		onTally?: (tally: { ok: number; failed: number }) => void;
	}

	let { containerName, volumes, type = 'container', environmentId, onConfigSaved, autoShowRunForm = false, onTally }: Props = $props();

	interface Destination { id: number; name: string; repository: string; hostPath?: string | null; }
	interface BackupConfig {
		id: number; destinationId: number; enabled: boolean; schedule: string;
		retention: string | null; options?: string | null; stopBeforeBackup: boolean; selectedVolumes: string[] | null;
		lastBackupStatus?: string | null; lastBackupAt?: string | null;
	}

	const getTypeIcon = getRepoTypeIcon;

	// Sub-tabs: Schedules (this panel) and Snapshots (lazily mounted — its snapshot
	// listing hits every repo over the network, so it must NOT run until the user
	// actually opens the tab, to keep the container/stack modal responsive).
	let subTab = $state<'schedules' | 'snapshots' | 'history'>('schedules');
	// Snapshot count + loading state, reported by SnapshotsPanel (which loads in the
	// background as soon as the Backups view opens). null count = not loaded yet.
	let snapshotCount = $state<number | null>(null);
	let snapshotsLoading = $state(false);
	// Execution history + ok/fail tally, loaded from the executions API for this
	// target's configs. Powers the History sub-tab and the parent modal's tab badge.
	let executions = $state<import('$lib/utils/execution-tally').Execution[]>([]);
	let tally = $state<{ ok: number; failed: number }>({ ok: 0, failed: 0 });
	let historyLoading = $state(false);
	// Backup-run log viewer (opened from the History table's log button).
	let logDialogOpen = $state(false);
	let logDialogContent = $state<string | null>(null);
	let logDialogLoading = $state(false);
	// The list query omits the (potentially large) logs column, so fetch the single
	// execution's logs on demand from the detail endpoint — otherwise the dialog
	// always showed "No log output".
	async function viewExecutionLog(id: number) {
		logDialogContent = null;
		logDialogLoading = true;
		logDialogOpen = true;
		try {
			const res = await fetch(`/api/schedules/executions/${id}`);
			if (res.ok) {
				const detail = await res.json();
				logDialogContent = detail?.logs ?? null;
			}
		} catch { /* leave null → "No log output" */ }
		finally { logDialogLoading = false; }
	}
	// Ref to the (always-mounted) snapshots panel so a manual backup can force it to
	// reload — a new snapshot won't show up otherwise (the panel loads once on mount).
	let snapshotsPanel = $state<{ refresh: () => Promise<void> } | null>(null);

	let destinations = $state<Destination[]>([]);
	let configs = $state<BackupConfig[]>([]);
	let loading = $state(true);
	let runningBackup = $state<number | null>(null);
	let confirmDeleteId = $state<number | null>(null);

	// Edit form state
	let editingConfig = $state<BackupConfig | null>(null);
	let isNew = $state(false);
	let editDestinationId = $state(0);
	let editEnabled = $state(true);
	let editSchedule = $state('0 2 * * *');
	let editScheduleInvalid = $state(false);
	let editKeepLast = $state(7);
	let editKeepDaily = $state(0);
	let editKeepWeekly = $state(0);
	let editKeepMonthly = $state(0);
	let editKeepYearly = $state(0);
	let editExclude = $state('');
	let editExcludeCaches = $state(true);
	let editCompression = $state('auto');
	let editLimitUpload = $state('');
	let editLimitDownload = $state('');
	let editWebhookSuccess = $state('');
	let editWebhookFailure = $state('');
	let editStopBefore = $state(false);
	let editAllVolumes = $state(true);
	let editSelectedVolumes = $state<string[]>([]);
	let saving = $state(false);
	// Tracks which submit action is in-flight so we can disable the right
	// button and show the right spinner. The form itself is unified — only
	// the post-submit behavior differs.
	let submitAction = $state<'save' | 'save-run' | 'run-once' | null>(null);
	let showAdvanced = $state(false);

	// Live restic progress for a manual backup run (Run once / Save & run now, and
	// the per-config Run-now button). Streamed into a modal so the user sees the
	// same restic output the CreateBackupModal wizard shows.
	let progressOpen = $state(false);
	let progressLogs = $state<string[]>([]);
	let progressStatus = $state<'running' | 'success' | 'error'>('running');
	let progressError = $state('');
	// Which repo the in-flight run targets, for the progress-modal header.
	let progressDestId = $state<number>(0);
	// The config id of the running backup, so the modal's Cancel can stop it.
	let progressConfigId = $state<number | null>(null);
	let cancelling = $state(false);

	async function cancelRunningBackup() {
		if (progressConfigId == null || cancelling) return;
		cancelling = true;
		try {
			const res = await fetch(`/api/backup/configs/${progressConfigId}/stop`, { method: 'POST' });
			if (res.ok) {
				progressLogs = [...progressLogs, '[dockhand] Cancelling backup…'];
			} else {
				const d = await res.json().catch(() => ({}));
				toast.error(d.error || 'Failed to cancel backup');
			}
		} catch {
			toast.error('Failed to cancel backup');
		} finally {
			cancelling = false;
		}
	}
	// Header bits: the type icon, the target repo (with its type icon), and the env.
	const TypeIcon = $derived(type === 'stack' ? Layers : Box);
	const progressDest = $derived(destinations.find((d) => d.id === progressDestId));
	const progressEnv = $derived($environments.find((e) => e.id === envId));

	const envId = $derived(environmentId ?? $currentEnvironment?.id ?? null);
	// The full env carries connectionType/host (currentEnvironment does not), needed
	// for the local-repo guard.
	const fullEnv = $derived($environments.find((e) => e.id === envId));

	async function fetchDestinations() {
		try {
			const res = await fetch('/api/backup/destinations');
			if (res.ok) destinations = await res.json();
		} catch {}
	}

	async function fetchConfigs() {
		loading = true;
		try {
			const params = new URLSearchParams({ target: containerName, type });
			if (envId) params.set('env', String(envId));
			const res = await fetch(`/api/backup/configs?${params}`);
			if (res.ok) {
				const results = await res.json();
				configs = Array.isArray(results) ? results : results?.id ? [results] : [];
				// Auto-open the unified create form when there are no configs
				// (used by the backup wizard entry point so the user doesn't
				// have to click "Add schedule" first on an empty list).
				if (configs.length === 0 && !isNew && !editingConfig && autoShowRunForm) startNewConfig();
				void loadHistory();
			}
		} catch {} finally { loading = false; }
	}

	// Load run history + tally as soon as the configs are known — the parent modal's
	// tab badge needs the ok/fail counts without the user opening the History tab.
	async function loadHistory() {
		const ids = configs.map((c) => c.id);
		if (ids.length === 0) { executions = []; tally = { ok: 0, failed: 0 }; onTally?.(tally); return; }
		historyLoading = true;
		try {
			// Map each config to its destination so the History table can show a Repo
			// column — a target can back up to more than one repo.
			const repoByConfig = new Map(configs.map((c) => {
				const d = destinations.find((x) => x.id === c.destinationId);
				return [c.id, { repository: d?.repository, name: d?.name }] as const;
			}));
			const r = await fetchBackupExecutions(ids, 50, repoByConfig);
			executions = r.executions;
			tally = { ok: r.ok, failed: r.failed };
			onTally?.(tally);
		} finally { historyLoading = false; }
	}

	function startNewConfig() {
		editingConfig = null;
		isNew = true;
		editDestinationId = destinations[0]?.id || 0;
		editEnabled = true;
		editSchedule = '0 2 * * *';
		editKeepLast = 7; editKeepDaily = 0; editKeepWeekly = 0; editKeepMonthly = 0; editKeepYearly = 0;
		editExclude = ''; editExcludeCaches = true; editCompression = 'auto'; editLimitUpload = ''; editLimitDownload = '';
		editWebhookSuccess = ''; editWebhookFailure = '';
		editStopBefore = false;
		editAllVolumes = true;
		editSelectedVolumes = [];
		showAdvanced = false;
	}

	function startEditConfig(cfg: BackupConfig) {
		editingConfig = cfg;
		isNew = false;
		editDestinationId = cfg.destinationId;
		editEnabled = cfg.enabled;
		editSchedule = cfg.schedule || '0 2 * * *';
		const ret = parseRetention(cfg.retention);
		editKeepLast = ret.keepLast || 0;
		editKeepDaily = ret.keepDaily || 0;
		editKeepWeekly = ret.keepWeekly || 0;
		editKeepMonthly = ret.keepMonthly || 0;
		editKeepYearly = ret.keepYearly || 0;
		const opts = parseOptions(cfg.options);
		editExclude = opts.excludePatterns || '';
		editExcludeCaches = opts.excludeCaches !== false;
		editCompression = opts.compression || 'auto';
		editLimitUpload = opts.limitUpload || '';
		editLimitDownload = opts.limitDownload || '';
		editWebhookSuccess = opts.webhookSuccess || '';
		editWebhookFailure = opts.webhookFailure || '';
		excludedStackFiles = Array.isArray(opts.excludedStackFiles) ? opts.excludedStackFiles : [];
		editStopBefore = cfg.stopBeforeBackup;
		editAllVolumes = cfg.selectedVolumes === null;
		const storedSel = cfg.selectedVolumes ? (typeof cfg.selectedVolumes === 'string' ? JSON.parse(cfg.selectedVolumes) : cfg.selectedVolumes) : [];
		// Reconcile a stored selection (may hold legacy names) to the current volume keys.
		editSelectedVolumes = reconcileSelectedVolumeKeys(volumes, storedSel);
		showAdvanced = false;
	}

	function cancelEdit() {
		editingConfig = null;
		isNew = false;
	}

	/**
	 * Does the inline backup edit-form hold unsaved changes? Called by the parent
	 * modal (EditContainerModal / StackModal) before it closes, so a half-edited
	 * schedule (cron / keep-last / options) doesn't vanish silently.
	 *
	 * - A NEW config form open = dirty (the user started creating one, unsaved).
	 * - An EDIT form = dirty only if some field differs from the pristine config.
	 *   The comparison mirrors startEditConfig() exactly, in reverse, so it matches
	 *   what a save would persist (via parseRetention/parseOptions on editingConfig).
	 * - No form open (editingConfig null, not new) = not dirty.
	 */
	export function isDirty(): boolean {
		if (isNew) return true;
		if (!editingConfig) return false;
		const cfg = editingConfig;
		if (editDestinationId !== cfg.destinationId) return true;
		if (editEnabled !== cfg.enabled) return true;
		if (editSchedule !== (cfg.schedule || '0 2 * * *')) return true;
		const ret = parseRetention(cfg.retention);
		if (editKeepLast !== (ret.keepLast || 0)) return true;
		if (editKeepDaily !== (ret.keepDaily || 0)) return true;
		if (editKeepWeekly !== (ret.keepWeekly || 0)) return true;
		if (editKeepMonthly !== (ret.keepMonthly || 0)) return true;
		if (editKeepYearly !== (ret.keepYearly || 0)) return true;
		const opts = parseOptions(cfg.options);
		if (editExclude !== (opts.excludePatterns || '')) return true;
		if (editExcludeCaches !== (opts.excludeCaches !== false)) return true;
		if (editCompression !== (opts.compression || 'auto')) return true;
		if (editLimitUpload !== (opts.limitUpload || '')) return true;
		if (editLimitDownload !== (opts.limitDownload || '')) return true;
		if (editWebhookSuccess !== (opts.webhookSuccess || '')) return true;
		if (editWebhookFailure !== (opts.webhookFailure || '')) return true;
		if (editStopBefore !== cfg.stopBeforeBackup) return true;
		if (editAllVolumes !== (cfg.selectedVolumes === null)) return true;
		const storedSel = cfg.selectedVolumes
			? (typeof cfg.selectedVolumes === 'string' ? JSON.parse(cfg.selectedVolumes) : cfg.selectedVolumes)
			: [];
		// Reconcile the baseline to keys too, so a name->key format shift alone isn't seen as dirty.
		const origVolumes = reconcileSelectedVolumeKeys(volumes, storedSel);
		if (JSON.stringify([...editSelectedVolumes].sort()) !== JSON.stringify([...origVolumes].sort())) return true;
		return false;
	}

	/** Snapshot the current form fields into the shared BackupFormState shape. */
	function currentForm(): BackupFormState {
		return {
			targetName: containerName,
			type,
			environmentId: envId,
			destinationId: editDestinationId,
			stopBeforeBackup: editStopBefore,
			allVolumes: editAllVolumes,
			selectedVolumes: editSelectedVolumes,
			retention: {
				keepLast: editKeepLast || undefined,
				keepDaily: editKeepDaily || undefined,
				keepWeekly: editKeepWeekly || undefined,
				keepMonthly: editKeepMonthly || undefined,
				keepYearly: editKeepYearly || undefined
			},
			options: {
				excludePatterns: editExclude || undefined,
				excludeCaches: editExcludeCaches,
				compression: editCompression !== 'auto' ? editCompression : undefined,
				limitUpload: editLimitUpload || undefined,
				limitDownload: editLimitDownload || undefined,
				webhookSuccess: editWebhookSuccess || undefined,
				webhookFailure: editWebhookFailure || undefined,
				excludedStackFiles: excludedStackFiles.length > 0 ? excludedStackFiles : undefined
			}
		};
	}

	/**
	 * Pre-flight validation + delegation to runBackupAction. The shared helper
	 * does the heavy lifting (POST/PUT, optional /run, optional cleanup). All
	 * three submit buttons land here, then runBackupAction branches on action.
	 *
	 * Edit mode (editingConfig != null) only renders the 'save' button — the
	 * other actions don't apply to in-place edits.
	 */
	async function submitForm(action: BackupAction) {
		if (!editDestinationId) { toast.error('Select a backup repository'); return; }
		// A local repo on a non-co-located env is allowed here; it fails loud at run
		// time via the helper's localRepoGuard rather than being blocked up front.
		// Cron only matters when the schedule will be persisted. run-once
		// clears it server-side so the field value is irrelevant.
		if ((action === 'save' || action === 'save-run') && editScheduleInvalid) {
			toast.error('Schedule is invalid');
			return;
		}

		submitAction = action;
		saving = true;
		// A run action (run-once / save-run) streams restic output into the progress
		// modal. A plain save persists silently — no restic runs, so no log view.
		const runsBackup = action === 'run-once' || action === 'save-run';
		if (runsBackup) {
			progressLogs = [];
			progressError = '';
			progressStatus = 'running';
			progressDestId = editDestinationId;
			progressConfigId = editingConfig?.id ?? null; // set precisely via onStarted
			progressOpen = true;
		}
		try {
			const result = await runBackupAction({
				form: currentForm(),
				action,
				editingConfigId: editingConfig?.id ?? null,
				schedule: editSchedule,
				enabled: editEnabled,
				onStarted: runsBackup ? (id) => (progressConfigId = id) : undefined,
				onProgress: runsBackup ? (line) => {
					const msg = (line.data as { message?: string } | null)?.message;
					if (msg) progressLogs = [...progressLogs, tagLogLine(msg)];
				} : undefined
			});
			if (!result.ok) {
				if (runsBackup) { progressStatus = 'error'; progressError = result.error || 'Backup failed'; }
				else toast.error(result.error || 'Backup failed');
				return;
			}
			if (runsBackup) progressStatus = 'success';
			if (action === 'save') toast.success(isNew ? 'Backup schedule added' : 'Backup schedule updated');
			else toast.success(`Backup completed for ${containerName}`);
			editingConfig = null; isNew = false;
			fetchConfigs();
			// 'save-run'/'run-once' just wrote a snapshot — reload the list so it appears
			// without a manual refresh. A plain 'save' writes none, so skip it.
			if (runsBackup) { void snapshotsPanel?.refresh(); void loadHistory(); }
			onConfigSaved?.();
		} finally {
			saving = false;
			submitAction = null;
		}
	}

	async function deleteConfig(id: number) {
		try {
			const res = await fetch(`/api/backup/configs/${id}`, { method: 'DELETE' });
			if (res.ok) {
				toast.success('Backup schedule removed');
				fetchConfigs();
				onConfigSaved?.();
			} else {
				toast.error('Failed to delete');
			}
		} catch { toast.error('Failed to delete'); }
		confirmDeleteId = null;
	}

	// Pause/resume a scheduled backup. A minimal PUT with only `enabled` is a
	// partial update (updateBackupConfig skips undefined fields) and the endpoint
	// re-registers or unregisters the croner job accordingly.
	let togglingId = $state<number | null>(null);
	async function togglePause(cfg: BackupConfig) {
		togglingId = cfg.id;
		try {
			const res = await fetch(`/api/backup/configs/${cfg.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: !cfg.enabled })
			});
			if (res.ok) {
				toast.success(cfg.enabled ? 'Schedule paused' : 'Schedule resumed');
				fetchConfigs();
				onConfigSaved?.();
			} else {
				toast.error('Failed to update schedule');
			}
		} catch { toast.error('Failed to update schedule'); }
		togglingId = null;
	}

	async function runBackupNow(cfg: BackupConfig) {
		runningBackup = cfg.id;
		progressLogs = [];
		progressError = '';
		progressStatus = 'running';
		progressDestId = cfg.destinationId;
		progressConfigId = cfg.id;
		progressOpen = true;
		try {
			const res = await fetch(`/api/backup/configs/${cfg.id}/run`, { method: 'POST' });
			const data = await res.json();
			if (data.jobId) {
				const result = await watchJob(data.jobId, (line) => {
					const msg = (line.data as { message?: string } | null)?.message;
					if (msg) progressLogs = [...progressLogs, tagLogLine(msg)];
				}) as any;
				const { outcome, message } = classifyJobResult(result);
				// 'skipped' (a concurrent op holds the lock, or a prune guard) is NOT a
				// success — surface it as an error in the modal, matching the main
				// backups page. Only 'success'/'warning' get the green result.
				if (outcome === 'error' || outcome === 'skipped') {
					progressStatus = 'error';
					progressError = message || (outcome === 'skipped' ? 'Backup skipped' : 'Backup failed');
				} else {
					progressStatus = 'success';
				}
				if (outcome === 'skipped') toast.info(message || 'Backup skipped');
				else if (outcome === 'warning') toast.warning(message || 'Backup completed with warnings');
				fetchConfigs();
				// A new snapshot was written (success/warning) — reload the list so it
				// shows up without a manual refresh. Skipped = no snapshot, nothing to do.
				if (outcome !== 'skipped') void snapshotsPanel?.refresh();
				void loadHistory(); // a run (even failed/skipped) is a new history entry
			} else { progressStatus = 'error'; progressError = data.error || 'Failed to start backup'; }
		} catch { progressStatus = 'error'; progressError = 'Failed to start backup'; } finally { runningBackup = null; }
	}

	function cfgRetentionSummary(cfg: BackupConfig): string {
		return getRetentionSummary(cfg.retention);
	}

	function volumeSummary(cfg: BackupConfig): string {
		if (cfg.selectedVolumes === null) return `All volumes (${volumes.length})`;
		const sel = typeof cfg.selectedVolumes === 'string' ? JSON.parse(cfg.selectedVolumes) : cfg.selectedVolumes;
		return `${sel.length} of ${volumes.length} volumes`;
	}

	// Resolved host stack-dir path (stacks only): WHERE the helper will read the stack folder
	// from on the target host. Shown in the create form so the user sees what gets captured -
	// and a clear warning up front when it can't be located (would hard-fail the backup).
	let stackPath = $state<{ kind: 'candidate'; hostPath: string; composeFile: string } | { kind: 'unknown'; reason: string } | null>(null);
	async function fetchStackPath() {
		if (type !== 'stack') return;
		try {
			const params = new URLSearchParams({ target: containerName });
			// Use the derived envId (prop OR the currently selected environment), the SAME
			// value the rest of the panel uses for save/run - the bare `environmentId` prop is
			// often undefined (the modal doesn't pass it), which made the server report
			// "No environment specified".
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/backup/stack-path?${params}`);
			if (res.ok) stackPath = await res.json();
		} catch { /* non-fatal: the path preview is informational */ }
	}

	// Stack files on the host (probe listing) — supersedes the plain stackPath callout for the
	// picker, but stackPath is still fetched for the compose-file name shown elsewhere.
	type StackListing =
		| { kind: 'listed'; hostPath: string; entries: { name: string; type: 'dir' | 'file'; size: number; capturedAs?: 'bind' | 'volume' }[] }
		| { kind: 'unknown'; reason: string }
		| null;
	let stackListing = $state<StackListing>(null);
	let loadingStackListing = $state(false);
	let excludedStackFiles = $state<string[]>([]);
	async function fetchStackListing() {
		if (type !== 'stack') { stackListing = null; return; }
		loadingStackListing = true;
		try {
			const params = new URLSearchParams({ target: containerName });
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/backup/stack-dir-listing?${params}`);
			stackListing = await res.json();
		} catch (e) {
			stackListing = { kind: 'unknown', reason: e instanceof Error ? e.message : 'probe failed' };
		} finally {
			loadingStackListing = false;
		}
	}

	onMount(() => { fetchDestinations(); fetchConfigs(); });
	// Resolve the stack path once envId is known (it's derived from $currentEnvironment, which
	// may not be ready at mount). Re-runs if the environment changes.
	$effect(() => { if (type === 'stack' && envId != null) { void fetchStackPath(); void fetchStackListing(); } });
</script>

<!-- Sub-tabs: Schedules (cheap) vs Snapshots. SnapshotsPanel is mounted as soon as
     the Backups view opens (its per-repo listing loads IN THE BACKGROUND with a
     spinner on the tab) and kept mounted when switching tabs, so re-opening the
     Snapshots tab is instant (cached, no re-fetch — use the tab's refresh to reload). -->
<div class="mb-3 flex items-center gap-1 border-b">
	<button
		type="button"
		class="relative -mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors {subTab === 'schedules' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
		onclick={() => (subTab = 'schedules')}
	>
		Schedules{#if configs.length > 0}<span class="ml-1.5 rounded-full bg-primary/15 px-1.5 text-xs text-primary">{configs.length}</span>{/if}
	</button>
	<button
		type="button"
		class="relative -mb-px flex items-center border-b-2 px-3 py-1.5 text-sm font-medium transition-colors {subTab === 'snapshots' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
		onclick={() => (subTab = 'snapshots')}
	>
		Snapshots{#if snapshotsLoading}<Loader2 class="ml-1.5 h-3.5 w-3.5 animate-spin text-primary" />{:else if snapshotCount !== null}<span class="ml-1.5 rounded-full bg-primary/15 px-1.5 text-xs text-primary">{snapshotCount}</span>{/if}
	</button>
	<button
		type="button"
		class="relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm font-medium transition-colors {subTab === 'history' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
		onclick={() => (subTab = 'history')}
	>
		History
		{#if historyLoading}<Loader2 class="h-3.5 w-3.5 animate-spin text-primary" />{:else if tally.ok > 0 || tally.failed > 0}
			{#if tally.ok > 0}<span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 text-xs font-medium text-emerald-500"><Check class="h-3 w-3" />{tally.ok}</span>{/if}
			{#if tally.failed > 0}<span class="inline-flex items-center gap-0.5 rounded-full bg-red-500/15 px-1.5 text-xs font-semibold text-red-500"><X class="h-3 w-3" />{tally.failed}</span>{/if}
		{/if}
	</button>
</div>

<!-- Snapshots: always mounted (loads in background on open, cached across tab
     switches), shown only when its tab is active. -->
<div class:hidden={subTab !== 'snapshots'}>
	<SnapshotsPanel
		bind:this={snapshotsPanel}
		targetName={containerName} {type} {environmentId}
		hasBackups={configs.length > 0}
		configIds={configs.map((c) => c.id)}
		onCount={(n) => (snapshotCount = n)}
		onLoadingChange={(l) => (snapshotsLoading = l)}
	/>
</div>

{#if subTab === 'snapshots'}
	<!-- content rendered above (kept mounted) -->
{:else if subTab === 'history'}
	<ExecutionHistoryList {executions} loading={historyLoading} onViewLog={viewExecutionLog} />
{:else if loading}
	<div class="flex items-center justify-center py-8">
		<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
	</div>
{:else}
	<div class="space-y-3">
		<!-- Existing schedules list -->
		{#each configs as cfg}
			{@const dest = destinations.find(d => d.id === cfg.destinationId)}
			{@const Icon = dest ? getTypeIcon(dest.repository) : HardDrive}
			<div class="border rounded-md px-3 py-1.5 flex items-center gap-3 {!cfg.enabled ? 'opacity-60' : ''}">
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<Icon class="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
						<span class="text-sm font-medium truncate">{dest?.name || 'Unknown'}</span>
						{#if !cfg.enabled}<Badge variant="secondary" class="text-xs">Paused</Badge>{/if}
					</div>
					<div class="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
						<span>{cfg.schedule ? formatCron(cfg.schedule) : 'Manual'} · {volumeSummary(cfg)}{cfgRetentionSummary(cfg) ? ` · ${cfgRetentionSummary(cfg)}` : ''}</span>
						{#if cfg.lastBackupAt}
							<span>·</span>
							{#if cfg.lastBackupStatus === 'success'}<CheckCircle class="w-2.5 h-2.5 text-green-500" />{:else if cfg.lastBackupStatus === 'failed' || cfg.lastBackupStatus === 'error'}<XCircle class="w-2.5 h-2.5 text-destructive" />{/if}
							<span>{formatDateTime(cfg.lastBackupAt)}</span>
						{/if}
					</div>
				</div>
				<div class="flex items-center gap-0.5 flex-shrink-0">
					{#if cfg.schedule}
						<button type="button" class="p-1 rounded hover:bg-muted" onclick={() => togglePause(cfg)} disabled={togglingId === cfg.id} title={cfg.enabled ? 'Pause schedule' : 'Resume schedule'}>
							{#if togglingId === cfg.id}<Loader2 class="w-3 h-3 animate-spin text-muted-foreground" />{:else if cfg.enabled}<Pause class="w-3 h-3 text-muted-foreground" />{:else}<RotateCwFadingClock class="w-3 h-3 text-muted-foreground" />{/if}
						</button>
					{/if}
					<button type="button" class="p-1 rounded hover:bg-muted" onclick={() => runBackupNow(cfg)} disabled={runningBackup === cfg.id} title="Run now">
						{#if runningBackup === cfg.id}<Loader2 class="w-3 h-3 animate-spin text-muted-foreground" />{:else}<Play class="w-3 h-3 text-muted-foreground" />{/if}
					</button>
					<button type="button" class="p-1 rounded hover:bg-muted" onclick={() => startEditConfig(cfg)} title="Edit">
						<Pencil class="w-3 h-3 text-muted-foreground" />
					</button>
					<ConfirmPopover
						open={confirmDeleteId === cfg.id}
						action="Delete"
						itemType="backup schedule"
						itemName={dest?.name || ''}
						title="Remove schedule"
						position="left"
						onConfirm={() => deleteConfig(cfg.id)}
						onOpenChange={(open) => confirmDeleteId = open ? cfg.id : null}
					>
						{#snippet children({ open })}
							<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
						{/snippet}
					</ConfirmPopover>
				</div>
			</div>
		{/each}

		{#if configs.length === 0 && !isNew && !editingConfig}
			<p class="text-xs text-muted-foreground py-4 text-center">No backup schedules configured for this {type}.</p>
		{/if}

		<!-- Edit/New form -->
		{#if isNew || editingConfig}
			<div class="border border-primary/30 rounded-md p-4 space-y-4 bg-muted/10">
				<div class="flex items-center justify-between">
					<span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{isNew ? 'New backup schedule' : 'Edit schedule'}</span>
					<button type="button" class="p-1 rounded hover:bg-muted" onclick={cancelEdit}>
						<X class="w-3.5 h-3.5 text-muted-foreground" />
					</button>
				</div>

				<!-- Repository + Schedule -->
				<div class="flex items-center gap-2">
					<DestinationPicker
						destinations={destinations}
						bind:value={editDestinationId}
						env={fullEnv}
						triggerClass="h-9 w-[220px] flex-shrink-0"
					/>
					<CronEditor bind:value={editSchedule} bind:invalid={editScheduleInvalid} />
				</div>

				<!-- Toggles -->
				<div class="flex items-center gap-3 max-w-md">
					<TogglePill bind:checked={editEnabled} />
					<Label class="text-xs">Enabled</Label>
				</div>
				<div class="flex items-center gap-3 max-w-md">
					<TogglePill bind:checked={editStopBefore} />
					<Label class="text-xs">Stop {type} during backup</Label>
				</div>
				<!-- Stack files on the host: probe the host, show the resolved dir + let the user
				     pick which entries to back up. Shown BEFORE the volume list. -->
				{#if type === 'stack'}
					<StackFilesPicker
						listing={stackListing}
						loading={loadingStackListing}
						connectionType={fullEnv?.connectionType}
						envName={fullEnv?.name}
						envIcon={fullEnv?.icon}
						envId={fullEnv?.id}
						bind:excludedStackFiles
					/>
				{/if}

				<!-- Volume picker (all-or-subset toggle + per-volume checkboxes) -->
				<VolumePicker
					volumes={volumes}
					bind:allVolumes={editAllVolumes}
					bind:selectedVolumes={editSelectedVolumes}
					emptyLabel="No volumes detected on this {type}"
				/>

				<!-- Advanced -->
				<button type="button" class="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground w-full" onclick={() => showAdvanced = !showAdvanced}>
					<ChevronDown class="w-3.5 h-3.5 transition-transform {showAdvanced ? 'rotate-0' : '-rotate-90'}" />
					Advanced
				</button>
				{#if showAdvanced}
					<div class="space-y-3 pl-1">
						<!-- Retention policy -->
						<div class="space-y-1.5">
							<Label class="text-xs font-medium">Retention policy</Label>
							<p class="text-xs text-muted-foreground">Older snapshots are pruned after each backup. Set 0 to disable.</p>
							<div class="grid grid-cols-5 gap-2">
								<div class="space-y-0.5">
									<label class="text-xs text-muted-foreground">Last</label>
									<Input bind:value={editKeepLast} type="number" min="0" max="999" class="h-7 text-xs" />
								</div>
								<div class="space-y-0.5">
									<label class="text-xs text-muted-foreground">Daily</label>
									<Input bind:value={editKeepDaily} type="number" min="0" max="365" class="h-7 text-xs" />
								</div>
								<div class="space-y-0.5">
									<label class="text-xs text-muted-foreground">Weekly</label>
									<Input bind:value={editKeepWeekly} type="number" min="0" max="52" class="h-7 text-xs" />
								</div>
								<div class="space-y-0.5">
									<label class="text-xs text-muted-foreground">Monthly</label>
									<Input bind:value={editKeepMonthly} type="number" min="0" max="120" class="h-7 text-xs" />
								</div>
								<div class="space-y-0.5">
									<label class="text-xs text-muted-foreground">Yearly</label>
									<Input bind:value={editKeepYearly} type="number" min="0" max="100" class="h-7 text-xs" />
								</div>
							</div>
						</div>
						<!-- Exclude patterns -->
						<div class="space-y-1">
							<Label class="text-xs font-medium">Exclude patterns</Label>
							<Input bind:value={editExclude} class="h-7 text-xs font-mono" placeholder="*.log, *.tmp, cache/" />
							<p class="text-xs text-muted-foreground">Comma-separated glob patterns to exclude from backup.</p>
						</div>
						<!-- Exclude cache directories -->
						<div class="space-y-1">
							<div class="flex items-center gap-3">
								<TogglePill bind:checked={editExcludeCaches} onLabel="Yes" offLabel="No" />
								<Label class="text-xs font-medium">Skip cache directories</Label>
							</div>
							<p class="text-xs text-muted-foreground leading-snug">
								Skips folders containing a <code class="font-mono text-xs">CACHEDIR.TAG</code> marker file
								— used by npm, pip, Cargo, browsers, and many other tools to tag
								regenerable cache content. Saves significant backup space; the contents
								can always be rebuilt from source. Turn off only if you have a specific
								reason to back up cache data.
							</p>
						</div>
						<!-- Compression & bandwidth -->
						<div class="grid grid-cols-3 gap-2">
							<div class="space-y-1">
								<Label class="text-xs font-medium">Compression</Label>
								<Select.Root type="single" value={editCompression} onValueChange={(v) => { editCompression = v; }}>
									<Select.Trigger class="h-9 w-full text-xs">{editCompression}</Select.Trigger>
									<Select.Content>
										<Select.Item value="auto">Auto</Select.Item>
										<Select.Item value="off">Off</Select.Item>
										<Select.Item value="max">Max</Select.Item>
									</Select.Content>
								</Select.Root>
							</div>
							<div class="space-y-1">
								<Label class="text-xs font-medium">Upload limit</Label>
								<Input bind:value={editLimitUpload} type="number" min="0" class="h-9 text-xs font-mono" placeholder="KiB/s" />
							</div>
							<div class="space-y-1">
								<Label class="text-xs font-medium">Download limit</Label>
								<Input bind:value={editLimitDownload} type="number" min="0" class="h-9 text-xs font-mono" placeholder="KiB/s" />
							</div>
						</div>
						<!-- Webhook hooks -->
						<div class="space-y-1.5">
							<Label class="text-xs font-medium">Webhook hooks</Label>
							<div class="space-y-1">
								<label class="text-xs text-muted-foreground">On success</label>
								<Input bind:value={editWebhookSuccess} class="h-7 text-xs font-mono" placeholder="https://healthchecks.io/ping/..." />
							</div>
							<div class="space-y-1">
								<label class="text-xs text-muted-foreground">On failure</label>
								<Input bind:value={editWebhookFailure} class="h-7 text-xs font-mono" placeholder="https://hooks.slack.com/..." />
							</div>
							<p class="text-xs text-muted-foreground">POST with a JSON payload sent after backup completes (falls back to GET for simple receivers). Use for healthchecks, Slack, etc.</p>
						</div>
					</div>
				{/if}

				<!-- Submit actions. Editing existing config: just "Save".
				     Creating a new config: three actions, all use the same form
				     state (destination, schedule, volumes, retention, options) —
				     they only differ in what happens after persistence. -->
				<div class="flex justify-end gap-2 pt-2 border-t">
					<Button size="sm" variant="outline" onclick={cancelEdit}>Cancel</Button>
					{#if editingConfig}
						<Button size="sm" onclick={() => submitForm('save')} disabled={saving || editScheduleInvalid}>
							{#if saving}<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />{:else}<Save class="w-3.5 h-3.5 mr-1" />{/if}
							Save
						</Button>
					{:else}
						<Button size="sm" variant="outline" onclick={() => submitForm('run-once')} disabled={saving || !editDestinationId} title="Run a backup now, don't save a schedule">
							{#if saving && submitAction === 'run-once'}<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />{:else}<Play class="w-3.5 h-3.5 mr-1" />{/if}
							Run once
						</Button>
						<Button size="sm" variant="outline" onclick={() => submitForm('save')} disabled={saving || editScheduleInvalid || !editDestinationId}>
							{#if saving && submitAction === 'save'}<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />{:else}<Save class="w-3.5 h-3.5 mr-1" />{/if}
							Save schedule
						</Button>
						<Button size="sm" onclick={() => submitForm('save-run')} disabled={saving || editScheduleInvalid || !editDestinationId} title="Save the schedule and run a backup immediately">
							{#if saving && submitAction === 'save-run'}<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />{:else}<Play class="w-3.5 h-3.5 mr-1" />{/if}
							Save & run now
						</Button>
					{/if}
				</div>
			</div>
		{/if}

		<!-- "Add schedule" trigger when there's already at least one config -->
		{#if configs.length > 0 && !isNew && !editingConfig}
			<Button size="sm" variant="ghost" class="w-full text-muted-foreground" onclick={startNewConfig}>
				<Plus class="w-3.5 h-3.5 mr-1" />
				Add another schedule
			</Button>
		{/if}

		<!-- Empty-state trigger when there are no configs yet -->
		{#if configs.length === 0 && !isNew && !editingConfig}
			<Button size="sm" variant="outline" class="w-full" onclick={startNewConfig}>
				<Plus class="w-3.5 h-3.5 mr-1" />
				Configure a backup
			</Button>
		{/if}
	</div>
{/if}

<!-- Manual-backup progress: restic output streamed live. Not dismissible mid-run;
     the user closes it once the backup finishes (or fails). -->
<Dialog.Root bind:open={progressOpen}>
	<Dialog.Content class="max-w-5xl flex flex-col overflow-hidden top-[6vh] translate-y-0 h-[85vh]" interactOutsideBehavior={progressStatus === 'running' ? 'ignore' : 'close'} escapeKeydownBehavior={progressStatus === 'running' ? 'ignore' : 'close'}>
		<Dialog.Header>
			<Dialog.Title class="flex flex-wrap items-center gap-x-2 gap-y-1 text-base">
				<TypeIcon class="h-4 w-4 text-muted-foreground" />
				<span>{containerName}</span>
				{#if progressEnv}
					<span class="text-sm font-normal text-muted-foreground">on</span>
					<span class="flex items-center gap-1 text-sm font-medium text-amber-500"><EnvironmentIcon icon={progressEnv.icon || 'globe'} envId={progressEnv.id} class="h-3.5 w-3.5" />{progressEnv.name}</span>
				{/if}
				{#if progressDest}
					<span class="text-sm font-normal text-muted-foreground">→</span>
					{@const RepoIcon = getRepoTypeIcon(progressDest.repository)}
					<span class="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-xs font-normal"><RepoIcon class="h-3.5 w-3.5 text-primary/70" />{progressDest.name}</span>
				{/if}
			</Dialog.Title>
			<Dialog.Description class="sr-only">Live backup progress for {containerName}.</Dialog.Description>
		</Dialog.Header>
		<!-- flex-1 + fixed dialog height: the log fills the space and SCROLLS internally,
		     so the dialog never grows/jumps as lines stream in. -->
		<LogConsole lines={progressLogs} class="flex-1 min-h-0" />
		<div class="flex shrink-0 items-center gap-1.5 text-sm">
			{#if progressStatus === 'running'}
				<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" /><span class="text-muted-foreground">Backing up…</span>
			{:else if progressStatus === 'success'}
				<CheckCircle class="h-4 w-4 text-green-500" /><span class="text-green-500">Backup completed</span>
			{:else}
				<XCircle class="h-4 w-4 text-destructive" /><span class="text-destructive">{progressError || 'Backup failed'}</span>
			{/if}
		</div>
		<Dialog.Footer>
			{#if progressStatus === 'running'}
				<Button size="sm" variant="destructive" disabled={cancelling || progressConfigId == null} onclick={cancelRunningBackup}>
					{#if cancelling}<Loader2 class="mr-1 h-3.5 w-3.5 animate-spin" />Cancelling…{:else}<X class="mr-1 h-3.5 w-3.5" />Cancel backup{/if}
				</Button>
			{:else}
				<Button size="sm" onclick={() => (progressOpen = false)}>OK</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Backup-run log viewer, opened from the History table's log button -->
<Dialog.Root bind:open={logDialogOpen}>
	<Dialog.Content class="max-w-4xl h-[80vh] overflow-hidden flex flex-col">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2 text-base"><FileText class="h-4 w-4" />Backup log</Dialog.Title>
		</Dialog.Header>
		<div class="flex-1 flex flex-col min-h-0">
			{#if logDialogLoading}
				<div class="flex items-center justify-center py-8 gap-2 text-muted-foreground">
					<Loader2 class="h-4 w-4 animate-spin" />
					<span class="text-sm">Loading log…</span>
				</div>
			{:else if logDialogContent}
				<ExecutionLogViewer logs={logDialogContent} />
			{:else}
				<p class="py-8 text-center text-sm text-muted-foreground">No log output was recorded for this run.</p>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
