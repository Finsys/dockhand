<script lang="ts">
	/**
	 * Deploys tab: the recorded history of deploy runs for this stack (Task 16's
	 * GET /api/stacks/{name}/deploys). Each run is a collapsed row by default --
	 * status, relative time, duration, and a one-line summary -- expandable for the
	 * full picture (containers, build/cache, images, options, a truncated notice,
	 * and on failure the shortened last error line). All of that text composition
	 * lives in deploy-run-view.ts, not here -- this component only fetches and binds.
	 *
	 * Mirrors BackupPanel/ExecutionHistoryList's shape (loading / empty / list),
	 * the sibling tab in this same modal -- see StackModal.svelte's Backups tab
	 * for the tab-gating convention this one follows.
	 */
	import { onMount } from 'svelte';
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
		AlertTriangle
	} from 'lucide-svelte';
	import { formatRelativeTime, formatDateTime } from '$lib/stores/settings';
	import { appendEnvParam } from '$lib/stores/environment';
	import { buildDeployRunView, type DeployRun } from '$lib/utils/deploy-run-view';

	interface Props {
		stackName: string;
		envId: number | null;
	}
	let { stackName, envId }: Props = $props();

	let runs = $state<DeployRun[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let expanded = $state<Set<number>>(new Set());

	function toggle(id: number) {
		const s = new Set(expanded);
		s.has(id) ? s.delete(id) : s.add(id);
		expanded = s;
	}

	onMount(async () => {
		// GET .../deploys requires `env` (a bare stack name is not unique across
		// environments -- see the route's own doc comment). Without a known
		// environment there is nothing valid to ask for, so show that state
		// instead of firing a request the endpoint would 400 anyway.
		if (envId === null) {
			loading = false;
			loadError = 'No environment selected.';
			return;
		}
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
			<div class="rounded-md border border-zinc-200 dark:border-zinc-700">
				<button
					type="button"
					class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-muted/30"
					onclick={() => toggle(run.id)}
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
						{#if view.truncated}
							<div class="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
								<AlertTriangle class="h-2.5 w-2.5" /> Log truncated
							</div>
						{/if}
						{#if view.errorSummary}
							<div class="mt-2 rounded-md border border-l-[3px] border-destructive/40 border-l-destructive bg-destructive/5 p-2">
								<pre class="whitespace-pre-wrap break-all font-mono text-[11px] text-destructive/90">{run.errorMessage}</pre>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
