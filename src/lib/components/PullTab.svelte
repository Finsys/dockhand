<script lang="ts">
	import { tick } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Progress } from '$lib/components/ui/progress';
	import { CheckCircle2, XCircle, Loader2, AlertCircle, Terminal, Sun, Moon, Download } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { appendEnvParam } from '$lib/stores/environment';

	interface LayerProgress {
		id: string;
		status: string;
		progress?: string;
		current?: number;
		total?: number;
		order: number;
		isComplete: boolean;
	}

	type PullStatus = 'idle' | 'pulling' | 'complete' | 'error';

	interface Props {
		imageName?: string;
		envId?: number | null;
		autoStart?: boolean;
		showImageInput?: boolean;
		onComplete?: () => void;
		onError?: (error: string) => void;
		onStatusChange?: (status: PullStatus) => void;
		onImageChange?: (image: string) => void;
	}

	let {
		imageName: initialImageName = '',
		envId = null,
		autoStart = false,
		showImageInput = true,
		onComplete,
		onError,
		onStatusChange,
		onImageChange
	}: Props = $props();

	let status = $state<PullStatus>('idle');
	let image = $state(initialImageName);
	let duration = $state(0);
	// Track whether image was set from initial prop vs typed by user
	let hasAutoStarted = $state(false);

	// Notify parent of status changes
	$effect(() => {
		onStatusChange?.(status);
	});

	let layersMap = $state<Record<string, LayerProgress>>({});
	let hasLayers = $state(false);
	let errorMessage = $state('');
	let statusMessage = $state('');
	let completedLayers = $state(0);
	let totalLayers = $state(0);
	let layerOrder = $state(0);
	let outputLines = $state<string[]>([]);
	let outputContainer: HTMLDivElement | undefined;
	let logDarkMode = $state(true);
	let startTime = $state(0);

	onMount(() => {
		const saved = localStorage.getItem('logTheme');
		if (saved !== null) {
			logDarkMode = saved === 'dark';
		}
	});

	$effect(() => {
		if (initialImageName) {
			image = initialImageName;
		}
	});

	// Notify parent when image changes
	$effect(() => {
		onImageChange?.(image);
	});

	// Auto-start only once for prefilled images, not when user is typing
	$effect(() => {
		if (autoStart && initialImageName && image === initialImageName && status === 'idle' && !hasAutoStarted) {
			hasAutoStarted = true;
			startPull();
		}
	});

	function toggleLogTheme() {
		logDarkMode = !logDarkMode;
		localStorage.setItem('logTheme', logDarkMode ? 'dark' : 'light');
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function getProgressPercentage(layer: LayerProgress): number {
		if (!layer.current || !layer.total) return 0;
		return Math.round((layer.current / layer.total) * 100);
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
		image = initialImageName;
		layersMap = {};
		hasLayers = false;
		errorMessage = '';
		statusMessage = '';
		completedLayers = 0;
		totalLayers = 0;
		layerOrder = 0;
		outputLines = [];
		duration = 0;
		hasAutoStarted = false;
	}

	export function getImage() {
		return image;
	}

	export function getStatus() {
		return status;
	}

	export async function startPull() {
		if (!image.trim()) return;

		reset();
		status = 'pulling';
		startTime = Date.now();

		addOutputLine(`[pull] Starting pull for ${image}`);

		try {
			const response = await fetch(appendEnvParam('/api/images/pull', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: image.trim(), scanAfterPull: false })
			});

			if (!response.ok) {
				throw new Error('Failed to start pull');
			}

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('No response body');
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim() || !line.startsWith('data: ')) continue;

					try {
						const data = JSON.parse(line.slice(6));
						handlePullProgress(data);
					} catch (e) {
						// Ignore parse errors
					}
				}
			}

			if (status === 'pulling') {
				duration = Date.now() - startTime;
				status = 'complete';
				addOutputLine(`[pull] Pull completed in ${formatDuration(duration)}`);
				onComplete?.();
			}
		} catch (error: any) {
			duration = Date.now() - startTime;
			status = 'error';
			errorMessage = error.message || 'Failed to pull image';
			addOutputLine(`[error] ${errorMessage}`);
			onError?.(errorMessage);
		}
	}

	function handlePullProgress(data: any) {
		// Filter out scan-related events (handled by ScanTab)
		if (data.status === 'scanning' || data.status === 'scan-progress' || data.status === 'scan-complete' || data.status === 'scan-error') {
			return;
		}

		if (data.status === 'complete') {
			duration = Date.now() - startTime;
			status = 'complete';
			addOutputLine(`[pull] Pull completed in ${formatDuration(duration)}`);
			onComplete?.();
		} else if (data.status === 'error') {
			duration = Date.now() - startTime;
			status = 'error';
			errorMessage = data.error || 'Unknown error occurred';
			addOutputLine(`[error] ${errorMessage}`);
			onError?.(errorMessage);
		} else if (data.id) {
			// Layer progress update
			const isLayerId = /^[a-f0-9]{12}$/i.test(data.id);
			if (!isLayerId) {
				if (data.status) {
					statusMessage = `${data.id}: ${data.status}`;
					addOutputLine(`[pull] ${data.id}: ${data.status}`);
				}
				return;
			}

			const existing = layersMap[data.id];
			const statusLower = (data.status || '').toLowerCase();
			const isFullyComplete = statusLower === 'pull complete' || statusLower === 'already exists';

			if (!existing) {
				totalLayers++;
				layerOrder++;
				hasLayers = true;
				if (isFullyComplete) {
					completedLayers++;
				}

				// Use spread to ensure reactivity in Svelte 5
				layersMap = {
					...layersMap,
					[data.id]: {
						id: data.id,
						status: data.status || 'Processing',
						progress: data.progress,
						current: data.progressDetail?.current,
						total: data.progressDetail?.total,
						order: layerOrder,
						isComplete: isFullyComplete
					}
				};

				if (isFullyComplete) {
					addOutputLine(`[layer] ${data.id.slice(0, 12)}: ${data.status}`);
				}
			} else {
				if (isFullyComplete && !existing.isComplete) {
					completedLayers++;
					addOutputLine(`[layer] ${data.id.slice(0, 12)}: ${data.status}`);
				}

				// Use spread to ensure reactivity in Svelte 5
				layersMap = {
					...layersMap,
					[data.id]: {
						id: data.id,
						status: data.status || 'Processing',
						progress: data.progress,
						current: data.progressDetail?.current,
						total: data.progressDetail?.total,
						order: existing.order,
						isComplete: existing.isComplete || isFullyComplete
					}
				};
			}
		} else if (data.status) {
			statusMessage = data.status;
			addOutputLine(`[pull] ${data.status}`);
		}
	}

	const sortedLayers = $derived(
		Object.values(layersMap).sort((a, b) => a.order - b.order)
	);

	const overallProgress = $derived(
		totalLayers > 0 ? (completedLayers / totalLayers) * 100 : 0
	);

	const downloadStats = $derived.by(() => {
		let totalBytes = 0;
		let downloadedBytes = 0;
		for (const layer of Object.values(layersMap)) {
			if (layer.total) {
				totalBytes += layer.total;
				downloadedBytes += layer.current || 0;
			}
		}
		return { totalBytes, downloadedBytes };
	});

	const isPulling = $derived(status === 'pulling');
</script>

<div class="flex flex-col gap-4 flex-1 min-h-0">
	<!-- Image Input -->
	{#if showImageInput}
		<div class="space-y-2 shrink-0">
			<Label for="pull-image" class="text-sm font-medium">Image name</Label>
			<div class="flex gap-2">
				<Input
					id="pull-image"
					bind:value={image}
					placeholder="nginx:latest, ubuntu:22.04, postgres:16"
					class="flex-1 h-10"
					disabled={isPulling}
				/>
				<Button
					onclick={startPull}
					disabled={isPulling || !image.trim()}
					class="h-10"
				>
					{#if isPulling}
						<Loader2 class="w-4 h-4 mr-2 animate-spin" />
						Pulling...
					{:else}
						<Download class="w-4 h-4" />
						Pull
					{/if}
				</Button>
			</div>
		</div>
	{/if}

	<!-- Progress Section -->
	{#if status !== 'idle'}
		<div class="space-y-2 shrink-0">
			<!-- Status -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					{#if status === 'pulling'}
						<Loader2 class="w-4 h-4 animate-spin text-blue-600" />
						<span class="text-sm">Pulling layers...</span>
					{:else if status === 'complete'}
						<CheckCircle2 class="w-4 h-4 text-green-600" />
						<span class="text-sm text-green-600">Pull completed!</span>
					{:else if status === 'error'}
						<XCircle class="w-4 h-4 text-red-600" />
						<span class="text-sm text-red-600">Failed</span>
					{/if}
				</div>
				<div class="flex items-center gap-3">
					{#if status === 'pulling' || status === 'complete'}
						<Badge variant="secondary" class="text-xs min-w-20 text-center">
							{#if totalLayers > 0}
								{completedLayers} / {totalLayers} layers
							{:else}
								...
							{/if}
						</Badge>
					{/if}
					<span class="text-xs text-muted-foreground min-w-12">
						{#if duration > 0}{formatDuration(duration)}{/if}
					</span>
				</div>
			</div>

			<!-- Progress Bar and Download Stats -->
			{#if status === 'pulling'}
				<div class="space-y-2">
					<Progress value={overallProgress} class="h-2" />
					<div class="text-xs text-muted-foreground h-4">
						{#if downloadStats.totalBytes > 0}
							Downloaded: {formatBytes(downloadStats.downloadedBytes)} / {formatBytes(downloadStats.totalBytes)}
						{/if}
					</div>
				</div>
			{/if}

			<!-- Error Message -->
			{#if errorMessage}
				<div class="p-3 rounded-lg bg-destructive/10 border border-destructive/30">
					<div class="flex items-start gap-2">
						<AlertCircle class="w-4 h-4 text-destructive mt-0.5 shrink-0" />
						<span class="text-sm text-destructive break-all">{errorMessage}</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Layer Progress Grid -->
		{#if status === 'pulling' || status === 'complete' || hasLayers}
			<div class="shrink-0 border rounded-lg h-36 overflow-auto">
				<table class="w-full text-xs">
					<thead class="bg-muted sticky top-0">
						<tr>
							<th class="text-left py-1.5 px-3 font-medium w-28">Layer ID</th>
							<th class="text-left py-1.5 px-3 font-medium">Status</th>
							<th class="text-right py-1.5 px-3 font-medium w-24">Progress</th>
						</tr>
					</thead>
					<tbody>
						{#each sortedLayers as layer (layer.id)}
							{@const percentage = getProgressPercentage(layer)}
							{@const statusLower = layer.status.toLowerCase()}
							{@const isComplete = statusLower.includes('complete') || statusLower.includes('already exists')}
							{@const isDownloading = statusLower.includes('downloading')}
							{@const isExtracting = statusLower.includes('extracting')}
							<tr class="border-t border-muted hover:bg-muted/30 transition-colors">
								<td class="py-1.5 px-3">
									<code class="font-mono text-2xs">{layer.id.slice(0, 12)}</code>
								</td>
								<td class="py-1.5 px-3">
									<div class="flex items-center gap-2">
										{#if isComplete}
											<CheckCircle2 class="w-3 h-3 text-green-500 shrink-0" />
										{:else if isDownloading || isExtracting}
											<Loader2 class="w-3 h-3 text-blue-500 animate-spin shrink-0" />
										{:else}
											<Loader2 class="w-3 h-3 text-muted-foreground animate-spin shrink-0" />
										{/if}
										<span class={isComplete ? 'text-green-600' : isDownloading ? 'text-blue-600' : isExtracting ? 'text-amber-600' : 'text-muted-foreground'}>
											{layer.status}
										</span>
									</div>
								</td>
								<td class="py-1.5 px-3 text-right">
									{#if (isDownloading || isExtracting) && layer.current && layer.total}
										<div class="flex items-center gap-2 justify-end">
											<div class="w-16 bg-muted rounded-full h-1.5">
												<div
													class="{isExtracting ? 'bg-amber-500' : 'bg-blue-500'} h-1.5 rounded-full transition-all duration-200"
													style="width: {percentage}%"
												></div>
											</div>
											<span class="text-muted-foreground w-8">{percentage}%</span>
										</div>
									{:else if isComplete}
										<span class="text-green-600">Done</span>
									{:else}
										<span class="text-muted-foreground">-</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<!-- Output Log -->
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
						{#if line.startsWith('[pull]')}
							<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-blue-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">pull</span>
							<span>{line.slice(7)}</span>
						{:else if line.startsWith('[layer]')}
							<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-green-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">layer</span>
							<span>{line.slice(8)}</span>
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

	<!-- Idle state -->
	{#if status === 'idle' && !showImageInput}
		<div class="flex-1 flex items-center justify-center text-muted-foreground">
			<p class="text-sm">Enter an image name to start pulling</p>
		</div>
	{/if}
</div>
