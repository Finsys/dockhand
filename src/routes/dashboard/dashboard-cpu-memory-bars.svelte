<script lang="ts">
	import { Cpu, MemoryStick, Loader2 } from 'lucide-svelte';
	import { formatBytes } from '$lib/utils/format';

	interface Metrics {
		cpuPercent?: number;
		memoryPercent?: number;
		memoryUsed?: number;
	}

	interface Props {
		metrics?: Metrics;
		compact?: boolean;
		showMemoryUsed?: boolean;
		collectMetrics?: boolean;
		loading?: boolean;
	}

	let { metrics, compact = false, showMemoryUsed = true, collectMetrics = true, loading = false }: Props = $props();

	// Safe accessors with defaults - clamp to valid ranges
	const cpuPercent = $derived(Math.max(0, Math.min(100, metrics?.cpuPercent ?? 0)) || 0);
	const memoryPercent = $derived(Math.max(0, Math.min(100, metrics?.memoryPercent ?? 0)) || 0);
	const memoryUsed = $derived(Math.max(0, metrics?.memoryUsed ?? 0) || 0);
	const hasMetrics = $derived(
		metrics &&
		(Number.isFinite(metrics.cpuPercent) || Number.isFinite(metrics.memoryPercent))
	);

	// Only show skeleton if loading AND we don't have metrics yet
	const showSkeleton = $derived(loading && !hasMetrics);

	function getProgressColor(percent: number): string {
		if (percent >= 90) return 'bg-red-500';
		if (percent >= 70) return 'bg-amber-500';
		return 'bg-emerald-500';
	}
</script>

{#if showSkeleton}
	<!-- Skeleton loading state -->
	{#if compact}
		<div class="flex items-center gap-3">
			<div class="flex items-center gap-1.5 flex-1">
				<Cpu class="w-3 h-3 text-muted-foreground/50 shrink-0" />
				<div class="h-1.5 bg-muted rounded-full overflow-hidden flex-1">
					<div class="skeleton h-full w-1/2 rounded-full"></div>
				</div>
				<div class="skeleton w-8 h-3 rounded"></div>
			</div>
			<div class="flex items-center gap-1.5 flex-1">
				<MemoryStick class="w-3 h-3 text-muted-foreground/50 shrink-0" />
				<div class="h-1.5 bg-muted rounded-full overflow-hidden flex-1">
					<div class="skeleton h-full w-2/3 rounded-full"></div>
				</div>
				<div class="skeleton w-8 h-3 rounded"></div>
			</div>
		</div>
	{:else}
		<div class="space-y-2 pt-1 border-t border-border/50">
			<div class="space-y-1">
				<div class="flex items-center justify-between text-xs">
					<span class="flex items-center gap-1 text-muted-foreground/50">
						<Cpu class="w-3 h-3" /> CPU <Loader2 class="w-3 h-3 animate-spin" />
					</span>
					<div class="skeleton w-10 h-3.5 rounded"></div>
				</div>
				<div class="h-1.5 bg-muted rounded-full overflow-hidden">
					<div class="skeleton h-full w-1/3 rounded-full"></div>
				</div>
			</div>
			<div class="space-y-1">
				<div class="flex items-center justify-between text-xs">
					<span class="flex items-center gap-1 text-muted-foreground/50">
						<MemoryStick class="w-3 h-3" /> Memory <Loader2 class="w-3 h-3 animate-spin" />
					</span>
					<div class="skeleton w-16 h-3.5 rounded"></div>
				</div>
				<div class="h-1.5 bg-muted rounded-full overflow-hidden">
					<div class="skeleton h-full w-1/2 rounded-full"></div>
				</div>
			</div>
		</div>
	{/if}
{:else if !collectMetrics}
	<!-- Metrics collection disabled -->
	<div class="text-xs text-muted-foreground text-center py-1">
		Metrics collection disabled
	</div>
{:else if !hasMetrics}
	<!-- No metrics available -->
	<div class="text-xs text-muted-foreground text-center py-1">
		No metrics available
	</div>
{:else if compact}
	<!-- Compact horizontal bars for mini tiles -->
	<div class="flex items-center gap-3">
		<div class="flex items-center gap-1.5 flex-1">
			<Cpu class="w-3 h-3 text-muted-foreground shrink-0" />
			<div class="h-1.5 bg-muted rounded-full overflow-hidden flex-1">
				<div
					class="h-full rounded-full transition-all {getProgressColor(cpuPercent)}"
					style="width: {Math.min(cpuPercent, 100)}%"
				></div>
			</div>
			<span class="text-2xs font-medium w-8 text-right">{cpuPercent.toFixed(0)}%</span>
		</div>
		<div class="flex items-center gap-1.5 flex-1">
			<MemoryStick class="w-3 h-3 text-muted-foreground shrink-0" />
			<div class="h-1.5 bg-muted rounded-full overflow-hidden flex-1">
				<div
					class="h-full rounded-full transition-all {getProgressColor(memoryPercent)}"
					style="width: {Math.min(memoryPercent, 100)}%"
				></div>
			</div>
			<span class="text-2xs font-medium w-8 text-right">{memoryPercent.toFixed(0)}%</span>
		</div>
	</div>
{:else}
	<!-- Full stacked bars for standard tiles -->
	<div class="space-y-2 pt-1 border-t border-border/50">
		<div class="space-y-1">
			<div class="flex items-center justify-between text-xs">
				<span class="flex items-center gap-1 text-muted-foreground">
					<Cpu class="w-3 h-3" /> CPU
				</span>
				<span class="font-medium">{cpuPercent.toFixed(1)}%</span>
			</div>
			<div class="h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					class="h-full rounded-full transition-all {getProgressColor(cpuPercent)}"
					style="width: {Math.min(cpuPercent, 100)}%"
				></div>
			</div>
		</div>
		<div class="space-y-1">
			<div class="flex items-center justify-between text-xs">
				<span class="flex items-center gap-1 text-muted-foreground">
					<MemoryStick class="w-3 h-3" /> Memory
				</span>
				<span class="font-medium">
					{memoryPercent.toFixed(1)}%
					{#if showMemoryUsed}
						<span class="text-muted-foreground">({formatBytes(memoryUsed)})</span>
					{/if}
				</span>
			</div>
			<div class="h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					class="h-full rounded-full transition-all {getProgressColor(memoryPercent)}"
					style="width: {Math.min(memoryPercent, 100)}%"
				></div>
			</div>
		</div>
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
