<script lang="ts">
	import {
		Play,
		Square,
		Pause,
		RefreshCw,
		AlertTriangle,
		ArrowUpCircle,
		Loader2
	} from 'lucide-svelte';

	interface ContainerCounts {
		running: number;
		stopped: number;
		paused: number;
		restarting: number;
		unhealthy: number;
		pendingUpdates: number;
		total: number;
	}

	interface Props {
		containers: ContainerCounts;
		compact?: boolean;
		loading?: boolean;
	}

	let { containers, compact = false, loading = false }: Props = $props();

	// Only show skeleton if loading AND we don't have data yet
	// This prevents blinking when refreshing with existing data
	const hasData = $derived(containers && (containers.total > 0 || containers.running > 0 || containers.stopped > 0));
	const showSkeleton = $derived(loading && !hasData);
</script>

{#if showSkeleton && compact}
	<!-- Compact skeleton view -->
	<div class="flex items-center gap-1.5 shrink-0">
		<div class="flex items-center gap-0.5">
			<Play class="w-3 h-3 text-muted-foreground/50" />
			<div class="skeleton w-3 h-3 rounded"></div>
		</div>
		<div class="flex items-center gap-0.5">
			<Square class="w-3 h-3 text-muted-foreground/50" />
			<div class="skeleton w-3 h-3 rounded"></div>
		</div>
		<div class="flex items-center gap-0.5">
			<Pause class="w-3 h-3 text-muted-foreground/50" />
			<div class="skeleton w-3 h-3 rounded"></div>
		</div>
		<div class="flex items-center gap-0.5">
			<RefreshCw class="w-3 h-3 text-muted-foreground/50" />
			<div class="skeleton w-3 h-3 rounded"></div>
		</div>
		<div class="flex items-center gap-0.5">
			<AlertTriangle class="w-3 h-3 text-muted-foreground/50" />
			<div class="skeleton w-3 h-3 rounded"></div>
		</div>
		<div class="flex items-center gap-0.5">
			<ArrowUpCircle class="w-3 h-3 text-muted-foreground/50" />
			<div class="skeleton w-3 h-3 rounded"></div>
		</div>
	</div>
{:else if showSkeleton}
	<!-- Full skeleton grid view -->
	<div class="grid grid-cols-7 gap-1 min-h-5">
		<div class="flex items-center gap-1">
			<Play class="w-3.5 h-3.5 text-muted-foreground/50" />
			<div class="skeleton w-4 h-4 rounded"></div>
		</div>
		<div class="flex items-center gap-1">
			<Square class="w-3.5 h-3.5 text-muted-foreground/50" />
			<div class="skeleton w-4 h-4 rounded"></div>
		</div>
		<div class="flex items-center gap-1">
			<Pause class="w-3.5 h-3.5 text-muted-foreground/50" />
			<div class="skeleton w-4 h-4 rounded"></div>
		</div>
		<div class="flex items-center gap-1">
			<RefreshCw class="w-3.5 h-3.5 text-muted-foreground/50" />
			<div class="skeleton w-4 h-4 rounded"></div>
		</div>
		<div class="flex items-center gap-1">
			<AlertTriangle class="w-3.5 h-3.5 text-muted-foreground/50" />
			<div class="skeleton w-4 h-4 rounded"></div>
		</div>
		<div class="flex items-center gap-1">
			<ArrowUpCircle class="w-3.5 h-3.5 text-muted-foreground/50" />
			<div class="skeleton w-4 h-4 rounded"></div>
		</div>
		<div class="flex items-center gap-1">
			<span class="text-xs text-muted-foreground/50">Total</span>
			<div class="skeleton w-4 h-4 rounded"></div>
		</div>
	</div>
{:else if compact}
	<!-- Compact view for mini tiles -->
	<div class="flex items-center gap-1.5 shrink-0">
		<div class="flex items-center gap-0.5" title="Running">
			<Play class="w-3 h-3 text-emerald-500" />
			<span class="text-2xs font-medium">{containers.running}</span>
		</div>
		<div class="flex items-center gap-0.5" title="Stopped">
			<Square class="w-3 h-3 text-muted-foreground" />
			<span class="text-2xs font-medium">{containers.stopped}</span>
		</div>
		<div class="flex items-center gap-0.5" title="Paused">
			<Pause class="w-3 h-3 text-amber-500" />
			<span class="text-2xs font-medium">{containers.paused}</span>
		</div>
		<div class="flex items-center gap-0.5" title="Restarting">
			<RefreshCw class="w-3 h-3 {containers.restarting > 0 ? 'text-red-500 animate-spin' : 'text-emerald-500'}" />
			<span class="text-2xs font-medium">{containers.restarting}</span>
		</div>
		<div class="flex items-center gap-0.5" title="Unhealthy">
			<AlertTriangle class="w-3 h-3 {containers.unhealthy > 0 ? 'text-red-500' : 'text-emerald-500'}" />
			<span class="text-2xs font-medium">{containers.unhealthy}</span>
		</div>
		<div class="flex items-center gap-0.5 {containers.pendingUpdates > 0 ? 'pending-glow' : ''}" title="Pending updates">
			<ArrowUpCircle class="w-3 h-3 {containers.pendingUpdates > 0 ? 'text-amber-400' : 'text-muted-foreground'}" />
			<span class="text-2xs font-medium {containers.pendingUpdates > 0 ? 'text-amber-400' : ''}">{containers.pendingUpdates}</span>
		</div>
	</div>
{:else}
	<!-- Full grid view -->
	<div class="grid grid-cols-7 gap-1 min-h-5">
		<div class="flex items-center gap-1" title="Running containers">
			<Play class="w-3.5 h-3.5 text-emerald-500" />
			<span class="text-sm font-medium">{containers.running}</span>
		</div>
		<div class="flex items-center gap-1" title="Stopped containers">
			<Square class="w-3.5 h-3.5 text-muted-foreground" />
			<span class="text-sm font-medium">{containers.stopped}</span>
		</div>
		<div class="flex items-center gap-1" title="Paused containers">
			<Pause class="w-3.5 h-3.5 text-amber-500" />
			<span class="text-sm font-medium">{containers.paused}</span>
		</div>
		<div class="flex items-center gap-1" title="Restarting containers">
			<RefreshCw class="w-3.5 h-3.5 {containers.restarting > 0 ? 'text-red-500 animate-spin' : 'text-emerald-500'}" />
			<span class="text-sm font-medium">{containers.restarting}</span>
		</div>
		<div class="flex items-center gap-1" title="Unhealthy containers">
			<AlertTriangle class="w-3.5 h-3.5 {containers.unhealthy > 0 ? 'text-red-500' : 'text-emerald-500'}" />
			<span class="text-sm font-medium">{containers.unhealthy}</span>
		</div>
		<div class="flex items-center gap-1 {containers.pendingUpdates > 0 ? 'pending-glow' : ''}" title="Pending updates">
			<ArrowUpCircle class="w-3.5 h-3.5 {containers.pendingUpdates > 0 ? 'text-amber-400' : 'text-muted-foreground'}" />
			<span class="text-sm font-medium {containers.pendingUpdates > 0 ? 'text-amber-400' : ''}">{containers.pendingUpdates}</span>
		</div>
		<div class="flex items-center gap-1" title="Total containers">
			<span class="text-xs text-muted-foreground">Total</span>
			<span class="text-sm font-medium">{containers.total}</span>
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
	@keyframes pending-pulse {
		0%, 100% {
			filter: drop-shadow(0 0 2px rgba(251, 191, 36, 0.4));
		}
		50% {
			filter: drop-shadow(0 0 3px rgba(251, 191, 36, 0.6)) drop-shadow(0 0 5px rgba(251, 191, 36, 0.3));
		}
	}
	:global(.pending-glow) {
		animation: pending-pulse 2s ease-in-out infinite;
	}
</style>
