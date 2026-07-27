<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { CircleArrowUp, Check, XCircle } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { appendEnvParam } from '$lib/stores/environment';
	import { watchJob } from '$lib/utils/sse-fetch';

	export interface UpdateCheckResultItem {
		containerId: string;
		containerName: string;
		imageName: string;
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
		onComplete?: (result: { withUpdates: UpdateCheckResultItem[]; failed: FailedCheckItem[] }) => void;
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
		toast.warning(`${prefix} (${failed.length} failed to check)`, {
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

			if (withUpdates.length === 0) {
				// Keep the "Latest" status until re-check / env-switch — don't auto-revert (#1019)
				status = 'none';
				if (failed.length > 0) {
					showFailedChecksToast(failed, 'All containers are up to date');
				} else {
					toast.success('All containers are up to date');
				}
			} else {
				status = 'found';
				if (failed.length > 0) {
					showFailedChecksToast(failed, `${withUpdates.length} update(s) available`);
				} else {
					toast.info(`${withUpdates.length} update(s) available`);
				}
			}

			onComplete?.({ withUpdates, failed });
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
	title="Check for available updates"
	class="relative overflow-hidden"
>
	{#if displayStatus === 'checking'}
		<CircleArrowUp class="w-3.5 h-3.5 animate-spin" />
		{#if progress.total > 0}
			<span class="tabular-nums">Checking {String(progress.checked).padStart(String(progress.total).length, ' ')}/{progress.total}</span>
			<div
				class="absolute bottom-0 left-0 h-px bg-foreground transition-[width] duration-150 ease-out"
				style="width: {(progress.checked / progress.total) * 100}%"
			></div>
		{:else}
			Check for updates
		{/if}
	{:else if displayStatus === 'none' || displayStatus === 'found'}
		<Check class="w-3.5 h-3.5 mr-1 text-green-600" />
		Check for updates
	{:else if displayStatus === 'error'}
		<XCircle class="w-3.5 h-3.5 mr-1 text-destructive" />
		Check for updates
	{:else}
		<CircleArrowUp class="w-3.5 h-3.5" />
		Check for updates
	{/if}
</Button>
