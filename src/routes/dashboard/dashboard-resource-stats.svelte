<script lang="ts">
	import {
		Image,
		HardDrive,
		Network,
		Layers,
		Loader2
	} from 'lucide-svelte';
	import type { LoadingStates } from '../api/dashboard/stats/+server';

	interface Props {
		images: { total: number };
		volumes: { total: number };
		networks: { total: number };
		stacks: { total: number; running: number; partial: number; stopped: number };
		loading?: LoadingStates;
		showStacksBreakdown?: boolean;
	}

	let { images, volumes, networks, stacks, loading, showStacksBreakdown = true }: Props = $props();

	// Only show skeleton if loading AND we don't have data yet
	// This prevents blinking when refreshing with existing data
	const showImagesSkeleton = $derived(loading?.images && images.total === 0);
	const showStacksSkeleton = $derived(loading?.stacks && stacks.total === 0);
	const showVolumesSkeleton = $derived(loading?.volumes && volumes.total === 0);
	const showNetworksSkeleton = $derived(loading?.networks && networks.total === 0);
</script>

<div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
	<div class="flex items-center justify-between">
		<span class="flex items-center gap-1 text-muted-foreground">
			<Image class="w-3 h-3" /> Images
		</span>
		{#if showImagesSkeleton}
			<div class="skeleton w-4 h-3.5 rounded"></div>
		{:else}
			<span class="font-medium">{images.total}</span>
		{/if}
	</div>
	<div class="flex items-center justify-between">
		<span class="flex items-center gap-1 text-muted-foreground">
			<Layers class="w-3 h-3" /> Stacks
		</span>
		{#if showStacksSkeleton}
			<div class="skeleton w-12 h-3.5 rounded"></div>
		{:else}
			<span class="font-medium">
				{stacks.total}
				{#if showStacksBreakdown && stacks.total > 0}
					<span class="text-emerald-500">{stacks.running}</span>/<span class="text-amber-500">{stacks.partial}</span>/<span class="text-red-500">{stacks.stopped}</span>
				{/if}
			</span>
		{/if}
	</div>
	<div class="flex items-center justify-between">
		<span class="flex items-center gap-1 text-muted-foreground">
			<HardDrive class="w-3 h-3" /> Volumes
		</span>
		{#if showVolumesSkeleton}
			<div class="skeleton w-4 h-3.5 rounded"></div>
		{:else}
			<span class="font-medium">{volumes.total}</span>
		{/if}
	</div>
	<div class="flex items-center justify-between">
		<span class="flex items-center gap-1 text-muted-foreground">
			<Network class="w-3 h-3" /> Networks
		</span>
		{#if showNetworksSkeleton}
			<div class="skeleton w-4 h-3.5 rounded"></div>
		{:else}
			<span class="font-medium">{networks.total}</span>
		{/if}
	</div>
</div>

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
