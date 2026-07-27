<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Loader2, FolderOpen, RotateCcw, Trash2, ArrowLeftRight, HardDrive, Archive, RefreshCw } from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { formatDateTime } from '$lib/stores/settings';
	import { formatBytes } from '$lib/utils/format';
	import { getRepoTypeIcon } from '$lib/utils/backup';
	import SnapshotBrowser from './SnapshotBrowser.svelte';
	import RestoreModal from './RestoreModal.svelte';
	import SnapshotDiffModal from '../backups/SnapshotDiffModal.svelte';

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
	let snapshots = $state<Snapshot[]>([]);
	let deletingSnapshot = $state<string | null>(null);
	let confirmDeleteSnapshot = $state<string | null>(null);
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
			const nameTag = `dockhand:name=${targetName}`;
			const all: Snapshot[] = [];
			// Query every destination and keep only THIS target's snapshots (by tag).
			await Promise.all(destinations.map(async (dest) => {
				try {
					const res = await fetch(`/api/backup/snapshots?destinationId=${dest.id}`);
					if (!res.ok) return;
					const data = await res.json();
					const snaps: any[] = data.snapshots ?? data;
					for (const s of snaps) {
						if ((s.tags || []).some((t: string) => t === nameTag)) {
							all.push({ ...s, _destinationId: dest.id, _destinationName: dest.name, _destinationRepository: dest.repository });
						}
					}
				} catch { /* skip an unreachable destination */ }
			}));
			all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
			snapshots = all;
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
			toast.error('Failed to load snapshots');
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
		showRestore = true;
	}
	function toggleDiff(s: Snapshot) {
		if (diffPending?.id === s.id) { diffPending = null; return; }
		if (diffPending) {
			// Second selection → compare (older first). Both must share a destination.
			if (diffPending._destinationId !== s._destinationId) {
				toast.error('Compare needs two snapshots from the same repository');
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
				toast.success('Snapshot deleted');
				await loadSnapshots();
			} else {
				const data = await res.json();
				toast.error(data.error || 'Failed to delete snapshot');
			}
		} catch {
			toast.error('Failed to delete snapshot');
		} finally {
			deletingSnapshot = null;
			confirmDeleteSnapshot = null;
		}
	}

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
		<button type="button" class="flex items-center gap-1.5 rounded p-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50" onclick={() => refresh()} disabled={loading} title="Refresh snapshots">
			<RefreshCw class="h-3.5 w-3.5" />
		</button>
	</div>
{/if}

{#if loading && snapshots.length === 0}
	<!-- First load only: a quiet spinner, no skeleton. On a refresh where rows already
	     exist we fall through and keep the real table visible (the header refresh icon
	     already signals progress). Matches the History tab's empty/loading treatment. -->
	<div class="flex flex-col items-center justify-center py-10 text-center">
		<Loader2 class="mb-3 h-8 w-8 animate-spin text-muted-foreground/40" />
		<p class="text-sm text-muted-foreground">Loading snapshots…</p>
	</div>
{:else if snapshots.length === 0}
	<div class="flex flex-col items-center justify-center py-10 text-center">
		<Archive class="mb-3 h-10 w-10 text-muted-foreground/40" />
		<p class="text-sm text-muted-foreground">No snapshots yet for {targetName}.</p>
		<p class="mt-1 text-xs text-muted-foreground">Run a backup from the Schedules tab to create one.</p>
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
				All repositories <span class="text-[10px] opacity-70">{snapshots.length}</span>
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
	<div class="overflow-x-auto">
		<table class="w-full text-xs">
			<thead>
				<tr class="border-b text-left text-muted-foreground">
					<th class="py-1.5 pl-2 font-medium">Snapshot</th>
					<th class="py-1.5 pl-2 font-medium">Taken</th>
					<th class="py-1.5 pl-2 font-medium">Added</th>
					<th class="py-1.5 pl-2 font-medium">Repository</th>
					<th class="py-1.5 pr-3 text-right font-medium">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each visibleSnapshots as s}
					{@const isDiffPending = diffPending?.id === s.id}
					{@const RepoIcon = getRepoTypeIcon(s._destinationRepository)}
					{@const st = stats.get(s.id)}
					<tr class="border-b text-xs last:border-0 hover:bg-muted/30 {isDiffPending ? 'bg-primary/10' : ''}">
						<td class="py-1.5 pl-2 font-mono text-muted-foreground">{s.shortId}</td>
						<td class="py-1.5 pl-2">{formatDateTime(s.time)}</td>
						<td class="py-1.5 pl-2 text-muted-foreground" title={st ? `${st.filesNew} new, ${st.filesChanged} changed files` : ''}>{st ? formatBytes(st.dataAdded) : '—'}</td>
						<td class="py-1.5 pl-2 text-muted-foreground">
							<span class="flex items-center gap-1.5"><RepoIcon class="h-3.5 w-3.5 text-primary/70" />{s._destinationName}</span>
						</td>
						<td class="px-3 py-1.5 text-right">
							<div class="flex items-center justify-end gap-0.5">
								{#if visibleSnapshots.length >= 2}
									<button type="button" class="rounded p-1 transition-colors {isDiffPending ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}" onclick={() => toggleDiff(s)} title={isDiffPending ? 'Cancel compare' : diffPending ? 'Compare with selected' : 'Compare'}>
										<ArrowLeftRight class="h-3 w-3 {isDiffPending ? 'text-primary' : 'text-muted-foreground'}" />
									</button>
								{/if}
								<button type="button" class="rounded p-1 transition-colors hover:bg-muted" onclick={() => openBrowser(s)} title="Browse files">
									<FolderOpen class="h-3 w-3 text-muted-foreground" />
								</button>
								<button type="button" class="rounded p-1 transition-colors hover:bg-muted" onclick={() => openRestore(s)} title="Restore">
									<RotateCcw class="h-3 w-3 text-muted-foreground" />
								</button>
								<ConfirmPopover
									open={confirmDeleteSnapshot === s.id}
									action="Delete"
									itemType="snapshot"
									itemName={s.shortId}
									title="Delete snapshot"
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
	{environmentId}
	onDone={loadSnapshots}
/>

<SnapshotDiffModal
	bind:open={showDiff}
	destinationId={diffDestId}
	snapshotA={diffSnapA}
	snapshotB={diffSnapB}
/>
