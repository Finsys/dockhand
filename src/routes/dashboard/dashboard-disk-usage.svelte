<script lang="ts">
	import { HardDrive, Image, Database, Box, Hammer, Loader2 } from 'lucide-svelte';
	import { formatBytes } from '$lib/utils/format';
	import { Chart, Svg, Pie, Arc } from 'layerchart';
	import { diskSegmentPath, type DiskSegmentKey } from '$lib/utils/disk-segment-path';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		imagesSize: number;
		volumesSize: number;
		containersSize?: number;
		buildCacheSize?: number;
		withBorder?: boolean;
		showPieChart?: boolean;
		loading?: boolean;
		onsegmentclick?: (key: DiskSegmentKey) => void;
	}

	let { imagesSize, volumesSize, containersSize = 0, buildCacheSize = 0, withBorder = true, showPieChart = false, loading = false, onsegmentclick }: Props = $props();

	// Segments without a route (build cache) fall through to the tile click.
	function isLinked(key: DiskSegmentKey): boolean {
		return !!onsegmentclick && diskSegmentPath(key) !== null;
	}

	function handleSegmentClick(e: MouseEvent, key: DiskSegmentKey) {
		if (!isLinked(key)) return;
		e.stopPropagation();
		onsegmentclick?.(key);
	}

	// DraggableGrid treats pointerdown/up as a tile click, so stop it here too.
	function handleSegmentPointerDown(e: PointerEvent, key: DiskSegmentKey) {
		if (isLinked(key)) e.stopPropagation();
	}

	const totalSize = $derived(imagesSize + volumesSize + containersSize + buildCacheSize);

	// Only show skeleton if loading AND we don't have data yet
	const showSkeleton = $derived(loading && totalSize === 0);

	// Count how many categories have data for grid layout
	const categoryCount = $derived(
		[imagesSize, volumesSize, containersSize, buildCacheSize].filter(v => v > 0).length
	);

	// Pie chart data - only include non-zero values
	const pieData = $derived(
		([
			{ key: 'images', label: m.nav_images(), value: imagesSize, color: '#0ea5e9' },
			{ key: 'containers', label: m.nav_containers(), value: containersSize, color: '#10b981' },
			{ key: 'volumes', label: m.nav_volumes(), value: volumesSize, color: '#f59e0b' },
			{ key: 'buildCache', label: m.dashboard_disk_build_cache(), value: buildCacheSize, color: '#8b5cf6' }
		] satisfies { key: DiskSegmentKey; label: string; value: number; color: string }[]).filter(d => d.value > 0)
	);

	function getPercentage(value: number): number {
		if (totalSize === 0) return 0;
		return (value / totalSize) * 100;
	}
</script>

{#if showSkeleton}
	<div class="{withBorder ? 'pt-2 border-t border-border/50' : ''}">
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
			<HardDrive class="w-3 h-3" />
			<span class="font-medium">{m.dashboard_disk_usage()}</span>
			<Loader2 class="w-3 h-3 animate-spin" />
			<div class="skeleton w-12 h-3.5 rounded ml-auto"></div>
		</div>
		<div class="h-2 rounded-full overflow-hidden flex bg-muted mb-2">
			<div class="skeleton h-full w-1/4 rounded-full"></div>
			<div class="skeleton h-full w-1/6 rounded-full ml-0.5"></div>
			<div class="skeleton h-full w-1/5 rounded-full ml-0.5"></div>
		</div>
		<div class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
			<div class="flex items-center gap-1.5">
				<div class="w-2 h-2 rounded-full bg-muted shrink-0"></div>
				<Image class="w-3 h-3 text-muted-foreground/50 shrink-0" />
				<span class="text-muted-foreground/50">{m.nav_images()}</span>
				<div class="skeleton w-10 h-3 rounded ml-auto"></div>
			</div>
			<div class="flex items-center gap-1.5">
				<div class="w-2 h-2 rounded-full bg-muted shrink-0"></div>
				<Database class="w-3 h-3 text-muted-foreground/50 shrink-0" />
				<span class="text-muted-foreground/50">{m.nav_volumes()}</span>
				<div class="skeleton w-10 h-3 rounded ml-auto"></div>
			</div>
		</div>
	</div>
{:else if totalSize > 0}
	<div class="{withBorder ? 'pt-2 border-t border-border/50' : ''}">
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
			<HardDrive class="w-3 h-3" />
			<span class="font-medium">{m.dashboard_disk_usage()}</span>
			<span class="ml-auto font-medium text-foreground">{formatBytes(totalSize)}</span>
		</div>

		{#if showPieChart && pieData.length > 0}
			<!-- Pie chart visualization -->
			<div class="flex items-center gap-4 mb-2">
				<div class="w-24 h-24 shrink-0">
					<Chart
						data={pieData}
						x="value"
						y="key"
					>
						<Svg center>
							<Pie
								innerRadius={0.5}
								padAngle={0.02}
								cornerRadius={2}
							>
								{#snippet children({ arcs })}
									{#each arcs as arc}
										<Arc
											startAngle={arc.startAngle}
											endAngle={arc.endAngle}
											innerRadius={0.5}
											padAngle={0.02}
											cornerRadius={2}
											fill={arc.data.color}
											class="transition-opacity hover:opacity-80 {isLinked(arc.data.key) ? 'cursor-pointer' : ''}"
											onclick={(e: MouseEvent) => handleSegmentClick(e, arc.data.key)}
											onpointerdown={(e: PointerEvent) => handleSegmentPointerDown(e, arc.data.key)}
										/>
									{/each}
								{/snippet}
							</Pie>
						</Svg>
					</Chart>
				</div>

				<!-- Legend with values (vertical) -->
				<div class="flex flex-col gap-1.5 text-xs flex-1">
					{#each pieData as item}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<div
							class="flex items-center gap-1.5 {isLinked(item.key) ? 'cursor-pointer hover:bg-muted/50 -mx-1 px-1 rounded transition-colors' : ''}"
							onclick={(e) => handleSegmentClick(e, item.key)}
							onpointerdown={(e) => handleSegmentPointerDown(e, item.key)}
						>
							<div class="w-2 h-2 rounded-full shrink-0" style="background-color: {item.color}"></div>
							<span class="text-muted-foreground truncate">{item.label}</span>
							<span class="ml-auto font-medium tabular-nums">{formatBytes(item.value)}</span>
						</div>
					{/each}
				</div>
			</div>
		{:else}
			<!-- Stacked bar showing proportions -->
			<div class="h-2 rounded-full overflow-hidden flex bg-muted mb-2">
			{#if imagesSize > 0}
				<div
					class="bg-sky-500 h-full transition-all duration-300"
					style="width: {getPercentage(imagesSize)}%"
					title={m.dashboard_disk_images_title({ size: formatBytes(imagesSize) })}
				></div>
			{/if}
			{#if containersSize > 0}
				<div
					class="bg-emerald-500 h-full transition-all duration-300"
					style="width: {getPercentage(containersSize)}%"
					title={m.dashboard_disk_containers_title({ size: formatBytes(containersSize) })}
				></div>
			{/if}
			{#if volumesSize > 0}
				<div
					class="bg-amber-500 h-full transition-all duration-300"
					style="width: {getPercentage(volumesSize)}%"
					title={m.dashboard_disk_volumes_title({ size: formatBytes(volumesSize) })}
				></div>
			{/if}
			{#if buildCacheSize > 0}
				<div
					class="bg-violet-500 h-full transition-all duration-300"
					style="width: {getPercentage(buildCacheSize)}%"
					title={m.dashboard_disk_build_cache_title({ size: formatBytes(buildCacheSize) })}
				></div>
			{/if}
		</div>

		<!-- Legend with values -->
		<div class="grid {categoryCount > 2 ? 'grid-cols-2' : 'grid-cols-' + categoryCount} gap-x-3 gap-y-1.5 text-xs">
			{#if imagesSize > 0}
				<div class="flex items-center gap-1.5">
					<div class="w-2 h-2 rounded-full bg-sky-500 shrink-0"></div>
					<Image class="w-3 h-3 text-muted-foreground shrink-0" />
					<span class="text-muted-foreground truncate">{m.nav_images()}</span>
					<span class="ml-auto font-medium tabular-nums">{formatBytes(imagesSize)}</span>
				</div>
			{/if}
			{#if containersSize > 0}
				<div class="flex items-center gap-1.5">
					<div class="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></div>
					<Box class="w-3 h-3 text-muted-foreground shrink-0" />
					<span class="text-muted-foreground truncate">{m.nav_containers()}</span>
					<span class="ml-auto font-medium tabular-nums">{formatBytes(containersSize)}</span>
				</div>
			{/if}
			{#if volumesSize > 0}
				<div class="flex items-center gap-1.5">
					<div class="w-2 h-2 rounded-full bg-amber-500 shrink-0"></div>
					<Database class="w-3 h-3 text-muted-foreground shrink-0" />
					<span class="text-muted-foreground truncate">{m.nav_volumes()}</span>
					<span class="ml-auto font-medium tabular-nums">{formatBytes(volumesSize)}</span>
				</div>
			{/if}
			{#if buildCacheSize > 0}
				<div class="flex items-center gap-1.5">
					<div class="w-2 h-2 rounded-full bg-violet-500 shrink-0"></div>
					<Hammer class="w-3 h-3 text-muted-foreground shrink-0" />
					<span class="text-muted-foreground truncate">{m.dashboard_disk_build_cache()}</span>
					<span class="ml-auto font-medium tabular-nums">{formatBytes(buildCacheSize)}</span>
				</div>
			{/if}
		</div>
		{/if}
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
