<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { CircleArrowUp, Check, XCircle } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { noUpdatesOutcome, summarizeCheck, type UpdateCheckResultItem, type PinnedDigestItem, type NewerVersionItem, type FailedCheckItem, type CheckResult } from '$lib/utils/update-check-outcome';
	import CheckUpdatesToast from './CheckUpdatesToast.svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { watchJob } from '$lib/utils/sse-fetch';
	import type { NewerVersion } from '$lib/types';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		envId: number | null;
		/** When true and no check is running, the button reflects the "updates found" (green) state — e.g. from persisted pending updates loaded on mount. */
		hasPendingUpdates?: boolean;
		/** Only these containers count toward the result; the stacks page passes its stacks' containers. */
		containerIds?: Set<string>;
		/** Called when a check finishes with the containers that have updates and any failures. */
		onComplete?: (result: {
			withUpdates: UpdateCheckResultItem[];
			failed: FailedCheckItem[];
			newerVersions: NewerVersionItem<NewerVersion>[];
			/** Containers whose tag moved to a new digest but which stay pinned to the old one. */
			pinned: PinnedDigestItem[];
			/** Containers whose update is held by the minimum image age, as id -> hours left. */
			coolingDown: Map<string, number>;
		}) => void;
	}

	let { envId, hasPendingUpdates = false, containerIds, onComplete }: Props = $props();

	type Status = 'idle' | 'checking' | 'found' | 'none' | 'error';
	let status = $state<Status>('idle');
	let progress = $state({ checked: 0, total: 0 });
	let btnEl = $state<HTMLButtonElement | null>(null);
	let errorTimeout: ReturnType<typeof setTimeout> | null = null;

	function unlockWidth() {
		if (btnEl) btnEl.style.minWidth = '';
	}

	// Reset the button state when the environment changes — a "Latest" result
	// from one environment must not linger on another.
	let lastEnvId = $state<number | null>(null);
	$effect(() => {
		if (envId !== lastEnvId) {
			lastEnvId = envId;
			unlockWidth();
			status = 'idle';
		}
	});

	// Exposed so parents can reset after a related action (e.g. batch update).
	export function reset() {
		unlockWidth();
		status = 'idle';
	}

	onDestroy(() => {
		if (errorTimeout) clearTimeout(errorTimeout);
	});

	// When idle, reflect persisted pending updates as the "found" (green) state.
	const displayStatus = $derived(status === 'idle' && hasPendingUpdates ? 'found' : status);

	type SummaryCounts = { updates: number; newerTags: number; pinned: number; coolingDown: number };
	const NO_COUNTS: SummaryCounts = { updates: 0, newerTags: 0, pinned: 0, coolingDown: 0 };

	// A toast with failures stays until dismissed, so the list can be read.
	function showSummaryToast(counts: SummaryCounts, failed: FailedCheckItem[], headline?: string) {
		toast.custom(CheckUpdatesToast, {
			componentProps: { ...counts, failed, headline, envId },
			duration: failed.length > 0 ? Infinity : undefined,
			unstyled: true
		});
	}

	async function checkForUpdates() {
		status = 'checking';
		progress = { checked: 0, total: 0 };

		// Lock button width to prevent layout shift
		if (btnEl) btnEl.style.minWidth = `${btnEl.offsetWidth}px`;

		const failError = () => {
			status = 'error';
			if (errorTimeout) clearTimeout(errorTimeout);
			errorTimeout = setTimeout(() => { status = 'idle'; }, 3000);
			unlockWidth();
		};

		try {
			const response = await fetch(appendEnvParam('/api/containers/check-updates', envId), {
				method: 'POST'
			});
			if (!response.ok) {
				failError();
				return;
			}
			const { jobId } = await response.json();

			const data: any = await watchJob(jobId, (line) => {
				if (line.event === 'progress') {
					progress = line.data as { checked: number; total: number };
				}
			});

			// A failed/malformed job resolves without a results array — treat as error
			// rather than silently reporting "all up to date".
			if (!data || !Array.isArray(data.results)) {
				failError();
				return;
			}

			unlockWidth();
			const { withUpdates, pinned, failed, deferred, newerVersions, counts } = summarizeCheck(data.results as CheckResult<NewerVersion>[], containerIds);

			if (withUpdates.length === 0 && newerVersions.length === 0 && pinned.length === 0) {
				const outcome = noUpdatesOutcome(counts.failed, counts.checkable, deferred.length);
				if (outcome.status === 'error') {
					// Every check failed: nothing is known to be current, so no "Latest" state.
					failError();
				} else {
					// Keep the "Latest" status until re-check / env-switch - don't auto-revert (#1019)
					status = 'none';
				}
				if (failed.length > 0) {
					// Held updates show as their own count; a headline stands in only when there is none.
					if (outcome.headline === 'cooling-down') {
						showSummaryToast({ ...NO_COUNTS, coolingDown: deferred.length }, failed);
					} else {
						showSummaryToast(NO_COUNTS, failed, outcome.headline === 'all-failed' ? m.updates_check_failed_all() : m.updates_rest_up_to_date());
					}
				} else if (deferred.length > 0) {
					toast.info(m.updates_cooling_down({ count: deferred.length }), {
						description: deferred.map((r: any) => m.updates_hours_remaining({ name: r.containerName, count: r.releaseAgeRemainingHours })).join('\n'),
						descriptionClass: 'whitespace-pre-line'
					});
				} else {
					toast.success(m.updates_all_up_to_date());
				}
			} else {
				status = 'found';
				// A newer version tag is a real result even when no digest update exists,
				// so it counts toward the "found" state and the summary.
				showSummaryToast(
					{ updates: withUpdates.length, newerTags: newerVersions.length, pinned: pinned.length, coolingDown: deferred.length },
					failed
				);
			}

			onComplete?.({
				withUpdates,
				failed,
				newerVersions,
				pinned,
				coolingDown: new Map(deferred.map((r: any) => [r.containerId, r.releaseAgeRemainingHours as number]))
			});
		} catch {
			failError();
		}
	}
</script>

<Button
	bind:ref={btnEl}
	size="sm"
	variant="outline"
	onclick={checkForUpdates}
	disabled={status === 'checking'}
	title={m.updates_check_title()}
	class="relative overflow-hidden"
>
	{#if displayStatus === 'checking'}
		<CircleArrowUp class="w-3.5 h-3.5 animate-spin" />
		{#if progress.total > 0}
			<span class="tabular-nums">{m.updates_checking_progress({ checked: String(progress.checked).padStart(String(progress.total).length, ' '), total: progress.total })}</span>
			<div
				class="absolute bottom-0 left-0 h-px bg-foreground transition-[width] duration-150 ease-out"
				style="width: {(progress.checked / progress.total) * 100}%"
			></div>
		{:else}
			{m.updates_check()}
		{/if}
	{:else if displayStatus === 'none' || displayStatus === 'found'}
		<Check class="w-3.5 h-3.5 mr-1 text-green-600" />
		{m.updates_check()}
	{:else if displayStatus === 'error'}
		<XCircle class="w-3.5 h-3.5 mr-1 text-destructive" />
		{m.updates_check()}
	{:else}
		<CircleArrowUp class="w-3.5 h-3.5" />
		{m.updates_check()}
	{/if}
</Button>
