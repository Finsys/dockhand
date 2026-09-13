<script lang="ts">
	/**
	 * Deploys tab: the recorded history of deploy runs for this stack (GET
	 * /api/stacks/{name}/deploys), rendered as a dense DataGrid. Each run is one
	 * grid row -- status, when, duration, trigger, and a merged summary column
	 * (container/build recap + option pills + a shortened error). Expanding a row
	 * reveals the LOG beneath it plus the run's details (containers, build/cache,
	 * images, options, a truncated notice, the last error line). All text
	 * composition lives in deploy-run-view.ts -- this component only fetches, binds,
	 * and lays the grid out.
	 *
	 * The log is fetched (GET .../deploys/{id}/log) only when a row expands, never
	 * while the list loads: a run's log can be large, and the list is meant to stay
	 * quick. buildDeployLogPanelState decides what that fetch should attempt -- a run
	 * already known to be missing its log file never triggers the request.
	 *
	 * `envId === null` is the LOCAL environment, not "nothing to ask for" (see the
	 * list route's doc comment): appendEnvParam() omits `env` when envId is falsy,
	 * and every LOCAL run is recorded with environmentId === null, so the grid loads
	 * unconditionally.
	 */
	import { toast } from 'svelte-sonner';
	import {
		Loader2,
		Check,
		X,
		Clock,
		Hand,
		Timer,
		Webhook,
		Power,
		AlertTriangle,
		Trash2
	} from 'lucide-svelte';
	import { formatRelativeTime, formatDateTime } from '$lib/stores/settings';
	import { appendEnvParam } from '$lib/stores/environment';
	import { buildDeployRunView, buildDeployLogPanelState, deployTallyFromRuns, type DeployRun } from '$lib/utils/deploy-run-view';
	import { DataGrid } from '$lib/components/data-grid';
	import { Badge } from '$lib/components/ui/badge';
	import { onDestroy } from 'svelte';
	import { GripHorizontal } from 'lucide-svelte';
	import ContainerIcon from '$lib/components/ContainerIcon.svelte';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';

	interface Props {
		stackName: string;
		envId: number | null;
		// Forwarded to LogViewer so an expanded run's log follows the caller's editor
		// theme toggle instead of LogViewer's own 'dark' default.
		theme?: 'light' | 'dark';
		// Bumped by the parent after a deploy finishes so the history re-fetches.
		reloadKey?: number;
		// Reports the run tally to the parent for the tab badge (total + ok/failed split).
		onTally?: (t: { total: number; ok: number; failed: number }) => void;
	}
	let { stackName, envId, theme = 'dark', reloadKey = 0, onTally }: Props = $props();

	let runs = $state<DeployRun[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let expandedKeys = $state<Set<unknown>>(new Set());

	// Column sort. Default: newest first (the API's own order). startedAt/duration
	// compare numerically; status/triggeredBy compare as strings.
	let sortState = $state<{ field: string; direction: 'asc' | 'desc' }>({
		field: 'startedAt',
		direction: 'desc'
	});
	const sortedRuns = $derived.by(() => {
		const dir = sortState.direction === 'desc' ? -1 : 1;
		const numeric = sortState.field === 'startedAt' || sortState.field === 'duration';
		return [...runs].sort((a, b) => {
			let cmp: number;
			if (numeric) {
				const va = sortState.field === 'startedAt' ? (a.startedAt ? Date.parse(a.startedAt) : 0) : (a.duration ?? 0);
				const vb = sortState.field === 'startedAt' ? (b.startedAt ? Date.parse(b.startedAt) : 0) : (b.duration ?? 0);
				cmp = va - vb;
			} else {
				cmp = String((a as any)[sortState.field] ?? '').localeCompare(String((b as any)[sortState.field] ?? ''));
			}
			return cmp * dir;
		});
	});

	/** One entry per run whose log has been requested. 'loading'/'loaded'/'missing'/'error'
	 *  -- deliberately not reused for "not yet requested" (absent from the map), so a
	 *  fresh row doesn't render as if a fetch had already failed. */
	interface LogFetch {
		status: 'loading' | 'loaded' | 'missing' | 'error';
		text?: string;
		error?: string;
	}
	let logs = $state<Map<number, LogFetch>>(new Map());
	let confirmDeleteId = $state<number | null>(null);
	let deletingIds = $state<Set<number>>(new Set());

	// Fired by the grid when a row's expand chevron is clicked. Loads the log on
	// open; nothing to do on collapse (the fetched text is kept for a re-open).
	function onExpandChange(key: unknown, expanded: boolean) {
		if (!expanded) return;
		const run = runs.find((r) => r.id === key);
		if (run) void loadLog(run);
	}

	// Whole-row click toggles expansion (the grid only wires the chevron itself),
	// loading the log on open -- same effect as the chevron path.
	function toggleRun(run: DeployRun) {
		const s = new Set(expandedKeys);
		if (s.has(run.id)) s.delete(run.id);
		else {
			s.add(run.id);
			void loadLog(run);
		}
		expandedKeys = s;
	}

	/**
	 * Fetches a run's protocol text the first time its row opens. A prior 'error'
	 * result is retried on the next open (transient network failures shouldn't
	 * require a page reload to recover from); 'loading'/'loaded'/'missing' are all
	 * left alone -- there is nothing a second fetch would tell us that the first
	 * one (or the run's own details.logMissing) didn't already establish.
	 */
	async function loadLog(run: DeployRun) {
		const existing = logs.get(run.id);
		if (existing && existing.status !== 'error') return;

		if (buildDeployLogPanelState(run).logMissing) {
			logs = new Map(logs).set(run.id, { status: 'missing' });
			return;
		}

		logs = new Map(logs).set(run.id, { status: 'loading' });
		try {
			const res = await fetch(`/api/stacks/${encodeURIComponent(stackName)}/deploys/${run.id}/log`);
			if (res.status === 404) {
				logs = new Map(logs).set(run.id, { status: 'missing' });
				return;
			}
			if (!res.ok) {
				logs = new Map(logs).set(run.id, { status: 'error', error: `Failed to load log (${res.status})` });
				return;
			}
			const text = await res.text();
			logs = new Map(logs).set(run.id, { status: 'loaded', text });
		} catch {
			logs = new Map(logs).set(run.id, { status: 'error', error: 'Failed to load log.' });
		}
	}

	/** Removes both the database record and the on-disk log file (see the DELETE
	 *  route's own doc comment) -- there is no "delete just the log" option, so a
	 *  removed run disappears from the list entirely rather than turning into a
	 *  metadata-only row nobody can act on. */
	async function deleteRun(run: DeployRun) {
		deletingIds = new Set(deletingIds).add(run.id);
		try {
			const res = await fetch(`/api/stacks/${encodeURIComponent(stackName)}/deploys/${run.id}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				toast.error(data?.error || 'Failed to delete deploy run');
				return;
			}
			runs = runs.filter((r) => r.id !== run.id);
			const s = new Set(expandedKeys);
			s.delete(run.id);
			expandedKeys = s;
			const l = new Map(logs);
			l.delete(run.id);
			logs = l;
			toast.success('Deploy run deleted');
		} catch {
			toast.error('Failed to delete deploy run');
		} finally {
			const d = new Set(deletingIds);
			d.delete(run.id);
			deletingIds = d;
			confirmDeleteId = null;
		}
	}

	async function loadRuns() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/deploys`, envId));
			if (!res.ok) {
				const data = await res.json().catch(() => null);
				loadError = data?.error || `Failed to load deploy history (${res.status})`;
				return;
			}
			const data = await res.json();
			runs = Array.isArray(data?.runs) ? data.runs : [];
		} catch {
			loadError = 'Failed to load deploy history.';
		} finally {
			loading = false;
		}
	}

	// Load on mount and whenever the parent bumps reloadKey (a deploy finished).
	$effect(() => {
		void reloadKey;
		loadRuns();
	});

	// Keep the parent's tab badge in sync: total + a success/failure split. Only
	// report once a load has settled -- reporting the initial empty `runs` while
	// still loading would momentarily clobber the parent's own pre-fetched tally
	// (making the badge flicker to nothing when the tab is first opened).
	$effect(() => {
		if (loading) return;
		onTally?.(deployTallyFromRuns(runs));
	});

	// Drag-resizable log height (px), shared by every expanded row's LogViewer and
	// persisted per browser. A handle below the log drags this between the bounds.
	const LOG_HEIGHT_KEY = 'dockhand-deploy-log-height';
	const LOG_MIN = 120, LOG_MAX = 720;
	let logHeight = $state(
		typeof localStorage !== 'undefined'
			? clampLog(Number(localStorage.getItem(LOG_HEIGHT_KEY)) || 256)
			: 256
	);
	let dragging = $state(false);
	let dragStartY = 0;
	let dragStartH = 0;

	function clampLog(h: number): number {
		return Math.min(LOG_MAX, Math.max(LOG_MIN, h));
	}

	function startLogResize(e: MouseEvent) {
		e.preventDefault();
		dragging = true;
		dragStartY = e.clientY;
		dragStartH = logHeight;
		window.addEventListener('mousemove', onLogResize);
		window.addEventListener('mouseup', endLogResize);
	}
	function onLogResize(e: MouseEvent) {
		if (!dragging) return;
		logHeight = clampLog(dragStartH + (e.clientY - dragStartY));
	}
	function endLogResize() {
		if (!dragging) return;
		dragging = false;
		window.removeEventListener('mousemove', onLogResize);
		window.removeEventListener('mouseup', endLogResize);
		try {
			localStorage.setItem(LOG_HEIGHT_KEY, String(logHeight));
		} catch { /* private mode - keep the in-memory value */ }
	}
	onDestroy(() => {
		window.removeEventListener('mousemove', onLogResize);
		window.removeEventListener('mouseup', endLogResize);
	});

	// Badge styles mirror the Schedules execution-history (getStatusBadge/getTriggerBadge)
	// so the Deploys grid reads the same as the rest of the app.
	function statusMeta(status: string) {
		switch (status) {
			case 'success':
				return { cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400', icon: Check, spin: false };
			case 'failed':
				return { cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', icon: X, spin: false };
			case 'running':
				return { cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400', icon: Loader2, spin: true };
			default:
				return { cls: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-400', icon: AlertTriangle, spin: false };
		}
	}

	function triggerMeta(triggeredBy: string) {
		switch (triggeredBy) {
			case 'cron':
				return { icon: Timer, cls: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400' };
			case 'webhook':
				return { icon: Webhook, cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' };
			case 'startup':
				return { icon: Power, cls: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400' };
			default:
				return { icon: Hand, cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' };
		}
	}
</script>

{#if loadError}
	<div class="flex min-h-[40vh] flex-col items-center justify-center py-10 text-center">
		<AlertTriangle class="mb-3 h-10 w-10 text-muted-foreground/40" />
		<p class="text-sm text-muted-foreground">{loadError}</p>
	</div>
{:else}
	<DataGrid
		data={sortedRuns}
		keyField="id"
		gridId="deploys"
		{loading}
		expandable
		bind:expandedKeys
		{onExpandChange}
		{sortState}
		onSortChange={(state) => (sortState = state)}
		onRowClick={(run, e) => {
			// Ignore clicks that originated on an interactive control (delete popover).
			if ((e.target as HTMLElement)?.closest('button')) return;
			toggleRun(run);
		}}
		class="border-none"
		wrapperClass="border rounded-lg"
	>
		{#snippet emptyState()}
			<div class="flex min-h-[40vh] flex-col items-center justify-center py-10 text-center">
				<Clock class="mb-3 h-10 w-10 text-muted-foreground/40" />
				<p class="text-sm text-muted-foreground">No deploy runs yet.</p>
				<p class="mt-1 text-xs text-muted-foreground">Deploy this stack — its run history appears here.</p>
			</div>
		{/snippet}

		{#snippet cell(column, run, _rowState)}
			{@const view = buildDeployRunView(run)}
			{#if column.id === 'status'}
				{@const meta = statusMeta(run.status)}
				{@const StatusIcon = meta.icon}
				<span class="inline-flex items-center gap-1.5">
					<Badge variant="default" class={meta.cls}>
						<StatusIcon class="h-3.5 w-3.5 {meta.spin ? 'animate-spin' : ''}" />
					</Badge>
					<span class="truncate text-xs">{view.statusLabel}</span>
				</span>
			{:else if column.id === 'when'}
				{#if run.startedAt}
					<span class="flex w-full items-center justify-between gap-2">
						<span>{formatRelativeTime(run.startedAt)}</span>
						<span class="text-muted-foreground tabular-nums">{formatDateTime(run.startedAt)}</span>
					</span>
				{:else}
					<span>—</span>
				{/if}
			{:else if column.id === 'duration'}
				<span class="block text-right text-muted-foreground tabular-nums">{view.duration}</span>
			{:else if column.id === 'trigger'}
				{@const tmeta = triggerMeta(run.triggeredBy)}
				{@const TrigIcon = tmeta.icon}
				<span class="inline-flex items-center gap-1.5">
					<Badge variant="default" class={tmeta.cls}>
						<TrigIcon class="h-3.5 w-3.5" />
					</Badge>
					<span class="truncate">{view.trigger}</span>
				</span>
			{:else if column.id === 'summary'}
				<div class="flex min-w-0 items-center gap-2">
					<span class="shrink-0 text-muted-foreground">{view.containerSummary} · {view.buildStatus}</span>
					{#if view.optionChips.length > 0}
						<span class="flex shrink-0 flex-wrap gap-1">
							{#each view.optionChips as chip}
								<span class="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{chip}</span>
							{/each}
						</span>
					{/if}
					{#if view.errorSummary}
						<span class="min-w-0 truncate text-destructive" title={run.errorMessage || ''}>{view.errorSummary}</span>
					{/if}
				</div>
			{:else if column.id === 'actions'}
				{@const panelState = buildDeployLogPanelState(run)}
				{#if panelState.deletable}
					<div class="flex justify-end">
						<ConfirmPopover
							open={confirmDeleteId === run.id}
							action="Delete"
							itemType="deploy run"
							title="Delete this run"
							position="left"
							disabled={deletingIds.has(run.id)}
							onConfirm={() => deleteRun(run)}
							onOpenChange={(open) => (confirmDeleteId = open ? run.id : null)}
						>
							{#snippet children({ open })}
								{#if deletingIds.has(run.id)}
									<Loader2 class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
								{:else}
									<Trash2 class="h-3.5 w-3.5 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
								{/if}
							{/snippet}
						</ConfirmPopover>
					</div>
				{/if}
			{/if}
		{/snippet}

		{#snippet expandedRow(run, _rowState)}
			{@const view = buildDeployRunView(run)}
			{@const panelState = buildDeployLogPanelState(run)}
			{@const logEntry = logs.get(run.id)}
			<div class="w-full p-4 pl-12 shadow-inner bg-muted text-xs">
				<div class="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
					<div>
						<div class="text-muted-foreground">Containers</div>
						<div>{view.containerSummary}</div>
						{#if view.containerNames.length > 0}
							<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
								{#each view.containerNames as cname}
									<span class="inline-flex items-center gap-1">
										<ContainerIcon image="" name={cname} showFallbackWhenOff class="w-3 h-3 shrink-0" />
										{cname}
									</span>
								{/each}
							</div>
						{/if}
					</div>
					<div>
						<div class="text-muted-foreground">Build</div>
						<div>{view.buildStatus}</div>
					</div>
					<div>
						<div class="text-muted-foreground">Triggered by</div>
						<div>{view.trigger}</div>
					</div>
				</div>
				{#if view.imagesBuilt.length > 0 || view.imagesPulled.length > 0}
					<div class="mt-2 space-y-1">
						{#if view.imagesBuilt.length > 0}
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
								<span class="text-muted-foreground">Built:</span>
								{#each view.imagesBuilt as img}
									<span class="inline-flex items-center gap-1">
										<ContainerIcon image={img} showFallbackWhenOff class="w-3 h-3 shrink-0" />
										{img}
									</span>
								{/each}
							</div>
						{/if}
						{#if view.imagesPulled.length > 0}
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
								<span class="text-muted-foreground">Pulled:</span>
								{#each view.imagesPulled as img}
									<span class="inline-flex items-center gap-1">
										<ContainerIcon image={img} showFallbackWhenOff class="w-3 h-3 shrink-0" />
										{img}
									</span>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
				<div class="mt-3">
					{#if panelState.truncated}
						<div class="mb-1">
							<span class="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
								<AlertTriangle class="h-2.5 w-2.5" /> Log truncated
							</span>
						</div>
					{/if}
					{#if panelState.logMissing || logEntry?.status === 'missing'}
						<!-- A confirmed-gone log file reads the same as an empty one if handed to
						     LogViewer with logs="" -- the two mean opposite things, so this case
						     gets its own message. -->
						<div class="rounded-md border border-dashed border-zinc-300 px-3 py-6 text-center text-muted-foreground dark:border-zinc-700">
							Protocol no longer available.
						</div>
					{:else if logEntry?.status === 'error'}
						<div class="rounded-md border border-dashed border-destructive/40 px-3 py-6 text-center text-destructive">
							{logEntry.error}
						</div>
					{:else}
						<div style="height: {logHeight}px">
							<LogViewer
								logs={logEntry?.text ?? ''}
								loading={logEntry?.status !== 'loaded'}
								title={`${stackName}-deploy-${run.id}`}
								autoRefresh={false}
								autoScroll={false}
								class="h-full"
								{theme}
							/>
						</div>
						<!-- Drag up/down to resize the log height (persisted). -->
						<div
							class="group flex h-2 cursor-row-resize items-center justify-center rounded-b bg-zinc-200 transition-colors hover:bg-blue-400 dark:bg-zinc-700 dark:hover:bg-blue-500 {dragging ? 'bg-blue-500 dark:bg-blue-400' : ''}"
							onmousedown={startLogResize}
							role="separator"
							aria-orientation="horizontal"
							tabindex="0"
							title="Drag to resize"
						>
							<GripHorizontal class="h-3 w-3 text-white opacity-0 transition-opacity group-hover:opacity-100 {dragging ? 'opacity-100' : ''}" />
						</div>
					{/if}
				</div>
			</div>
		{/snippet}
	</DataGrid>
{/if}
