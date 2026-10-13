<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { CircleArrowUp, Check, XCircle } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { appendEnvParam } from '$lib/stores/environment';
	import { watchJob } from '$lib/utils/sse-fetch';
	import type { NewerVersion } from '$lib/types';
	import { m } from '$lib/paraglide/messages.js';

	export interface UpdateCheckResultItem {
		containerId: string;
		containerName: string;
		imageName: string;
	}

	/** A container that has a newer VERSION tag (semver) — independent of digest updates. */
	export interface NewerVersionItem {
		containerId: string;
		newerVersion: NewerVersion;
	}

	export interface FailedCheckItem {
		containerId: string;
		containerName: string;
		imageName: string;
		error: string;
	}

	interface Props {
		envId: number | null;
		/** When true and no check is running, the button reflects the "updates found" (green) state — e.g. from persisted pending updates loaded on mount. */
		hasPendingUpdates?: boolean;
		/** Called when a check finishes with the containers that have updates and any failures. */
		onComplete?: (result: {
			withUpdates: UpdateCheckResultItem[];
			failed: FailedCheckItem[];
			newerVersions: NewerVersionItem[];
			/** Containers whose update is held by the minimum image age, as id -> hours left. */
			coolingDown: Map<string, number>;
		}) => void;
	}

	let { envId, hasPendingUpdates = false, onComplete }: Props = $props();

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

	function showFailedChecksToast(failed: FailedCheckItem[], prefix: string) {
		const details = failed.map((f) => `• ${f.containerName}: ${f.error}`).join('\n');
		toast.warning(m.updates_failed_checks_summary({ summary: prefix, count: failed.length }), {
			description: details,
			descriptionClass: 'whitespace-pre-line',
			class: '!w-[28rem] !max-w-[28rem]',
			duration: Infinity,
			action: { label: 'OK', onClick: () => {} }
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

			const withUpdates: UpdateCheckResultItem[] = data.results
				.filter((r: any) => r.hasUpdate && !r.systemContainer && !r.updateDisabled && !r.isLocalImage)
				.map((r: any) => ({ containerId: r.containerId, containerName: r.containerName, imageName: r.imageName }));
			const failed: FailedCheckItem[] = data.results
				.filter((r: any) => r.error && !r.hasUpdate)
				.map((r: any) => ({ containerId: r.containerId, containerName: r.containerName, imageName: r.imageName, error: r.error }));
			const deferred = data.results.filter((r: any) => r.releaseAgeRemainingHours && !r.systemContainer && !r.updateDisabled);
			// Semver suggestions are independent of digest updates: a container can be
			// digest-current yet run an outdated version tag.
			const newerVersions: NewerVersionItem[] = data.results
				.filter((r: any) => r.newerVersion && !r.systemContainer && !r.updateDisabled)
				.map((r: any) => ({ containerId: r.containerId, newerVersion: r.newerVersion }));

			// A newer version tag is a real result even when no digest update exists,
			// so it counts toward the "found" state and the summary message.
			const semverNote = newerVersions.length > 0
				? m.updates_newer_version_tags({ count: newerVersions.length })
				: '';

			if (withUpdates.length === 0 && newerVersions.length === 0) {
				// Keep the "Latest" status until re-check / env-switch — don't auto-revert (#1019)
				status = 'none';
				if (failed.length > 0) {
					showFailedChecksToast(failed, deferred.length > 0 ? m.updates_cooling_down({ count: deferred.length }) : m.updates_all_up_to_date());
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
				const parts = [
					withUpdates.length > 0 ? m.updates_available_count({ count: withUpdates.length }) : '',
					semverNote,
					deferred.length > 0 ? m.updates_cooling_down_short({ count: deferred.length }) : ''
				].filter(Boolean);
				const summary = parts.join(', ');
				if (failed.length > 0) {
					showFailedChecksToast(failed, summary);
				} else {
					toast.info(summary);
				}
			}

			onComplete?.({
				withUpdates,
				failed,
				newerVersions,
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
