<script lang="ts">
	/**
	 * Shared backup execution-history table. Renders a list of schedule executions
	 * (run time, trigger, duration, status, detail/error) with failed rows expandable
	 * inline. Used by the backup surfaces (container/stack modal Backups tab, main
	 * Backups page). The data comes from /api/schedules/executions — the same source
	 * the Schedules view uses.
	 */
	import { Check, X, AlertTriangle, Clock, CheckCheck, AlertCircle, Timer, Hand, Webhook, ChevronDown, FileText, Loader2 } from 'lucide-svelte';
	import { formatDateTime } from '$lib/stores/settings';
	import { formatBytes } from '$lib/utils/format';
	import { getRepoTypeIcon } from '$lib/utils/backup';
	import type { Execution } from '$lib/utils/execution-tally';

	interface Props {
		executions: Execution[];
		loading?: boolean;
		/** Optional: open the full log dialog for one execution. */
		onViewLog?: (id: number) => void;
	}
	let { executions, loading = false, onViewLog }: Props = $props();

	// Show the Repo column only when at least one run carries a stamped repo
	// (fetchBackupExecutions was given a config→destination map). Off on surfaces
	// that already scope to a single repo, so the table stays compact.
	const showRepo = $derived(executions.some((e) => e._repository || e._destinationName));

	let expanded = $state<Set<number>>(new Set());
	function toggle(id: number) {
		const s = new Set(expanded);
		s.has(id) ? s.delete(id) : s.add(id);
		expanded = s;
	}

	function cleanError(msg: string): string {
		try { const p = JSON.parse(msg); if (p.message) return p.message; } catch {}
		const m = msg.match(/\{"message":"([^"]+)"\}/);
		return m ? msg.replace(m[0], m[1]) : msg;
	}

	function formatDuration(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
	}

	function statusBadge(status: string) {
		switch (status) {
			case 'success': return { cls: 'bg-emerald-500/15 text-emerald-500', icon: Check };
			case 'warning': return { cls: 'bg-amber-500/15 text-amber-500', icon: AlertTriangle };
			case 'failed':  return { cls: 'bg-red-500/15 text-red-500', icon: X };
			case 'running': return { cls: 'bg-sky-500/15 text-sky-500', icon: Loader2 };
			case 'skipped': return { cls: 'bg-muted text-muted-foreground', icon: CheckCheck };
			case 'queued':  return { cls: 'bg-amber-500/15 text-amber-500', icon: Clock };
			default:        return { cls: 'bg-muted text-muted-foreground', icon: AlertCircle };
		}
	}

	function triggerIcon(trigger: string) {
		switch (trigger) {
			case 'cron': return Timer;
			case 'webhook': return Webhook;
			default: return Hand;
		}
	}
	function triggerLabel(trigger: string) {
		return trigger === 'cron' ? 'Scheduled' : trigger === 'webhook' ? 'Webhook' : 'Manual';
	}
</script>

{#if loading && executions.length === 0}
	<div class="flex justify-center py-8"><Loader2 class="h-5 w-5 animate-spin text-muted-foreground" /></div>
{:else if executions.length === 0}
	<div class="flex flex-col items-center justify-center py-10 text-center">
		<Clock class="mb-3 h-10 w-10 text-muted-foreground/40" />
		<p class="text-sm text-muted-foreground">No backup runs yet.</p>
		<p class="mt-1 text-xs text-muted-foreground">Run a backup — its history appears here.</p>
	</div>
{:else}
	<div class="overflow-x-auto">
		<table class="w-full text-xs">
			<thead>
				<tr class="border-b text-left text-muted-foreground">
					<th class="py-1.5 pl-2 font-medium">Run</th>
					<th class="py-1.5 pl-2 text-center font-medium">Trigger</th>
					<th class="py-1.5 pl-2 font-medium">Duration</th>
					<th class="py-1.5 pl-2 text-center font-medium">Status</th>
					<th class="py-1.5 pl-2 font-medium">Detail</th>
					{#if showRepo}<th class="py-1.5 pl-2 font-medium">Repo</th>{/if}
					<th class="py-1.5 pr-2 font-medium"></th>
				</tr>
			</thead>
			<tbody>
				{#each executions as exec}
					{@const badge = statusBadge(exec.status)}
					{@const BadgeIcon = badge.icon}
					{@const TrigIcon = triggerIcon(exec.triggeredBy)}
					{@const isFail = exec.status === 'failed'}
					{@const isOpen = expanded.has(exec.id)}
					<tr class="border-b text-xs last:border-0 hover:bg-muted/30">
						<td class="py-1.5 pl-2 font-mono">{exec.triggeredAt ? formatDateTime(exec.triggeredAt, true) : '—'}</td>
						<td class="py-1.5 pl-2 text-center">
							<span class="inline-flex h-5 w-5 items-center justify-center rounded bg-muted text-muted-foreground" title={triggerLabel(exec.triggeredBy)}>
								<TrigIcon class="h-3 w-3" />
							</span>
						</td>
						<td class="py-1.5 pl-2 font-mono text-muted-foreground">{formatDuration(exec.duration)}</td>
						<td class="py-1.5 pl-2 text-center">
							<span class="inline-flex h-5 w-5 items-center justify-center rounded {badge.cls}" title={exec.status}>
								<BadgeIcon class="h-3 w-3 {exec.status === 'running' ? 'animate-spin' : ''}" />
							</span>
						</td>
						<td class="max-w-[360px] truncate py-1.5 pl-2" title={exec.errorMessage || ''}>
							{#if exec.errorMessage}
								<span class="text-destructive">{cleanError(exec.errorMessage)}</span>
							{:else if exec.status === 'success' && exec.details?.dataAdded !== undefined}
								<span class="text-muted-foreground">{exec.details.filesNew ?? 0} new · {exec.details.filesChanged ?? 0} changed · {formatBytes(exec.details.dataAdded ?? 0)}</span>
							{:else}
								<span class="text-muted-foreground/60">—</span>
							{/if}
						</td>
						{#if showRepo}
							{@const RepoIcon = getRepoTypeIcon(exec._repository || "")}
							<td class="max-w-[180px] truncate py-1.5 pl-2 text-muted-foreground" title={exec._repository || exec._destinationName || ""}>
								{#if exec._repository || exec._destinationName}
									<span class="inline-flex items-center gap-1.5"><RepoIcon class="h-3 w-3 shrink-0" /><span class="truncate">{exec._destinationName || exec._repository}</span></span>
								{:else}
									<span class="text-muted-foreground/60">—</span>
								{/if}
							</td>
						{/if}
						<td class="py-1.5 pr-2 text-right">
							<div class="flex items-center justify-end gap-0.5">
								{#if onViewLog}
									<button type="button" class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onclick={() => onViewLog?.(exec.id)} title="View log">
										<FileText class="h-3 w-3" />
									</button>
								{/if}
								{#if isFail && exec.errorMessage}
									<button type="button" class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onclick={() => toggle(exec.id)} title={isOpen ? 'Hide error' : 'Show error'}>
										<ChevronDown class="h-3.5 w-3.5 transition-transform {isOpen ? '' : '-rotate-90'}" />
									</button>
								{/if}
							</div>
						</td>
					</tr>
					{#if isFail && isOpen && exec.errorMessage}
						<tr class="bg-destructive/5">
							<td colspan={showRepo ? 7 : 6} class="px-2 py-2">
								<div class="rounded-md border border-l-[3px] border-destructive/40 border-l-destructive bg-destructive/5 p-2.5">
									<div class="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-destructive">
										<X class="h-3 w-3" /> Backup failed
									</div>
									<pre class="whitespace-pre-wrap break-all font-mono text-[11px] text-destructive/90">{exec.errorMessage}</pre>
								</div>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
{/if}
