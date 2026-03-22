<script lang="ts">
	import { tick, onMount } from 'svelte';
	import { CheckCircle2, XCircle, Loader2, AlertCircle, Terminal, Sun, Moon, Upload } from 'lucide-svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { watchJob } from '$lib/utils/sse-fetch';

	type PushStatus = 'idle' | 'pushing' | 'complete' | 'error';

	interface Props {
		sourceImageName: string;
		registryId: number;
		newTag?: string;
		registryName?: string;
		envId?: number | null;
		autoStart?: boolean;
		onComplete?: (targetTag: string) => void;
		onError?: (error: string) => void;
		onStatusChange?: (status: PushStatus) => void;
	}

	let {
		sourceImageName,
		registryId,
		newTag = '',
		registryName = 'registry',
		envId = null,
		autoStart = false,
		onComplete,
		onError,
		onStatusChange
	}: Props = $props();

	let status = $state<PushStatus>('idle');
	let errorMessage = $state('');
	let statusMessage = $state('');
	let targetTag = $state('');
	let outputLines = $state<string[]>([]);
	let outputContainer: HTMLDivElement | undefined;
	let logDarkMode = $state(true);

	// Notify parent of status changes
	$effect(() => {
		onStatusChange?.(status);
	});

	onMount(() => {
		const saved = localStorage.getItem('logTheme');
		if (saved !== null) {
			logDarkMode = saved === 'dark';
		}
	});

	$effect(() => {
		if (autoStart && sourceImageName && registryId && status === 'idle') {
			startPush();
		}
	});

	function toggleLogTheme() {
		logDarkMode = !logDarkMode;
		localStorage.setItem('logTheme', logDarkMode ? 'dark' : 'light');
	}

	async function scrollOutputToBottom() {
		await tick();
		if (outputContainer) {
			outputContainer.scrollTop = outputContainer.scrollHeight;
		}
	}

	function addOutputLine(line: string) {
		outputLines = [...outputLines, line];
		scrollOutputToBottom();
	}

	export function reset() {
		status = 'idle';
		errorMessage = '';
		statusMessage = '';
		targetTag = '';
		outputLines = [];
	}

	export function getStatus() {
		return status;
	}

	export async function startPush() {
		if (!sourceImageName || !registryId) return;

		reset();
		status = 'pushing';
		statusMessage = 'Finding image...';

		try {
			// Small delay to ensure image is indexed
			await new Promise(resolve => setTimeout(resolve, 500));

			// Get the image ID from the pulled image
			const imagesResponse = await fetch(appendEnvParam('/api/images', envId));
			const images = await imagesResponse.json();

			const searchName = sourceImageName.includes(':') ? sourceImageName : `${sourceImageName}:latest`;
			const searchNameNoTag = sourceImageName.split(':')[0];

			const pulledImage = images.find((img: any) => {
				if (!img.tags || img.tags.length === 0) return false;
				return img.tags.some((t: string) => {
					if (t === searchName || t === sourceImageName) return true;
					if (t === `${searchNameNoTag}:latest`) return true;
					if (t === `library/${searchName}` || t === `library/${searchNameNoTag}:latest`) return true;
					if (t.startsWith(searchNameNoTag + ':')) return true;
					return false;
				});
			});

			if (!pulledImage) {
				console.log('Looking for:', sourceImageName, 'Available tags:', images.map((i: any) => i.tags).flat());
				errorMessage = 'Could not find image to push';
				status = 'error';
				onError?.(errorMessage);
				return;
			}

			addOutputLine(`[push] Starting push to ${registryName}...`);

			// Push to target registry with streaming
			const pushResponse = await fetch(appendEnvParam('/api/images/push', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					imageId: pulledImage.id,
					imageName: sourceImageName,
					registryId: registryId,
					newTag: newTag || null
				})
			});

			if (!pushResponse.ok) {
				const data = await pushResponse.json();
				errorMessage = data.error || 'Failed to push image';
				status = 'error';
				addOutputLine(`[error] ${errorMessage}`);
				onError?.(errorMessage);
				return;
			}

			const { jobId } = await pushResponse.json();
			await watchJob(jobId, (line) => {
				handlePushProgress(line.data as any);
			});

			// If job ended without an explicit complete/error event
			if (status === 'pushing') {
				status = 'complete';
				statusMessage = 'Image pushed successfully!';
				addOutputLine(`[push] Push complete!`);
				onComplete?.(targetTag);
			}
		} catch (error: any) {
			console.error('Failed to push image:', error);
			errorMessage = error.message || 'Failed to push image';
			status = 'error';
			addOutputLine(`[error] ${errorMessage}`);
			onError?.(errorMessage);
		}
	}

	function handlePushProgress(data: any) {
		if (data.targetTag) {
			targetTag = data.targetTag;
		}

		if (data.status === 'tagging') {
			addOutputLine(`[push] Tagging image for target registry...`);
		} else if (data.status === 'pushing') {
			addOutputLine(`[push] Pushing layers...`);
		} else if (data.status === 'complete') {
			statusMessage = data.message || 'Image pushed successfully!';
			status = 'complete';
			addOutputLine(`[push] ${data.message || 'Push complete!'}`);
			onComplete?.(targetTag || data.targetTag || '');
		} else if (data.status === 'error' || data.error) {
			errorMessage = data.error || 'Push failed';
			status = 'error';
			addOutputLine(`[error] ${data.error}`);
			onError?.(errorMessage);
		} else if (data.id && data.status) {
			// Layer progress
			const progress = data.progress ? ` ${data.progress}` : '';
			addOutputLine(`[layer ${data.id.substring(0, 12)}] ${data.status}${progress}`);
		} else if (data.message) {
			// Generic message (not part of above statuses)
			statusMessage = data.message;
			addOutputLine(`[push] ${data.message}`);
		}
	}

	const isPushing = $derived(status === 'pushing');
</script>

<div class="flex flex-col gap-4 flex-1 min-h-0">
	<!-- Status Section -->
	{#if status !== 'idle'}
		<div class="space-y-2 shrink-0">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					{#if status === 'pushing'}
						<Loader2 class="w-4 h-4 animate-spin text-blue-600" />
						<span class="text-sm">{statusMessage}</span>
					{:else if status === 'complete'}
						<CheckCircle2 class="w-4 h-4 text-green-600" />
						<span class="text-sm text-green-600">Push complete!</span>
					{:else if status === 'error'}
						<XCircle class="w-4 h-4 text-red-600" />
						<span class="text-sm text-red-600">Push failed</span>
					{/if}
				</div>
				{#if status === 'complete' && targetTag}
					<code class="text-xs bg-muted px-2 py-1 rounded">{targetTag}</code>
				{/if}
			</div>

			{#if errorMessage}
				<div class="p-3 rounded-lg bg-destructive/10 border border-destructive/30">
					<div class="flex items-start gap-2">
						<AlertCircle class="w-4 h-4 text-destructive mt-0.5 shrink-0" />
						<span class="text-sm text-destructive break-all">{errorMessage}</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Output Log -->
		{#if outputLines.length > 0 || status === 'pushing'}
			<div class="flex-1 min-h-0 flex flex-col">
				<div class="flex items-center justify-between text-xs text-muted-foreground mb-2 shrink-0">
					<div class="flex items-center gap-2">
						<Terminal class="w-3.5 h-3.5" />
						<span>Output ({outputLines.length} lines)</span>
					</div>
					<button type="button" onclick={toggleLogTheme} class="p-1 rounded hover:bg-muted transition-colors cursor-pointer" title="Toggle log theme">
						{#if logDarkMode}
							<Sun class="w-3.5 h-3.5" />
						{:else}
							<Moon class="w-3.5 h-3.5" />
						{/if}
					</button>
				</div>
				<div
					bind:this={outputContainer}
					class="{logDarkMode ? 'bg-zinc-950 text-zinc-300' : 'bg-zinc-100 text-zinc-700'} rounded-lg p-3 font-mono text-xs flex-1 min-h-0 overflow-auto"
				>
					{#each outputLines as line}
						<div class="whitespace-pre-wrap break-all leading-relaxed flex items-start gap-1.5">
							{#if line.startsWith('[push]')}
								<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-blue-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">push</span>
								<span>{line.slice(7)}</span>
							{:else if line.startsWith('[layer')}
								<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-violet-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">layer</span>
								<span>{line.slice(line.indexOf(']') + 2)}</span>
							{:else if line.startsWith('[error]')}
								<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-red-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">error</span>
								<span class="text-red-400">{line.slice(8)}</span>
							{:else}
								<span>{line}</span>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}

	<!-- Idle state -->
	{#if status === 'idle'}
		<div class="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
			<Upload class="w-12 h-12 opacity-50" />
			<p class="text-sm">Ready to push to <code class="bg-muted px-1.5 py-0.5 rounded">{registryName}</code></p>
		</div>
	{/if}
</div>
