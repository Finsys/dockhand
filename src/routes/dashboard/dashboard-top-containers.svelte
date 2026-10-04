<script lang="ts">
	import { Box, Cpu, MemoryStick, Loader2 } from 'lucide-svelte';

	interface Container {
		name: string;
		displayName?: string;
		cpuPercent: number;
		memoryPercent: number;
	}

	interface Props {
		containers: Container[];
		limit?: number;
		loading?: boolean;
	}

	let { containers, limit = 5, loading = false }: Props = $props();

	// Only show skeleton if loading AND we don't have data yet
	const showSkeleton = $derived(loading && (!containers || containers.length === 0));
</script>

{#if showSkeleton}
	<div class="pt-2 border-t border-border/50">
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
			<Box class="w-3 h-3" />
			<span class="font-medium">Top containers by CPU</span>
			<Loader2 class="w-3 h-3 animate-spin" />
		</div>
		<!-- Skeleton rows -->
		<div class="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1.5 text-xs items-center">
			{#each Array(Math.min(limit, 5)) as _, i}
				<div class="skeleton h-3.5 rounded" style="width: {70 - i * 10}%"></div>
				<div class="flex items-center gap-0.5">
					<Cpu class="w-3 h-3 text-muted-foreground/50 shrink-0" />
					<div class="skeleton w-8 h-3.5 rounded"></div>
				</div>
				<div class="flex items-center gap-0.5">
					<MemoryStick class="w-3 h-3 text-muted-foreground/50 shrink-0" />
					<div class="skeleton w-8 h-3.5 rounded"></div>
				</div>
			{/each}
		</div>
	</div>
{:else if containers && containers.length > 0}
	<div class="pt-2 border-t border-border/50">
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
			<Box class="w-3 h-3" />
			<span class="font-medium">Top containers by CPU</span>
		</div>
		<!-- Grid layout with fixed columns: container name, CPU, Memory -->
		<div class="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1.5 text-xs items-center">
			{#each containers.slice(0, limit) as container}
				<!-- Container name -->
				<span class="truncate text-foreground" title={container.name}>
					{container.displayName ?? container.name}
				</span>
				<!-- CPU -->
				<span class="flex items-center gap-0.5 text-muted-foreground whitespace-nowrap" title="CPU">
					<Cpu class="w-3 h-3 shrink-0" />
					<span class="tabular-nums">{container.cpuPercent.toFixed(1)}%</span>
				</span>
				<!-- Memory -->
				<span class="flex items-center gap-0.5 text-muted-foreground whitespace-nowrap" title="Memory">
					<MemoryStick class="w-3 h-3 shrink-0" />
					<span class="tabular-nums">{container.memoryPercent.toFixed(1)}%</span>
				</span>
			{/each}
		</div>
	</div>
{:else}
	<div class="text-xs text-muted-foreground">
		No running containers
	</div>
{/if}

<style>
	@keyframes shimmer {
		0% { background-position: -200% 0; }
		100% { background-position: 200% 0; }
	}
	.skeleton {
		background: linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--muted-foreground) / 0.1) 50%, hsl(var(--muted)) 75%);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}
</style>
