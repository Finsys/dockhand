<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Loader2, FolderOpen, RotateCcw, Trash2, ArrowLeftRight, HardDrive, Archive, RefreshCw } from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { LoadingState } from '$lib/components/ui/loading-state';
	import { formatDateTime, formatRelativeTime } from '$lib/stores/settings';
	import { formatBytes } from '$lib/utils/format';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import { getRepoTypeIcon, selectOwnSnapshotsFromDestination, bulkDeleteSnapshots, bulkDeleteToast, bulkDeleteFailure } from '$lib/utils/backup';
	import BulkDeleteSnapshotsDialog from '$lib/components/BulkDeleteSnapshotsDialog.svelte';
	import BulkDeleteErrorDialog from '$lib/components/BulkDeleteErrorDialog.svelte';
	import SnapshotBrowser from './SnapshotBrowser.svelte';
	import RestoreModal from './RestoreModal.svelte';
	import SnapshotDiffModal from '../backups/SnapshotDiffModal.svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		/** The backup target name (container or stack) whose snapshots to list. */
		targetName: string;
		type?: 'container' | 'stack';
		environmentId?: number;
		/** Whether this target has any backup config. With none there can be no
		 * snapshots, so we skip the (slow) per-repo listing entirely. */
		hasBackups?: boolean;
		/** This target's backup config (schedule) ids — used to pull per-snapshot
		 * stats (files new/changed, data added) from schedule executions, which are
		 * already recorded at backup time (no extra restic call). */
		configIds?: number[];
		/** Reports the loaded snapshot count so the parent can badge the tab. */
		onCount?: (n: number) => void;
		/** Reports loading state so the parent can show a spinner on the tab. */
		onLoadingChange?: (loading: boolean) => void;
	}
	let { targetName, type = 'container', environmentId, hasBackups = true, configIds = [], onCount, onLoadingChange }: Props = $props();

	interface Snapshot {
		id: string;
		shortId: string;
		time: string;
		tags?: string[];
		_destinationId: number;
		_destinationName: string;
		_destinationRepository: string;
	}

	let loading = $state(true);
	// Progress of the per-destination snapshot sweep (X of N repos) - a slow/unreachable
	// repo can take up to the backend restic timeout (5 min), so show it advancing.
	let loadDone = $state(0);
	let loadTotal = $state(0);
	let snapshots = $state<Snapshot[]>([]);
	let deletingSnapshot = $state<string | null>(null);
	let confirmDeleteSnapshot = $state<string | null>(null);
	// Multi-select for bulk delete (same Set model as the containers grid), keyed by
	// snapshot id. Bulk delete groups by destination and calls the batch endpoint.
	let selectedSnapshots = $state<Set<string>>(new Set());
	let bulkDeleting = $state(false);
	let bulkDialogOpen = $state(false);
	let bulkScope = $state<'selected' | 'all'>('selected');
	let bulkDeleteErrorOpen = $state(false);
	let bulkDeleteError = $state('');
	let bulkDeleteErrorDeleted = $state(0);
	// snapshotId → { filesNew, filesChanged, dataAdded } from schedule executions.
	let stats = $state<Map<string, { filesNew: number; filesChanged: number; dataAdded: number }>>(new Map());

	// Browse
	let showBrowser = $state(false);
	let browserDestId = $state(0);
	let browserSnapshotId = $state('');
	// Restore
	let showRestore = $state(false);
	let restoreDestId = $state(0);
	let restoreSnapshotId = $state('');
	let restoreDestName = $state('');
	let restoreDestRepo = $state('');
	// Diff (click one to select, another to compare)
	let showDiff = $state(false);
	let diffDestId = $state(0);
	let diffSnapA = $state<any>({ id: '', shortId: '', time: '' });
	let diffSnapB = $state<any>({ id: '', shortId: '', time: '' });
	let diffPending = $state<Snapshot | null>(null);

	// Repo filter (Option C). A target can be backed up to more than one repository,
	// so its snapshots interleave here. `repoFilter` = the selected destination id, or
	// null for "all". The chip row only appears when there is more than one repo.
	let repoFilter = $state<number | null>(null);
	// Distinct repos present in the loaded snapshots, with a count each.
	const repoGroups = $derived.by(() => {
		const m = new Map<number, { id: number; name: string; repository: string; count: number }>();
		for (const s of snapshots) {
			const g = m.get(s._destinationId);
			if (g) g.count++;
			else m.set(s._destinationId, { id: s._destinationId, name: s._destinationName, repository: s._destinationRepository, count: 1 });
		}
		return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
	});
	const visibleSnapshots = $derived(
		repoFilter == null ? snapshots : snapshots.filter((s) => s._destinationId === repoFilter)
	);
	// Selection is scoped to what's currently visible (respects the repo filter), like the
	// containers grid's select-all only covering the filtered rows.
	const allVisibleSelected = $derived(
		visibleSnapshots.length > 0 && visibleSnapshots.every((s) => selectedSnapshots.has(s.id))
	);
	const someVisibleSelected = $derived(
		visibleSnapshots.some((s) => selectedSnapshots.has(s.id)) && !allVisibleSelected
	);
	const selectedCount = $derived(visibleSnapshots.filter((s) => selectedSnapshots.has(s.id)).length);

	// A dropped repo filter (e.g. after a delete removed the last snapshot of a repo)
	// falls back to "all" so the list never shows an empty filtered view.
	$effect(() => {
		if (repoFilter != null && !repoGroups.some((g) => g.id === repoFilter)) repoFilter = null;
	});

	export async function refresh() { await loadSnapshots(); }

	async function loadSnapshots() {
		// No backup config → no snapshots possible → skip the slow per-repo listing.
		if (!hasBackups) { snapshots = []; onCount?.(0); loading = false; onLoadingChange?.(false); return; }
		loading = true;
		onLoadingChange?.(true);
		try {
			const destRes = await fetch('/api/backup/destinations');
			const destinations: { id: number; name: string; repository: string }[] = destRes.ok ? await destRes.json() : [];
			// Scope to THIS env's configs, not just the name: same-name stacks on different
			// environments write to a shared repo and all carry dockhand:name=<stack>, so a
			// name-only filter mixed their snapshots (and "latest") across envs (#1546).
			// configIds is env-scoped (BackupPanel fetches configs with ?env=), so a snapshot's
			// own dockhand:configid tag uniquely identifies (stack, env). See snapshotMatchesConfigScope.
			const all: Snapshot[] = [];
			loadDone = 0;
			loadTotal = destinations.length;
			snapshots = [];
			// Query every destination and keep only THIS target's snapshots (by tag). Show each
			// repo's results the moment it returns instead of blocking on the slowest repo - with
			// many (or one unreachable) repos the list fills in live rather than after a long wait.
			await Promise.all(destinations.map(async (dest) => {
				try {
					// Job-polling so a slow `restic snapshots` behind a proxy isn't aborted at ~15s.
					const res = await fetch(`/api/backup/snapshots?destinationId=${dest.id}`, {
						headers: { Accept: 'text/event-stream' }
					});
					const data = await readJobResponse(res);
					if (data?.error) return;
					const snaps: any[] = data.snapshots ?? data;
					const mine = selectOwnSnapshotsFromDestination(snaps, dest, configIds, targetName);
					if (mine.length) {
						all.push(...mine);
						all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
						snapshots = [...all];
						onCount?.(all.length);
					}
				} catch { /* skip an unreachable destination */ } finally { loadDone += 1; }
			}));
			onCount?.(all.length);

			// Per-snapshot stats from schedule executions (recorded at backup time).
			const statMap = new Map<string, { filesNew: number; filesChanged: number; dataAdded: number }>();
			await Promise.all(configIds.map(async (id) => {
				try {
					const r = await fetch(`/api/schedules/executions?scheduleType=backup&scheduleId=${id}&limit=100`);
					if (!r.ok) return;
					const d = await r.json();
					for (const exec of d.executions || []) {
						if (exec.details?.snapshotId) {
							statMap.set(exec.details.snapshotId, {
								filesNew: exec.details.filesNew ?? 0,
								filesChanged: exec.details.filesChanged ?? 0,
								dataAdded: exec.details.dataAdded ?? 0,
							});
						}
					}
				} catch { /* stats are best-effort */ }
			}));
			stats = statMap;
		} catch {
			snapshots = [];
			toast.error(m.containers_snapshot_error_load());
		} finally {
			loading = false;
			onLoadingChange?.(false);
		}
	}

	function openBrowser(s: Snapshot) {
		browserDestId = s._destinationId;
		browserSnapshotId = s.id;
		showBrowser = true;
	}
	function openRestore(s: Snapshot) {
		restoreDestId = s._destinationId;
		restoreSnapshotId = s.id;
		restoreDestName = s._destinationName;
		restoreDestRepo = s._destinationRepository;
		showRestore = true;
	}
	function toggleDiff(s: Snapshot) {
		if (diffPending?.id === s.id) { diffPending = null; return; }
		if (diffPending) {
			// Second selection → compare (older first). Both must share a destination.
			if (diffPending._destinationId !== s._destinationId) {
				toast.error(m.containers_snapshot_compare_same_repo());
				diffPending = null;
				return;
			}
			const pair = [diffPending, s].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
			diffDestId = pair[0]._destinationId;
			// SnapshotDiffModal reads `short_id`; our snapshots carry `shortId` — alias it.
			diffSnapA = { ...pair[0], short_id: pair[0].shortId };
			diffSnapB = { ...pair[1], short_id: pair[1].shortId };
			showDiff = true;
			diffPending = null;
		} else {
			diffPending = s;
		}
	}
	async function deleteSnapshot(s: Snapshot) {
		deletingSnapshot = s.id;
		try {
			const res = await fetch(`/api/backup/snapshots/${s.id}?destinationId=${s._destinationId}`, { method: 'DELETE' });
			if (res.ok) {
				toast.success(m.containers_snapshot_deleted());
				await loadSnapshots();
			} else {
				const data = await res.json();
				toast.error(data.error || m.containers_snapshot_error_delete());
			}
		} catch {
			toast.error(m.containers_snapshot_error_delete());
		} finally {
			deletingSnapshot = null;
			confirmDeleteSnapshot = null;
		}
	}

	function toggleSnapshot(id: string) {
		const next = new Set(selectedSnapshots);
		if (next.has(id)) next.delete(id); else next.add(id);
		selectedSnapshots = next;
	}
	function toggleSelectAllVisible() {
		const next = new Set(selectedSnapshots);
		if (allVisibleSelected) for (const s of visibleSnapshots) next.delete(s.id);
		else for (const s of visibleSnapshots) next.add(s.id);
		selectedSnapshots = next;
	}

	// Bulk delete via the shared helper (groups by destination, one restic forget per repo).
	// `scope` = the currently-selected snapshots, or ALL visible ones.
	async function bulkDelete(scope: 'selected' | 'all') {
		const targets = scope === 'all' ? visibleSnapshots : visibleSnapshots.filter((s) => selectedSnapshots.has(s.id));
		if (targets.length === 0) return;
		bulkDeleting = true;
		try {
			const result = await bulkDeleteSnapshots(targets);
			const failure = bulkDeleteFailure(result);
			if (failure) {
				bulkDeleteError = failure.error;
				bulkDeleteErrorDeleted = failure.deleted;
				bulkDeleteErrorOpen = true;
			} else {
				const t = bulkDeleteToast(result);
				toast[t.type](t.message);
			}
			selectedSnapshots = new Set();
			await loadSnapshots();
		} finally {
			bulkDeleting = false;
			bulkDialogOpen = false;
		}
	}
	function openBulk(scope: 'selected' | 'all') { bulkScope = scope; bulkDialogOpen = true; }
	const bulkCount = $derived(bulkScope === 'all' ? visibleSnapshots.length : selectedCount);

	// `hasBackups` arrives from the parent AFTER this panel mounts (the parent
	// fetches its configs async), so it starts false and flips true once configs
	// load. A plain onMount would run with hasBackups=false and early-return,
	// leaving the list empty until a manual refresh. This effect loads as soon as
	// hasBackups is true, exactly once — so the list fills in the background without
	// a click, and switching sub-tabs stays cached. If there genuinely are no
	// configs (hasBackups never true), onMount shows the empty state below.
	let loadedWithBackups = $state(false);
	$effect(() => {
		if (hasBackups && !loadedWithBackups) {
			loadedWithBackups = true;
			void loadSnapshots();
		}
	});
	// Only needed for the genuine no-configs case (hasBackups never flips true) —
	// render the empty state instead of the initial loading spinner forever.
	onMount(() => { if (!hasBackups) void loadSnapshots(); });
</script>

<!-- Refresh header only when there are rows to refresh. On the empty/loading state
     it's hidden so this tab's empty state lines up vertically with the History tab's
     (which has no header row) instead of sitting one row lower. -->
{#if snapshots.length > 0}
	<div class="mb-2 flex items-center justify-end">
		<button type="button" class="flex items-center gap-1.5 rounded p-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50" onclick={() => refresh()} disabled={loading} title={m.containers_snapshot_refresh()}>
			<RefreshCw class="h-3.5 w-3.5" />
		</button>
	</div>
{/if}

{#if loading && snapshots.length === 0}
	<!-- First load only: a quiet spinner, no skeleton. On a refresh where rows already
	     exist we fall through and keep the real table visible (the header refresh icon
	     already signals progress). Matches the History tab's empty/loading treatment. -->
	<LoadingState class="min-h-[50vh]" label={loadTotal > 1 ? m.containers_snapshot_loading_progress({ done: loadDone, total: loadTotal }) : m.containers_snapshot_loading()} />
{:else if snapshots.length === 0}
	<div class="flex min-h-[60vh] flex-col items-center justify-center py-10 text-center">
		<Archive class="mb-3 h-10 w-10 text-muted-foreground/40" />
		<p class="text-sm text-muted-foreground">{m.containers_snapshot_empty({ name: targetName })}</p>
		<p class="mt-1 text-xs text-muted-foreground">{m.containers_snapshot_empty_hint()}</p>
	</div>
{:else}
	<!-- Repo filter chips (Option C) — only when the target spans more than one repo. -->
	{#if repoGroups.length > 1}
		<div class="mb-2 flex flex-wrap items-center gap-1.5">
			<button
				type="button"
				class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors {repoFilter == null ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}"
				onclick={() => (repoFilter = null)}
			>
				{m.containers_snapshot_all_repositories()} <span class="text-[10px] opacity-70">{snapshots.length}</span>
			</button>
			{#each repoGroups as g}
				{@const GIcon = getRepoTypeIcon(g.repository)}
				<button
					type="button"
					class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors {repoFilter === g.id ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}"
					onclick={() => (repoFilter = g.id)}
				>
					<GIcon class="h-3 w-3 {repoFilter === g.id ? 'text-primary' : 'text-primary/70'}" />{g.name} <span class="text-[10px] opacity-70">{g.count}</span>
				</button>
			{/each}
		</div>
	{/if}
	<!-- Bulk actions: delete the selected snapshots, or all in the current view. -->
	<div class="mb-2 flex items-center gap-2">
		{#if selectedCount > 0}
			<button type="button" class="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10" onclick={() => openBulk('selected')}>
				<Trash2 class="h-3 w-3" /> {m.containers_snapshot_delete_selected({ count: selectedCount })}
			</button>
			<button type="button" class="text-xs text-muted-foreground hover:text-foreground" onclick={() => (selectedSnapshots = new Set())}>{m.containers_snapshot_clear_selection()}</button>
		{/if}
		{#if visibleSnapshots.length > 0}
			<button type="button" class="ml-auto inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10" onclick={() => openBulk('all')}>
				<Trash2 class="h-3 w-3" /> {m.containers_snapshot_delete_all({ count: visibleSnapshots.length })}
			</button>
		{/if}
	</div>
	<div class="overflow-x-auto">
		<table class="w-full text-xs">
			<thead>
				<tr class="border-b text-left text-muted-foreground">
					<th class="w-8 py-1.5 pl-2">
						<Checkbox checked={allVisibleSelected} indeterminate={someVisibleSelected} onCheckedChange={toggleSelectAllVisible} aria-label={m.containers_snapshot_select_all()} />
					</th>
					<th class="py-1.5 pl-2 font-medium">{m.containers_snapshot_col_snapshot()}</th>
					<th class="py-1.5 pl-2 font-medium">{m.containers_snapshot_col_taken()}</th>
					<th class="py-1.5 pl-2 font-medium">{m.containers_snapshot_col_added()}</th>
					<th class="py-1.5 pl-2 font-medium">{m.containers_snapshot_col_repository()}</th>
					<th class="py-1.5 pr-3 text-right font-medium">{m.containers_snapshot_col_actions()}</th>
				</tr>
			</thead>
			<tbody>
				{#each visibleSnapshots as s}
					{@const isDiffPending = diffPending?.id === s.id}
					{@const RepoIcon = getRepoTypeIcon(s._destinationRepository)}
					{@const st = stats.get(s.id)}
					<tr class="border-b text-xs last:border-0 hover:bg-muted/30 {isDiffPending ? 'bg-primary/10' : ''} {selectedSnapshots.has(s.id) ? 'bg-primary/5' : ''}">
						<td class="py-1.5 pl-2">
							<Checkbox checked={selectedSnapshots.has(s.id)} onCheckedChange={() => toggleSnapshot(s.id)} aria-label={m.containers_snapshot_select({ id: s.shortId })} />
						</td>
						<td class="py-1.5 pl-2 font-mono text-muted-foreground">{s.shortId}</td>
						<td class="py-1.5 pl-2">{formatDateTime(s.time)} <span class="text-muted-foreground opacity-60">({formatRelativeTime(s.time)})</span></td>
						<td class="py-1.5 pl-2 text-muted-foreground" title={st ? m.containers_snapshot_stats_title({ filesNew: st.filesNew, filesChanged: st.filesChanged }) : ''}>{st ? formatBytes(st.dataAdded) : '—'}</td>
						<td class="py-1.5 pl-2 text-muted-foreground">
							<span class="flex items-center gap-1.5"><RepoIcon class="h-3.5 w-3.5 text-primary/70" />{s._destinationName}</span>
						</td>
						<td class="px-3 py-1.5 text-right">
							<div class="flex items-center justify-end gap-0.5">
								{#if visibleSnapshots.length >= 2}
									<button type="button" class="rounded p-1 transition-colors {isDiffPending ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}" onclick={() => toggleDiff(s)} title={isDiffPending ? m.containers_snapshot_compare_cancel() : diffPending ? m.containers_snapshot_compare_with_selected() : m.containers_snapshot_compare()}>
										<ArrowLeftRight class="h-3 w-3 {isDiffPending ? 'text-primary' : 'text-muted-foreground'}" />
									</button>
								{/if}
								<button type="button" class="rounded p-1 transition-colors hover:bg-muted" onclick={() => openBrowser(s)} title={m.containers_snapshot_browse_files()}>
									<FolderOpen class="h-3 w-3 text-muted-foreground" />
								</button>
								<button type="button" class="rounded p-1 transition-colors hover:bg-muted" onclick={() => openRestore(s)} title={m.containers_snapshot_restore()}>
									<RotateCcw class="h-3 w-3 text-muted-foreground" />
								</button>
								<ConfirmPopover
									open={confirmDeleteSnapshot === s.id}
									localized
									action={m.confirm_action_delete()}
									itemType={m.containers_item_snapshot()}
									itemName={s.shortId}
									title={m.containers_snapshot_delete_title()}
									position="left"
									onConfirm={() => deleteSnapshot(s)}
									onOpenChange={(open) => confirmDeleteSnapshot = open ? s.id : null}
								>
									{#snippet children({ open })}
										{#if deletingSnapshot === s.id}
											<Loader2 class="h-3 w-3 animate-spin" />
										{:else}
											<Trash2 class="h-3 w-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
										{/if}
									{/snippet}
								</ConfirmPopover>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<BulkDeleteSnapshotsDialog bind:open={bulkDialogOpen} count={bulkCount} busy={bulkDeleting} onConfirm={() => bulkDelete(bulkScope)} />
<BulkDeleteErrorDialog bind:open={bulkDeleteErrorOpen} error={bulkDeleteError} deleted={bulkDeleteErrorDeleted} />

<SnapshotBrowser
	bind:open={showBrowser}
	destinationId={browserDestId}
	snapshotId={browserSnapshotId}
	{targetName}
	targetType={type}
	{environmentId}
/>

<RestoreModal
	bind:open={showRestore}
	destinationId={restoreDestId}
	snapshotId={restoreSnapshotId}
	containerName={targetName}
	destinationName={restoreDestName}
	destinationRepository={restoreDestRepo}
	{environmentId}
	onDone={loadSnapshots}
/>

<SnapshotDiffModal
	bind:open={showDiff}
	destinationId={diffDestId}
	snapshotA={diffSnapA}
	snapshotB={diffSnapB}
/>
