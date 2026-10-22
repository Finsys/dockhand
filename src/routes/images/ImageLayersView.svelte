<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Loader2, Layers, ChevronDown, ChevronRight } from 'lucide-svelte';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { formatDateTime } from '$lib/stores/settings';
	import { highlightCommand } from '$lib/utils/highlight-command';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		imageId: string;
		imageName?: string;
		visible?: boolean;
	}

	let { imageId, imageName, visible = true }: Props = $props();

	interface HistoryLayer {
		Id: string;
		Created: number;
		CreatedBy: string;
		Size: number;
		Comment: string;
		Tags: string[] | null;
	}

	let loading = $state(false);
	let error = $state('');
	let history = $state<HistoryLayer[]>([]);
	let expandedLayers = $state<Set<number>>(new Set());
	let lastFetchedId = $state<string | null>(null);

	// Calculate the maximum size for visualization scaling
	const maxLayerSize = $derived(
		history.length > 0 ? Math.max(...history.map(l => l.Size)) : 0
	);

	// Calculate total image size
	const totalSize = $derived(
		history.reduce((sum, layer) => sum + layer.Size, 0)
	);

	$effect(() => {
		if (visible && imageId && imageId !== lastFetchedId) {
			fetchHistory();
		}
	});

	async function fetchHistory() {
		loading = true;
		error = '';
		expandedLayers = new Set();
		try {
			const envId = $currentEnvironment?.id ?? null;
			// URL-encode the imageId to handle sha256:... format and image names with special characters
			const encodedId = encodeURIComponent(imageId);
			const response = await fetch(appendEnvParam(`/api/images/${encodedId}/history`, envId));
			if (!response.ok) {
				throw new Error(m.images_layers_error_fetch());
			}
			history = await response.json();
			lastFetchedId = imageId;
		} catch (err: any) {
			error = err.message || m.images_layers_error_load();
			console.error('Failed to fetch image history:', err);
		} finally {
			loading = false;
		}
	}

	function formatSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
	}

	function formatDate(timestamp: number): string {
		return formatDateTime(new Date(timestamp * 1000));
	}

	function getBarWidth(size: number): number {
		if (maxLayerSize === 0) return 0;
		// Minimum 15% width to show text, max 100%
		return Math.max(15, (size / maxLayerSize) * 100);
	}

	function getBarColor(index: number): string {
		// Create a gradient of colors from bottom to top
		const colors = [
			'bg-blue-500',
			'bg-cyan-500',
			'bg-teal-500',
			'bg-green-500',
			'bg-lime-500',
			'bg-yellow-500',
			'bg-orange-500',
			'bg-red-500',
			'bg-pink-500',
			'bg-purple-500',
			'bg-indigo-500',
		];
		return colors[index % colors.length];
	}

	function toggleLayer(layerNum: number) {
		const newSet = new Set(expandedLayers);
		if (newSet.has(layerNum)) {
			newSet.delete(layerNum);
		} else {
			newSet.add(layerNum);
		}
		expandedLayers = newSet;
	}

	function getShortCommand(cmd: string): string {
		if (!cmd) return m.images_layers_no_command();
		// Remove /bin/sh -c prefix
		cmd = cmd.replace(/^\/bin\/sh -c\s+/, '');
		// Take first meaningful part
		const parts = cmd.split(/\s+/);
		if (parts[0] === '#(nop)') {
			// Dockerfile instruction like ADD, COPY, etc - show just the instruction
			return parts[1] || parts[0];
		}
		// Regular command - show just the first word/command
		return parts[0];
	}

</script>

<div class="space-y-4">
	{#if loading && history.length === 0}
		<div class="flex items-center justify-center py-8 flex-1">
			<Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
		</div>
	{:else if error}
		<div class="text-sm text-red-600 dark:text-red-400 p-3 bg-red-50 dark:bg-red-950 rounded">
			{error}
		</div>
	{:else if history.length === 0}
		<p class="text-muted-foreground text-sm text-center py-8">{m.images_layers_none()}</p>
	{:else}
		<!-- Summary -->
		<div class="flex items-center justify-between p-3 bg-muted rounded-lg">
			<div>
				<p class="text-sm font-medium">{m.images_layers_total_layers()} <span class="text-primary">{history.length}</span></p>
				<p class="text-sm font-medium">{m.images_layers_total_size()} <span class="text-primary">{formatSize(totalSize)}</span></p>
			</div>
			<Badge variant="secondary">
				{imageId.startsWith('sha256:') ? imageId.slice(7, 19) : imageName || imageId}
			</Badge>
		</div>

		<!-- Layer Stack with Expandable Details -->
		<div class="space-y-1">
			<h3 class="text-sm font-semibold mb-2 pb-2 flex items-center gap-2">
				<Layers class="w-4 h-4" />
				{m.images_layers_stack_heading()}
			</h3>
			<div class="space-y-1">
				{#each history.slice().reverse() as layer, index}
					{@const layerNum = history.length - index}
					{@const barWidth = getBarWidth(layer.Size)}
					{@const barColor = getBarColor(history.length - index - 1)}
					{@const isExpanded = expandedLayers.has(layerNum)}
					<div class="border border-border rounded-lg overflow-hidden">
						<!-- Layer Bar (Clickable) -->
						<button
							type="button"
							onclick={() => toggleLayer(layerNum)}
							class="w-full flex items-center gap-2 p-2 hover:bg-muted/30 transition-colors"
						>
							<div class="flex items-center gap-2 flex-1">
								<!-- Expand Icon -->
								{#if isExpanded}
									<ChevronDown class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
								{:else}
									<ChevronRight class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
								{/if}

								<!-- Layer Number -->
								<div class="w-6 text-xs text-muted-foreground text-right font-mono shrink-0">#{layerNum}</div>

								<!-- Size Bar -->
								<div class="flex-1 h-6 bg-muted rounded-sm overflow-hidden relative">
									<div
										class="{barColor} h-full transition-all duration-300 flex items-center px-2 gap-2"
										style="width: {barWidth}%"
									>
										<span class="text-xs text-white font-semibold shrink-0 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
											{layer.Size > 0 ? formatSize(layer.Size) : '0 B'}
										</span>
										<span class="text-xs text-white truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
											{getShortCommand(layer.CreatedBy)}
										</span>
									</div>
								</div>

								<!-- Size -->
								<div class="w-20 text-xs text-muted-foreground text-right shrink-0">
									{formatSize(layer.Size)}
								</div>

								<!-- Size Badge -->
								<Badge variant={layer.Size > 1024 * 1024 * 100 ? 'destructive' : 'secondary'} class="text-xs shrink-0">
									{layer.Size > 1024 * 1024 * 100 ? m.images_layers_size_large() : m.images_layers_size_normal()}
								</Badge>
							</div>
						</button>

						<!-- Expanded Details -->
						{#if isExpanded}
							<div class="px-4 pb-3 space-y-3 border-t border-border bg-muted/20">
								<div class="grid grid-cols-2 gap-2 pt-3 text-sm">
									<div>
										<p class="text-xs text-muted-foreground">{m.images_layers_created()}</p>
										<p class="text-xs">{formatDate(layer.Created)}</p>
									</div>
									<div>
										<p class="text-xs text-muted-foreground">{m.images_layers_size()}</p>
										<p class="text-xs font-mono">{formatSize(layer.Size)}</p>
									</div>
								</div>

								{#if layer.CreatedBy}
									<div class="space-y-1">
										<p class="text-xs font-medium text-muted-foreground">{m.images_layers_command()}</p>
										<code class="block text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
											{@html highlightCommand(layer.CreatedBy)}
										</code>
									</div>
								{/if}

								{#if layer.Comment}
									<div class="space-y-1">
										<p class="text-xs font-medium text-muted-foreground">{m.images_layers_comment()}</p>
										<p class="text-xs">{layer.Comment}</p>
									</div>
								{/if}

								{#if layer.Tags && layer.Tags.length > 0}
									<div class="space-y-1">
										<p class="text-xs font-medium text-muted-foreground">{m.images_layers_tags()}</p>
										<div class="flex flex-wrap gap-1">
											{#each layer.Tags as tag}
												<Badge variant="outline" class="text-xs">{tag}</Badge>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
