<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		name?: string;
		host?: string;
		width?: number;
		height?: number;
	}

	let { name, host, width = 1, height = 2 }: Props = $props();

	// Size conditionals
	const is1x1 = $derived(width === 1 && height === 1);
	const is2x1 = $derived(width >= 2 && height === 1);
	const is1x2 = $derived(width === 1 && height === 2);
	const is1x3 = $derived(width === 1 && height === 3);
	const is1x4 = $derived(width === 1 && height >= 4);
	const is2x2 = $derived(width >= 2 && height === 2);
	const is2x3 = $derived(width >= 2 && height === 3);
	const is2x4 = $derived(width >= 2 && height >= 4);
	const isMini = $derived(is1x1 || is2x1);
	const isWide = $derived(width >= 2);
</script>

<!-- Skeleton shimmer animation -->
<style>
	@keyframes shimmer {
		0% {
			background-position: -200% 0;
		}
		100% {
			background-position: 200% 0;
		}
	}
	.skeleton {
		background: linear-gradient(
			90deg,
			hsl(var(--muted)) 25%,
			hsl(var(--muted-foreground) / 0.1) 50%,
			hsl(var(--muted)) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}
</style>

<Card.Root class="h-full overflow-hidden">
	<!-- ==================== 1x1 TILE SKELETON ==================== -->
	{#if is1x1}
		<div class="flex flex-col justify-between p-2.5 h-full">
			<div class="flex items-center justify-between gap-2">
				<!-- Header skeleton -->
				<div class="flex items-center gap-1.5 min-w-0 flex-1">
					<div class="skeleton w-6 h-6 rounded-md shrink-0"></div>
					<div class="min-w-0 flex-1">
						{#if name}
							<div class="font-medium text-xs truncate">{name}</div>
						{:else}
							<div class="skeleton h-3 w-16 rounded"></div>
						{/if}
					</div>
				</div>
				<!-- Container counts skeleton -->
				<div class="flex items-center gap-1.5 shrink-0">
					{#each [1, 2, 3, 4, 5] as _}
						<div class="skeleton h-3 w-5 rounded"></div>
					{/each}
				</div>
				<!-- Status icons skeleton -->
				<div class="flex items-center gap-1 shrink-0">
					<div class="skeleton w-3.5 h-3.5 rounded-full"></div>
					<div class="skeleton w-3.5 h-3.5 rounded-full"></div>
				</div>
			</div>
			<!-- CPU/Memory bars skeleton -->
			<div class="flex items-center gap-3 mt-1.5">
				<div class="flex items-center gap-1.5 flex-1">
					<div class="skeleton w-3 h-3 rounded"></div>
					<div class="skeleton h-1.5 rounded-full flex-1"></div>
					<div class="skeleton w-6 h-3 rounded"></div>
				</div>
				<div class="flex items-center gap-1.5 flex-1">
					<div class="skeleton w-3 h-3 rounded"></div>
					<div class="skeleton h-1.5 rounded-full flex-1"></div>
					<div class="skeleton w-6 h-3 rounded"></div>
				</div>
			</div>
		</div>

	<!-- ==================== 2x1 TILE SKELETON ==================== -->
	{:else if is2x1}
		<div class="flex flex-col justify-between p-2.5 h-full">
			<div class="flex items-center justify-between gap-2">
				<!-- Header skeleton -->
				<div class="flex items-center gap-1.5 min-w-0 flex-1">
					<div class="skeleton w-6 h-6 rounded-md shrink-0"></div>
					<div class="min-w-0 flex-1">
						{#if name}
							<div class="font-medium text-xs truncate">{name}</div>
						{:else}
							<div class="skeleton h-3 w-20 rounded"></div>
						{/if}
					</div>
				</div>
				<!-- Container counts skeleton -->
				<div class="flex items-center gap-1.5 shrink-0">
					{#each [1, 2, 3, 4, 5] as _}
						<div class="skeleton h-3 w-5 rounded"></div>
					{/each}
				</div>
				<!-- Status icons skeleton -->
				<div class="flex items-center gap-1 shrink-0">
					<div class="skeleton w-3.5 h-3.5 rounded-full"></div>
					<div class="skeleton w-3.5 h-3.5 rounded-full"></div>
				</div>
			</div>
			<!-- CPU/Memory bars skeleton -->
			<div class="flex items-center gap-3 mt-1.5">
				<div class="flex items-center gap-1.5 flex-1">
					<div class="skeleton w-3 h-3 rounded"></div>
					<div class="skeleton h-1.5 rounded-full flex-1"></div>
					<div class="skeleton w-6 h-3 rounded"></div>
				</div>
				<div class="flex items-center gap-1.5 flex-1">
					<div class="skeleton w-3 h-3 rounded"></div>
					<div class="skeleton h-1.5 rounded-full flex-1"></div>
					<div class="skeleton w-6 h-3 rounded"></div>
				</div>
			</div>
		</div>

	<!-- ==================== 1x2 TILE SKELETON ==================== -->
	{:else if is1x2}
		<Card.Header class="pb-2">
			<!-- Header skeleton -->
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<div class="skeleton p-1.5 rounded-lg w-8 h-8"></div>
				<div class="min-w-0 flex-1 space-y-1">
					{#if name}
						<div class="font-medium text-sm truncate">{name}</div>
						<div class="text-xs text-muted-foreground truncate">{host || m.dashboard_connecting()}</div>
					{:else}
						<div class="skeleton h-4 w-24 rounded"></div>
						<div class="skeleton h-3 w-32 rounded"></div>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content class="space-y-3 overflow-auto" style="max-height: calc(100% - 60px);">
			<!-- Container stats skeleton -->
			<div class="grid grid-cols-6 gap-1">
				{#each [1, 2, 3, 4, 5, 6] as _}
					<div class="skeleton h-5 rounded"></div>
				{/each}
			</div>
			<!-- Health banner skeleton -->
			<div class="skeleton h-7 rounded-md"></div>
			<!-- CPU/Memory bars skeleton -->
			<div class="space-y-2 pt-1 border-t border-border/50">
				<div class="space-y-1">
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-12 rounded"></div>
						<div class="skeleton h-3 w-10 rounded"></div>
					</div>
					<div class="skeleton h-1.5 rounded-full"></div>
				</div>
				<div class="space-y-1">
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-16 rounded"></div>
						<div class="skeleton h-3 w-14 rounded"></div>
					</div>
					<div class="skeleton h-1.5 rounded-full"></div>
				</div>
			</div>
			<!-- Resource stats skeleton -->
			<div class="grid grid-cols-2 gap-x-4 gap-y-2">
				{#each [1, 2, 3, 4] as _}
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-14 rounded"></div>
						<div class="skeleton h-3 w-6 rounded"></div>
					</div>
				{/each}
			</div>
			<!-- Events summary skeleton -->
			<div class="flex items-center justify-between">
				<div class="skeleton h-3 w-20 rounded"></div>
				<div class="skeleton h-3 w-12 rounded"></div>
			</div>
		</Card.Content>

	<!-- ==================== 1x3 TILE SKELETON ==================== -->
	{:else if is1x3}
		<Card.Header class="pb-2">
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<div class="skeleton p-1.5 rounded-lg w-8 h-8"></div>
				<div class="min-w-0 flex-1 space-y-1">
					{#if name}
						<div class="font-medium text-sm truncate">{name}</div>
						<div class="text-xs text-muted-foreground truncate">{host || m.dashboard_connecting()}</div>
					{:else}
						<div class="skeleton h-4 w-24 rounded"></div>
						<div class="skeleton h-3 w-32 rounded"></div>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content class="space-y-3 overflow-auto" style="max-height: calc(100% - 60px);">
			<!-- Container stats skeleton -->
			<div class="grid grid-cols-6 gap-1">
				{#each [1, 2, 3, 4, 5, 6] as _}
					<div class="skeleton h-5 rounded"></div>
				{/each}
			</div>
			<!-- Health banner skeleton -->
			<div class="skeleton h-7 rounded-md"></div>
			<!-- CPU/Memory bars skeleton -->
			<div class="space-y-2 pt-1 border-t border-border/50">
				<div class="space-y-1">
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-12 rounded"></div>
						<div class="skeleton h-3 w-10 rounded"></div>
					</div>
					<div class="skeleton h-1.5 rounded-full"></div>
				</div>
				<div class="space-y-1">
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-16 rounded"></div>
						<div class="skeleton h-3 w-14 rounded"></div>
					</div>
					<div class="skeleton h-1.5 rounded-full"></div>
				</div>
			</div>
			<!-- Resource stats skeleton -->
			<div class="grid grid-cols-2 gap-x-4 gap-y-2">
				{#each [1, 2, 3, 4] as _}
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-14 rounded"></div>
						<div class="skeleton h-3 w-6 rounded"></div>
					</div>
				{/each}
			</div>
			<!-- Events summary skeleton -->
			<div class="flex items-center justify-between">
				<div class="skeleton h-3 w-20 rounded"></div>
				<div class="skeleton h-3 w-12 rounded"></div>
			</div>
			<!-- Recent events skeleton -->
			<div class="pt-2 border-t border-border/50">
				<div class="skeleton h-3 w-24 rounded mb-2"></div>
				<div class="space-y-1.5">
					{#each [1, 2, 3, 4, 5, 6, 7, 8] as _}
						<div class="flex items-center gap-2">
							<div class="skeleton w-3 h-3 rounded"></div>
							<div class="skeleton h-3 flex-1 rounded"></div>
							<div class="skeleton h-3 w-10 rounded"></div>
						</div>
					{/each}
				</div>
			</div>
		</Card.Content>

	<!-- ==================== 1x4 TILE SKELETON ==================== -->
	{:else if is1x4}
		<Card.Header class="pb-2">
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<div class="skeleton p-1.5 rounded-lg w-8 h-8"></div>
				<div class="min-w-0 flex-1 space-y-1">
					{#if name}
						<div class="font-medium text-sm truncate">{name}</div>
						<div class="text-xs text-muted-foreground truncate">{host || m.dashboard_connecting()}</div>
					{:else}
						<div class="skeleton h-4 w-24 rounded"></div>
						<div class="skeleton h-3 w-32 rounded"></div>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content class="space-y-3 overflow-auto" style="max-height: calc(100% - 60px);">
			<!-- Container stats skeleton -->
			<div class="grid grid-cols-6 gap-1">
				{#each [1, 2, 3, 4, 5, 6] as _}
					<div class="skeleton h-5 rounded"></div>
				{/each}
			</div>
			<!-- Health banner skeleton -->
			<div class="skeleton h-7 rounded-md"></div>
			<!-- CPU/Memory bars skeleton -->
			<div class="space-y-2 pt-1 border-t border-border/50">
				<div class="space-y-1">
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-12 rounded"></div>
						<div class="skeleton h-3 w-10 rounded"></div>
					</div>
					<div class="skeleton h-1.5 rounded-full"></div>
				</div>
				<div class="space-y-1">
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-16 rounded"></div>
						<div class="skeleton h-3 w-14 rounded"></div>
					</div>
					<div class="skeleton h-1.5 rounded-full"></div>
				</div>
			</div>
			<!-- Resource stats skeleton -->
			<div class="grid grid-cols-2 gap-x-4 gap-y-2">
				{#each [1, 2, 3, 4] as _}
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-14 rounded"></div>
						<div class="skeleton h-3 w-6 rounded"></div>
					</div>
				{/each}
			</div>
			<!-- Events summary skeleton -->
			<div class="flex items-center justify-between">
				<div class="skeleton h-3 w-20 rounded"></div>
				<div class="skeleton h-3 w-12 rounded"></div>
			</div>
			<!-- Recent events skeleton -->
			<div class="pt-2 border-t border-border/50">
				<div class="skeleton h-3 w-24 rounded mb-2"></div>
				<div class="space-y-1.5">
					{#each [1, 2, 3, 4, 5, 6, 7, 8] as _}
						<div class="flex items-center gap-2">
							<div class="skeleton w-3 h-3 rounded"></div>
							<div class="skeleton h-3 flex-1 rounded"></div>
							<div class="skeleton h-3 w-10 rounded"></div>
						</div>
					{/each}
				</div>
			</div>
			<!-- Top containers skeleton -->
			<div class="pt-2 border-t border-border/50">
				<div class="skeleton h-3 w-32 rounded mb-2"></div>
				<div class="space-y-1.5">
					{#each [1, 2, 3, 4, 5, 6, 7, 8] as _}
						<div class="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center">
							<div class="skeleton h-3 rounded"></div>
							<div class="skeleton h-3 w-10 rounded"></div>
							<div class="skeleton h-3 w-10 rounded"></div>
						</div>
					{/each}
				</div>
			</div>
		</Card.Content>

	<!-- ==================== 2x2 TILE SKELETON ==================== -->
	{:else if is2x2}
		<Card.Header class="pb-2">
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<div class="skeleton p-1.5 rounded-lg w-8 h-8"></div>
				<div class="min-w-0 flex-1 space-y-1">
					{#if name}
						<div class="font-medium text-sm truncate">{name}</div>
						<div class="text-xs text-muted-foreground truncate">{host || m.dashboard_connecting()}</div>
					{:else}
						<div class="skeleton h-4 w-24 rounded"></div>
						<div class="skeleton h-3 w-32 rounded"></div>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			<div class="grid grid-cols-2 gap-4">
				<!-- Left column -->
				<div class="space-y-3">
					<!-- Container stats skeleton -->
					<div class="grid grid-cols-6 gap-1">
						{#each [1, 2, 3, 4, 5, 6] as _}
							<div class="skeleton h-5 rounded"></div>
						{/each}
					</div>
					<!-- Health banner skeleton -->
					<div class="skeleton h-7 rounded-md"></div>
					<!-- CPU/Memory bars skeleton -->
					<div class="space-y-2 pt-1 border-t border-border/50">
						<div class="space-y-1">
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-12 rounded"></div>
								<div class="skeleton h-3 w-10 rounded"></div>
							</div>
							<div class="skeleton h-1.5 rounded-full"></div>
						</div>
						<div class="space-y-1">
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-16 rounded"></div>
								<div class="skeleton h-3 w-14 rounded"></div>
							</div>
							<div class="skeleton h-1.5 rounded-full"></div>
						</div>
					</div>
					<!-- Resource stats skeleton -->
					<div class="grid grid-cols-2 gap-x-4 gap-y-2">
						{#each [1, 2, 3, 4] as _}
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-14 rounded"></div>
								<div class="skeleton h-3 w-6 rounded"></div>
							</div>
						{/each}
					</div>
					<!-- Events summary skeleton -->
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-20 rounded"></div>
						<div class="skeleton h-3 w-12 rounded"></div>
					</div>
				</div>
				<!-- Right column -->
				<div class="space-y-3 border-l border-border/50 pl-4">
					<!-- Top containers skeleton -->
					<div class="pt-2 border-t border-border/50">
						<div class="skeleton h-3 w-32 rounded mb-2"></div>
						<div class="space-y-1.5">
							{#each [1, 2, 3, 4, 5, 6, 7, 8] as _}
								<div class="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center">
									<div class="skeleton h-3 rounded"></div>
									<div class="skeleton h-3 w-10 rounded"></div>
									<div class="skeleton h-3 w-10 rounded"></div>
								</div>
							{/each}
						</div>
					</div>
				</div>
			</div>
		</Card.Content>

	<!-- ==================== 2x3 TILE SKELETON ==================== -->
	{:else if is2x3}
		<Card.Header class="pb-2">
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<div class="skeleton p-1.5 rounded-lg w-8 h-8"></div>
				<div class="min-w-0 flex-1 space-y-1">
					{#if name}
						<div class="font-medium text-sm truncate">{name}</div>
						<div class="text-xs text-muted-foreground truncate">{host || m.dashboard_connecting()}</div>
					{:else}
						<div class="skeleton h-4 w-24 rounded"></div>
						<div class="skeleton h-3 w-32 rounded"></div>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			<div class="grid grid-cols-2 gap-4">
				<!-- Left column -->
				<div class="space-y-3">
					<!-- Container stats skeleton -->
					<div class="grid grid-cols-6 gap-1">
						{#each [1, 2, 3, 4, 5, 6] as _}
							<div class="skeleton h-5 rounded"></div>
						{/each}
					</div>
					<!-- Health banner skeleton -->
					<div class="skeleton h-7 rounded-md"></div>
					<!-- CPU/Memory bars skeleton -->
					<div class="space-y-2 pt-1 border-t border-border/50">
						<div class="space-y-1">
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-12 rounded"></div>
								<div class="skeleton h-3 w-10 rounded"></div>
							</div>
							<div class="skeleton h-1.5 rounded-full"></div>
						</div>
						<div class="space-y-1">
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-16 rounded"></div>
								<div class="skeleton h-3 w-14 rounded"></div>
							</div>
							<div class="skeleton h-1.5 rounded-full"></div>
						</div>
					</div>
					<!-- Resource stats skeleton -->
					<div class="grid grid-cols-2 gap-x-4 gap-y-2">
						{#each [1, 2, 3, 4] as _}
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-14 rounded"></div>
								<div class="skeleton h-3 w-6 rounded"></div>
							</div>
						{/each}
					</div>
					<!-- Events summary skeleton -->
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-20 rounded"></div>
						<div class="skeleton h-3 w-12 rounded"></div>
					</div>
					<!-- Recent events skeleton -->
					<div class="pt-2 border-t border-border/50">
						<div class="skeleton h-3 w-24 rounded mb-2"></div>
						<div class="space-y-1.5">
							{#each [1, 2, 3, 4, 5] as _}
								<div class="flex items-center gap-2">
									<div class="skeleton w-3 h-3 rounded"></div>
									<div class="skeleton h-3 flex-1 rounded"></div>
									<div class="skeleton h-3 w-10 rounded"></div>
								</div>
							{/each}
						</div>
					</div>
				</div>
				<!-- Right column -->
				<div class="space-y-3 border-l border-border/50 pl-4">
					<!-- Top containers skeleton -->
					<div class="pt-2 border-t border-border/50">
						<div class="skeleton h-3 w-32 rounded mb-2"></div>
						<div class="space-y-1.5">
							{#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as _}
								<div class="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center">
									<div class="skeleton h-3 rounded"></div>
									<div class="skeleton h-3 w-10 rounded"></div>
									<div class="skeleton h-3 w-10 rounded"></div>
								</div>
							{/each}
						</div>
					</div>
					<!-- Charts skeleton -->
					<div class="pt-2 border-t border-border/50">
						<div class="skeleton h-3 w-28 rounded mb-2"></div>
						<div class="skeleton h-24 rounded"></div>
					</div>
				</div>
			</div>
		</Card.Content>

	<!-- ==================== 2x4 TILE SKELETON ==================== -->
	{:else if is2x4}
		<Card.Header class="pb-2">
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<div class="skeleton p-1.5 rounded-lg w-8 h-8"></div>
				<div class="min-w-0 flex-1 space-y-1">
					{#if name}
						<div class="font-medium text-sm truncate">{name}</div>
						<div class="text-xs text-muted-foreground truncate">{host || m.dashboard_connecting()}</div>
					{:else}
						<div class="skeleton h-4 w-24 rounded"></div>
						<div class="skeleton h-3 w-32 rounded"></div>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			<div class="grid grid-cols-2 gap-4">
				<!-- Left column -->
				<div class="space-y-3">
					<!-- Container stats skeleton -->
					<div class="grid grid-cols-6 gap-1">
						{#each [1, 2, 3, 4, 5, 6] as _}
							<div class="skeleton h-5 rounded"></div>
						{/each}
					</div>
					<!-- Health banner skeleton -->
					<div class="skeleton h-7 rounded-md"></div>
					<!-- CPU/Memory bars skeleton -->
					<div class="space-y-2 pt-1 border-t border-border/50">
						<div class="space-y-1">
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-12 rounded"></div>
								<div class="skeleton h-3 w-10 rounded"></div>
							</div>
							<div class="skeleton h-1.5 rounded-full"></div>
						</div>
						<div class="space-y-1">
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-16 rounded"></div>
								<div class="skeleton h-3 w-14 rounded"></div>
							</div>
							<div class="skeleton h-1.5 rounded-full"></div>
						</div>
					</div>
					<!-- Resource stats skeleton -->
					<div class="grid grid-cols-2 gap-x-4 gap-y-2">
						{#each [1, 2, 3, 4] as _}
							<div class="flex items-center justify-between">
								<div class="skeleton h-3 w-14 rounded"></div>
								<div class="skeleton h-3 w-6 rounded"></div>
							</div>
						{/each}
					</div>
					<!-- Events summary skeleton -->
					<div class="flex items-center justify-between">
						<div class="skeleton h-3 w-20 rounded"></div>
						<div class="skeleton h-3 w-12 rounded"></div>
					</div>
					<!-- Recent events skeleton -->
					<div class="pt-2 border-t border-border/50">
						<div class="skeleton h-3 w-24 rounded mb-2"></div>
						<div class="space-y-1.5">
							{#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as _}
								<div class="flex items-center gap-2">
									<div class="skeleton w-3 h-3 rounded"></div>
									<div class="skeleton h-3 flex-1 rounded"></div>
									<div class="skeleton h-3 w-10 rounded"></div>
								</div>
							{/each}
						</div>
					</div>
					<!-- Top containers skeleton -->
					<div class="pt-2 border-t border-border/50">
						<div class="skeleton h-3 w-32 rounded mb-2"></div>
						<div class="space-y-1.5">
							{#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as _}
								<div class="grid grid-cols-[1fr_auto_auto] gap-x-3 items-center">
									<div class="skeleton h-3 rounded"></div>
									<div class="skeleton h-3 w-10 rounded"></div>
									<div class="skeleton h-3 w-10 rounded"></div>
								</div>
							{/each}
						</div>
					</div>
				</div>
				<!-- Right column -->
				<div class="space-y-3 border-l border-border/50 pl-4">
					<!-- Charts skeleton -->
					<div class="pt-2 border-t border-border/50">
						<div class="skeleton h-3 w-28 rounded mb-2"></div>
						<div class="skeleton h-32 rounded"></div>
					</div>
					<!-- Disk usage skeleton -->
					<div class="pt-2 border-t border-border/50">
						<div class="flex items-center justify-between mb-2">
							<div class="skeleton h-3 w-20 rounded"></div>
							<div class="skeleton h-3 w-14 rounded"></div>
						</div>
						<div class="flex items-center gap-4">
							<div class="skeleton w-24 h-24 rounded-full shrink-0"></div>
							<div class="flex-1 space-y-1.5">
								{#each [1, 2, 3, 4] as _}
									<div class="flex items-center gap-1.5">
										<div class="skeleton w-2 h-2 rounded-full"></div>
										<div class="skeleton h-3 w-16 rounded"></div>
										<div class="skeleton h-3 w-12 rounded ml-auto"></div>
									</div>
								{/each}
							</div>
						</div>
					</div>
				</div>
			</div>
		</Card.Content>
	{/if}
</Card.Root>
