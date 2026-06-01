<script lang="ts">
	import { Cpu } from 'lucide-svelte';
	import { formatBytes } from '$lib/utils/format';
	import { Chart, Svg, Area } from 'layerchart';
	import { scaleTime } from 'd3-scale';

	interface MetricsHistory {
		cpu_percent: number;
		memory_percent: number;
		timestamp: string;
	}

	interface Metrics {
		cpuPercent?: number;
		memoryPercent?: number;
		memoryUsed?: number;
	}

	interface Props {
		metricsHistory?: MetricsHistory[];
		metrics?: Metrics;
	}

	let { metricsHistory, metrics }: Props = $props();

	// Safe accessors with defaults - clamp to valid ranges
	const cpuPercent = $derived(Math.max(0, Math.min(100, metrics?.cpuPercent ?? 0)) || 0);
	const memoryPercent = $derived(Math.max(0, Math.min(100, metrics?.memoryPercent ?? 0)) || 0);
	const memoryUsed = $derived(Math.max(0, metrics?.memoryUsed ?? 0) || 0);
	const hasMetrics = $derived(
		metrics &&
		(Number.isFinite(metrics.cpuPercent) || Number.isFinite(metrics.memoryPercent))
	);

	function getProgressColor(percent: number): string {
		if (percent >= 90) return 'bg-red-500';
		if (percent >= 70) return 'bg-amber-500';
		return 'bg-emerald-500';
	}

	const cpuChartData = $derived(
		metricsHistory?.map(m => ({
			date: new Date(m.timestamp),
			value: m.cpu_percent
		})) ?? []
	);

	const memoryChartData = $derived(
		metricsHistory?.map(m => ({
			date: new Date(m.timestamp),
			value: m.memory_percent
		})) ?? []
	);

	const hasHistory = $derived(metricsHistory && metricsHistory.length > 1);
</script>

{#if !hasMetrics}
	<!-- No metrics available -->
	<div class="pt-2 border-t border-border/50">
		<div class="text-xs text-muted-foreground text-center py-1">
			No metrics available
		</div>
	</div>
{:else}
	<div class="pt-2 border-t border-border/50">
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
			<Cpu class="w-3 h-3" />
			<span class="font-medium">CPU & Memory history</span>
		</div>

		<!-- CPU chart -->
		<div class="mb-3">
			<div class="flex items-center justify-between text-xs mb-1">
				<span class="text-muted-foreground">CPU</span>
				<span class="font-medium">{cpuPercent.toFixed(1)}%</span>
			</div>
			{#if hasHistory}
				<div class="h-12 w-full">
					<Chart
						data={cpuChartData}
						x="date"
						xScale={scaleTime()}
						y="value"
						yDomain={[0, 100]}
						padding={{ left: 0, right: 0, top: 2, bottom: 2 }}
					>
						<Svg>
							<Area line={{ class: 'stroke stroke-emerald-500' }} class="fill-emerald-500/30" />
						</Svg>
					</Chart>
				</div>
			{:else}
				<div class="h-3 bg-muted rounded-full overflow-hidden">
					<div
						class="h-full rounded-full transition-all {getProgressColor(cpuPercent)}"
						style="width: {Math.min(cpuPercent, 100)}%"
					></div>
				</div>
			{/if}
		</div>

		<!-- Memory chart -->
		<div class="mb-3">
			<div class="flex items-center justify-between text-xs mb-1">
				<span class="text-muted-foreground">Memory</span>
				<span class="font-medium">{memoryPercent.toFixed(1)}% ({formatBytes(memoryUsed)})</span>
			</div>
			{#if hasHistory}
				<div class="h-12 w-full">
					<Chart
						data={memoryChartData}
						x="date"
						xScale={scaleTime()}
						y="value"
						yDomain={[0, 100]}
						padding={{ left: 0, right: 0, top: 2, bottom: 2 }}
					>
						<Svg>
							<Area line={{ class: 'stroke stroke-blue-500' }} class="fill-blue-500/30" />
						</Svg>
					</Chart>
				</div>
			{:else}
				<div class="h-3 bg-muted rounded-full overflow-hidden">
					<div
						class="h-full rounded-full transition-all {getProgressColor(memoryPercent)}"
						style="width: {Math.min(memoryPercent, 100)}%"
					></div>
				</div>
			{/if}
		</div>
	</div>
{/if}
