<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Download, CheckCircle2, XCircle, Loader2, AlertCircle, Shield } from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import { Progress } from '$lib/components/ui/progress';
	import { tick } from 'svelte';
	import ImageScanModal from './ImageScanModal.svelte';

	interface Props {
		imageName: string | (() => string);
		envHasScanning?: boolean;
		onComplete?: () => void;
		envId?: number | null;
		children: Snippet;
	}

	let { imageName, envHasScanning = false, onComplete, envId = null, children }: Props = $props();

	// Resolve image name (can be string or function)
	function getImageName(): string {
		return typeof imageName === 'function' ? imageName() : imageName;
	}

	let displayImageName = $state('');

	interface LayerProgress {
		id: string;
		status: string;
		progress?: string;
		current?: number;
		total?: number;
		order: number;
		isComplete: boolean;
	}

	let open = $state(false);
	let layers = $state<Map<string, LayerProgress>>(new Map());
	let overallStatus = $state<'idle' | 'pulling' | 'complete' | 'error'>('idle');
	let errorMessage = $state('');
	let statusMessage = $state('');
	let completedLayers = $state(0);
	let totalLayers = $state(0);
	let layerOrder = $state(0);
	let layersContainer: HTMLDivElement | undefined;

	// Scan modal state
	let showScanModal = $state(false);
	let scanImageName = $state('');

	function getProgressPercentage(layer: LayerProgress): number {
		if (!layer.current || !layer.total) return 0;
		return Math.round((layer.current / layer.total) * 100);
	}

	function getStatusColor(status: string): string {
		const statusLower = status.toLowerCase();
		if (statusLower.includes('complete') || statusLower.includes('already exists') || statusLower.includes('pull complete')) {
			return 'text-green-600 dark:text-green-400';
		}
		if (statusLower.includes('error') || statusLower.includes('failed')) {
			return 'text-red-600 dark:text-red-400';
		}
		if (statusLower.includes('extracting') || statusLower.includes('downloading')) {
			return 'text-blue-600 dark:text-blue-400';
		}
		return 'text-muted-foreground';
	}

	function getStatusIcon(status: string) {
		const statusLower = status.toLowerCase();
		if (statusLower.includes('complete') || statusLower.includes('already exists') || statusLower.includes('pull complete')) {
			return CheckCircle2;
		}
		if (statusLower.includes('error') || statusLower.includes('failed')) {
			return XCircle;
		}
		return Loader2;
	}

	function shouldSpin(status: string): boolean {
		const statusLower = status.toLowerCase();
		if (statusLower.includes('complete') || statusLower.includes('already exists') || statusLower.includes('pull complete')) {
			return false;
		}
		if (statusLower.includes('error') || statusLower.includes('failed')) {
			return false;
		}
		return true;
	}

	async function startPull() {
		layers = new Map();
		overallStatus = 'pulling';
		errorMessage = '';
		statusMessage = '';
		completedLayers = 0;
		totalLayers = 0;
		layerOrder = 0;
		displayImageName = getImageName();
		open = true;

		try {
			const pullUrl = envId ? `/api/images/pull?env=${envId}` : '/api/images/pull';
			const response = await fetch(pullUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: displayImageName })
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

						if (data.status === 'complete') {
							overallStatus = 'complete';
							onComplete?.();
							// Trigger scan if scanning is enabled
							if (envHasScanning) {
								// Close popover and open scan modal after short delay
								setTimeout(() => {
									scanImageName = displayImageName;
									open = false;
									showScanModal = true;
								}, 500);
							}
						} else if (data.status === 'error') {
							overallStatus = 'error';
							errorMessage = data.error || 'Unknown error occurred';
						} else if (data.id) {
							// Layer progress update - only process if id looks like a layer hash (12 hex chars)
							const isLayerId = /^[a-f0-9]{12}$/i.test(data.id);
							if (!isLayerId) {
								if (data.status) {
									statusMessage = `${data.id}: ${data.status}`;
								}
								continue;
							}

							const existing = layers.get(data.id);
							const statusLower = (data.status || '').toLowerCase();
							// Only count "Pull complete" or "Already exists" as truly complete
							const isFullyComplete = statusLower === 'pull complete' || statusLower === 'already exists';

							if (!existing) {
								totalLayers++;
								layerOrder++;
								if (isFullyComplete) {
									completedLayers++;
								}

								const layerProgress: LayerProgress = {
									id: data.id,
									status: data.status || 'Processing',
									progress: data.progress,
									current: data.progressDetail?.current,
									total: data.progressDetail?.total,
									order: layerOrder,
									isComplete: isFullyComplete
								};
								layers.set(data.id, layerProgress);
								layers = new Map(layers);
								scrollToBottom();
							} else {
								// Check if layer transitioned to complete (only count once)
								if (isFullyComplete && !existing.isComplete) {
									completedLayers++;
								}

								const layerProgress: LayerProgress = {
									id: data.id,
									status: data.status || 'Processing',
									progress: data.progress,
									current: data.progressDetail?.current,
									total: data.progressDetail?.total,
									order: existing.order,
									isComplete: existing.isComplete || isFullyComplete
								};
								layers.set(data.id, layerProgress);
								layers = new Map(layers);
							}
						} else if (data.status) {
							statusMessage = data.status;
						}
					} catch (e) {
						console.error('Failed to parse SSE data:', e);
					}
				}
			}
		} catch (error: any) {
			console.error('Failed to pull image:', error);
			overallStatus = 'error';
			errorMessage = error.message || 'Failed to pull image';
		}
	}

	function handleOpenChange(isOpen: boolean) {
		// Only allow closing when not pulling
		if (!isOpen && overallStatus === 'pulling') {
			return;
		}

		// Start pull when opening
		if (isOpen && !open && (overallStatus === 'idle' || overallStatus === 'complete' || overallStatus === 'error')) {
			startPull();
			return; // startPull sets open = true
		}

		open = isOpen;
		if (!isOpen) {
			// Reset state when closed
			overallStatus = 'idle';
			layers = new Map();
			completedLayers = 0;
			totalLayers = 0;
			layerOrder = 0;
			errorMessage = '';
			statusMessage = '';
		}
	}

	const sortedLayers = $derived(
		Array.from(layers.values()).sort((a, b) => a.order - b.order)
	);

	// Auto-scroll to bottom when layers change
	async function scrollToBottom() {
		await tick();
		if (layersContainer) {
			layersContainer.scrollTop = layersContainer.scrollHeight;
		}
	}
</script>

<Popover.Root {open} onOpenChange={handleOpenChange}>
	<Popover.Trigger asChild>
		{@render children()}
	</Popover.Trigger>
	<Popover.Content class="w-[28rem] p-0 overflow-hidden flex flex-col max-h-96 z-[200]" align="end" sideOffset={8}>
		<!-- Sticky Header -->
		<div class="p-3 border-b shrink-0 space-y-2">
			<div class="flex items-center gap-2 text-sm font-medium min-w-0">
				<Download class="w-4 h-4 shrink-0" />
				<span class="truncate">{displayImageName}</span>
			</div>

			<!-- Overall Progress -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					{#if overallStatus === 'idle'}
						<Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
						<span class="text-sm text-muted-foreground">Initializing...</span>
					{:else if overallStatus === 'pulling'}
						<Loader2 class="w-4 h-4 animate-spin text-blue-600" />
						<span class="text-sm">Pulling...</span>
					{:else if overallStatus === 'complete'}
						<CheckCircle2 class="w-4 h-4 text-green-600" />
						<span class="text-sm text-green-600">Complete!</span>
					{:else if overallStatus === 'error'}
						<XCircle class="w-4 h-4 text-red-600" />
						<span class="text-sm text-red-600">Failed</span>
					{/if}
				</div>
				{#if totalLayers > 0}
					<Badge variant="secondary" class="text-xs">
						{completedLayers}/{totalLayers}
					</Badge>
				{/if}
			</div>

			{#if statusMessage && (overallStatus === 'pulling' || overallStatus === 'complete')}
				<p class="text-xs text-muted-foreground truncate">{statusMessage}</p>
			{/if}

			{#if totalLayers > 0}
				<Progress value={(completedLayers / totalLayers) * 100} class="h-1.5" />
			{/if}

			{#if errorMessage}
				<div class="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
					<AlertCircle class="w-3 h-3 shrink-0 mt-0.5" />
					<span class="break-all">{errorMessage}</span>
				</div>
			{/if}
		</div>

		<!-- Scrollable Layer Progress List -->
		{#if sortedLayers.length > 0}
			<div class="flex-1 overflow-auto min-h-0 p-2" bind:this={layersContainer}>
				<div class="space-y-0.5">
					{#each sortedLayers as layer (layer.id)}
						{@const StatusIcon = getStatusIcon(layer.status)}
						{@const percentage = getProgressPercentage(layer)}
						{@const statusLower = layer.status.toLowerCase()}
						{@const isDownloading = statusLower.includes('downloading')}
						{@const isExtracting = statusLower.includes('extracting')}
						<div class="flex items-center gap-2 py-1 px-1 rounded text-xs hover:bg-muted/50">
							<StatusIcon
								class="w-3 h-3 shrink-0 {getStatusColor(layer.status)} {shouldSpin(layer.status) ? 'animate-spin' : ''}"
							/>
							<code class="w-20 shrink-0 font-mono text-2xs">{layer.id.slice(0, 12)}</code>
							<div class="flex-1 min-w-0">
								{#if (isDownloading || isExtracting) && layer.current && layer.total}
									<div class="flex items-center gap-1">
										<div class="flex-1 bg-muted rounded-full h-1">
											<div
												class="{isExtracting ? 'bg-amber-500' : 'bg-blue-500'} h-1 rounded-full transition-all duration-200"
												style="width: {percentage}%"
											></div>
										</div>
										<span class="text-2xs text-muted-foreground w-8 text-right shrink-0">{percentage}%</span>
									</div>
								{:else}
									<span class="text-2xs {getStatusColor(layer.status)} truncate block">
										{layer.status}
									</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else if overallStatus === 'complete'}
			<div class="p-3">
				<p class="text-xs text-muted-foreground text-center py-2">Image is up to date</p>
			</div>
		{/if}

		<!-- Sticky Footer -->
		{#if overallStatus === 'complete' || overallStatus === 'error'}
			<div class="p-2 border-t shrink-0">
				<Button
					variant="outline"
					size="sm"
					class="w-full"
					onclick={() => handleOpenChange(false)}
				>
					Close
				</Button>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>

<!-- Vulnerability Scan Modal -->
<ImageScanModal bind:open={showScanModal} imageName={scanImageName} {envId} />
