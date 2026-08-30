<script lang="ts">
	/**
	 * Deploys tab: the recorded history of deploy runs for this stack (GET
	 * /api/stacks/{name}/deploys). Each run is a collapsed row by default --
	 * status, relative time, duration, and a one-line summary -- expandable for the
	 * full picture (containers, build/cache, images, options, a truncated notice,
	 * and on failure the shortened last error line). All of that text composition
	 * lives in deploy-run-view.ts, not here -- this component only fetches and binds.
	 *
	 * Mirrors BackupPanel/ExecutionHistoryList's shape (loading / empty / list),
	 * the sibling tab in this same modal -- see StackModal.svelte's Backups tab
	 * for the tab-gating convention this one follows.
	 *
	 * Expanding a row additionally loads that run's full protocol text (GET
	 * .../deploys/{id}/log) into the same LogViewer the live output window and
	 * the docked panel use -- but only on expand, never while the list itself
	 * loads: a run's log can be large, and the list is meant to stay quick.
	 * buildDeployLogPanelState (deploy-run-view.ts) decides what that fetch
	 * should even attempt: a run already known to be missing its log file
	 * (reconciled by deploy-log-reconcile) never triggers the request at all,
	 * since it would just 404.
	 *
	 * `envId === null` is NOT "nothing to ask for" -- it is the LOCAL
	 * environment (see the list route's own doc comment, `.../deploys/+server.ts`):
	 * appendEnvParam() only appends `env` when envId is truthy, so a
	 * single-environment install's own "deploy" calls never send one either,
	 * and every one of ITS runs is recorded with environmentId === null. The
	 * route now resolves an omitted `env` to exactly that filter. onMount
	 * below fetches unconditionally for that reason -- there is no longer a
	 * distinct "no environment selected" state to guard against here; the
	 * type this component receives (number | null) has no third value that
	 * could mean anything else.
	 */
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import {
		Loader2,
		ChevronDown,
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
	import { buildDeployRunView, buildDeployLogPanelState, type DeployRun } from '$lib/utils/deploy-run-view';
	import LogViewer from '../logs/LogViewer.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';

	interface Props {
		stackName: string;
		envId: number | null;
		// Forwarded to LogViewer so an expanded run's log follows the caller's editor
		// theme toggle instead of LogViewer's own 'dark' default.
		theme?: 'light' | 'dark';
	}
	let { stackName, envId, theme = 'dark' }: Props = $props();

	let runs = $state<DeployRun[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let expanded = $state<Set<number>>(new Set());

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

	function toggle(run: DeployRun) {
		const s = new Set(expanded);
		if (s.has(run.id)) {
			s.delete(run.id);
		} else {
			s.add(run.id);
			void loadLog(run);
		}
		expanded = s;
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
			const s = new Set(expanded);
			s.delete(run.id);
			expanded = s;
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

	onMount(async () => {
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
	});

	function statusBadge(status: string) {
		switch (status) {
			case 'success':
				return { cls: 'bg-emerald-500/15 text-emerald-500', icon: Check };
			case 'failed':
				return { cls: 'bg-red-500/15 text-red-500', icon: X };
			case 'running':
				return { cls: 'bg-sky-500/15 text-sky-500', icon: Loader2 };
			default:
				return { cls: 'bg-muted text-muted-foreground', icon: AlertTriangle };
		}
	}

	function triggerIcon(triggeredBy: string) {
		switch (triggeredBy) {
			case 'cron':
				return Timer;
			case 'webhook':
				return Webhook;
			case 'startup':
				return Power;
			default:
				return Hand;
		}
	}
</script>

{#if loading}
	<div class="flex justify-center py-8"><Loader2 class="h-5 w-5 animate-spin text-muted-foreground" /></div>
{:else if loadError}
	<div class="flex min-h-[40vh] flex-col items-center justify-center py-10 text-center">
		<AlertTriangle class="mb-3 h-10 w-10 text-muted-foreground/40" />
		<p class="text-sm text-muted-foreground">{loadError}</p>
	</div>
{:else if runs.length === 0}
	<div class="flex min-h-[40vh] flex-col items-center justify-center py-10 text-center">
		<Clock class="mb-3 h-10 w-10 text-muted-foreground/40" />
		<p class="text-sm text-muted-foreground">No deploy runs yet.</p>
		<p class="mt-1 text-xs text-muted-foreground">Deploy this stack — its run history appears here.</p>
	</div>
{:else}
	<div class="space-y-1.5">
		{#each runs as run (run.id)}
			{@const view = buildDeployRunView(run)}
			{@const badge = statusBadge(run.status)}
			{@const BadgeIcon = badge.icon}
			{@const TrigIcon = triggerIcon(run.triggeredBy)}
			{@const isOpen = expanded.has(run.id)}
			{@const panelState = buildDeployLogPanelState(run)}
			{@const logEntry = logs.get(run.id)}
			<div class="rounded-md border border-zinc-200 dark:border-zinc-700">
				<button
					type="button"
					class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-muted/30"
					onclick={() => toggle(run)}
				>
					<ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform {isOpen ? '' : '-rotate-90'}" />
					<span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded {badge.cls}" title={view.statusLabel}>
						<BadgeIcon class="h-3 w-3 {run.status === 'running' ? 'animate-spin' : ''}" />
					</span>
					<span class="shrink-0" title={run.startedAt ? formatDateTime(run.startedAt, true) : ''}>
						{run.startedAt ? formatRelativeTime(run.startedAt) : '—'}
					</span>
					<span class="shrink-0 text-muted-foreground">{view.duration}</span>
					<span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground" title={view.trigger}>
						<TrigIcon class="h-3 w-3" />
					</span>
					<span class="min-w-0 flex-1 truncate text-muted-foreground">
						{view.containerSummary} · {view.buildStatus}
					</span>
					{#if view.errorSummary}
						<span class="max-w-[300px] shrink truncate text-destructive" title={run.errorMessage || ''}>{view.errorSummary}</span>
					{/if}
				</button>
				{#if isOpen}
					<div class="border-t border-zinc-200 px-3 py-2.5 text-xs dark:border-zinc-700">
						<div class="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
							<div>
								<div class="text-muted-foreground">Containers</div>
								<div>{view.containerSummary}</div>
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
						{#if view.optionChips.length > 0}
							<div class="mt-2 flex flex-wrap gap-1">
								{#each view.optionChips as chip}
									<span class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{chip}</span>
								{/each}
							</div>
						{/if}
						{#if view.imagesBuilt.length > 0 || view.imagesPulled.length > 0}
							<div class="mt-2 space-y-1">
								{#if view.imagesBuilt.length > 0}
									<div><span class="text-muted-foreground">Built:</span> {view.imagesBuilt.join(', ')}</div>
								{/if}
								{#if view.imagesPulled.length > 0}
									<div><span class="text-muted-foreground">Pulled:</span> {view.imagesPulled.join(', ')}</div>
								{/if}
							</div>
						{/if}
						{#if view.errorSummary}
							<!-- The task-17 spec called for the shortened last error line here (same
							     text the collapsed row already truncates to) -- not the raw errorMessage,
							     which is compose's full stderr and, for a failed run, duplicates almost
							     everything the log panel below shows. One line of "what went wrong" is a
							     useful recap next to the run's other details; the full text belongs in
							     exactly one place, the LogViewer beneath it. -->
							<div class="mt-2 rounded-md border border-l-[3px] border-destructive/40 border-l-destructive bg-destructive/5 px-2 py-1.5">
								<span class="font-mono text-[11px] text-destructive/90">{view.errorSummary}</span>
							</div>
						{/if}
						<div class="mt-3">
							<div class="mb-1 flex items-center justify-between">
								<span class="text-muted-foreground">Log</span>
								{#if panelState.deletable}
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
												<Loader2 class="h-3 w-3 animate-spin text-muted-foreground" />
											{:else}
												<Trash2 class="h-3 w-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
											{/if}
										{/snippet}
									</ConfirmPopover>
								{/if}
							</div>
							{#if panelState.truncated}
								<!-- The notice belongs directly above the viewer it describes, not
								     among the run's other metadata -- it says something about the
								     text below it, not about the run as a whole. -->
								<div class="mb-1 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
									<AlertTriangle class="h-2.5 w-2.5" /> Log truncated
								</div>
							{/if}
							{#if panelState.logMissing || logEntry?.status === 'missing'}
								<!-- A confirmed-gone log file reads the same as an empty one if it's
								     just handed to LogViewer with logs="" -- the two mean opposite
								     things (nothing happened vs. the record of what happened is
								     gone), so this case gets its own, unambiguous message instead. -->
								<div class="rounded-md border border-dashed border-zinc-300 px-3 py-6 text-center text-muted-foreground dark:border-zinc-700">
									Protocol no longer available.
								</div>
							{:else if logEntry?.status === 'error'}
								<div class="rounded-md border border-dashed border-destructive/40 px-3 py-6 text-center text-destructive">
									{logEntry.error}
								</div>
							{:else}
								<LogViewer
									logs={logEntry?.text ?? ''}
									loading={logEntry?.status !== 'loaded'}
									title={`${stackName}-deploy-${run.id}`}
									autoRefresh={false}
									autoScroll={false}
									class="h-64"
									{theme}
								/>
							{/if}
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
