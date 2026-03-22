<script lang="ts">
	import { Loader2, Circle, Route, UndoDot, Plug, Icon, CircleArrowUp } from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import { getLabelColors } from '$lib/utils/label-colors';
	import { DataGrid } from '$lib/components/data-grid';
	import type { DataGridRowState, DataGridSortState } from '$lib/components/data-grid/types';
	import type { ColumnConfig } from '$lib/types';
	import type { TileItem } from '$lib/stores/dashboard';

	interface Props {
		tiles: TileItem[];
		searchQuery?: string;
		connectionFilter?: string[];
		onrowclick?: (envId: number) => void;
	}

	let { tiles, searchQuery = '', connectionFilter = [], onrowclick }: Props = $props();

	// Sort state
	let sortState = $state<DataGridSortState>({ field: 'name', direction: 'asc' });

	function connectionLabel(type: string | undefined): string {
		switch (type) {
			case 'hawser-standard': return 'Standard';
			case 'hawser-edge': return 'Edge';
			case 'direct': return 'Direct';
			case 'socket': return 'Socket';
			default: return 'Socket';
		}
	}

	function formatPercent(value: number | undefined | null): string {
		if (value == null || value < 0) return '-';
		return `${value.toFixed(1)}%`;
	}

	function getSortValue(tile: TileItem, field: string): number | string {
		const s = tile.stats;
		if (!s) return '';
		switch (field) {
			case 'name': return s.name.toLowerCase();
			case 'status': return s.online === true ? 0 : s.online === false ? 2 : 1;
			case 'connection': return s.connectionType || '';
			case 'host': return s.host || '';
			case 'containers': return s.containers.running;
			case 'cpu': return s.metrics?.cpuPercent ?? -1;
			case 'memory': return s.metrics?.memoryPercent ?? -1;
			case 'images': return s.images.total;
			case 'volumes': return s.volumes.total;
			case 'stacks': return s.stacks.running;
			case 'updates': return s.containers.pendingUpdates ?? 0;
			case 'events': return s.events.today;
			default: return '';
		}
	}

	// Filter by search query and connection type
	const filteredTiles = $derived.by(() => {
		let result = tiles;

		// Connection type filter
		if (connectionFilter.length > 0) {
			result = result.filter(t => {
				const type = t.stats?.connectionType || 'socket';
				return connectionFilter.includes(type);
			});
		}

		// Search filter
		const q = searchQuery.trim().toLowerCase();
		if (q) {
			result = result.filter(t => {
				const s = t.stats;
				if (!s) return false;
				if (s.name.toLowerCase().includes(q)) return true;
				if (s.host?.toLowerCase().includes(q)) return true;
				if (connectionLabel(s.connectionType).toLowerCase().includes(q)) return true;
				if (s.labels?.some(l => l.toLowerCase().includes(q))) return true;
				return false;
			});
		}

		return result;
	});

	// Sort filtered tiles
	const sortedTiles = $derived.by(() => {
		const field = sortState.field || 'name';
		const dir = sortState.direction || 'asc';
		return [...filteredTiles].sort((a, b) => {
			const aVal = getSortValue(a, field);
			const bVal = getSortValue(b, field);
			if (aVal < bVal) return dir === 'asc' ? -1 : 1;
			if (aVal > bVal) return dir === 'asc' ? 1 : -1;
			return 0;
		});
	});
</script>

<div class="flex-1 min-h-0 flex flex-col overflow-hidden">
	<!-- DataGrid -->
	<DataGrid
		data={sortedTiles}
		keyField="id"
		gridId="environments"
		loading={false}
		{sortState}
		onSortChange={(state) => { sortState = state; }}
		onRowClick={(tile, e) => onrowclick?.(tile.id)}
		rowHeight={36}
	>
		{#snippet cell(column, tile, rowState)}
			{@const s = tile.stats}
			{@const isOnline = s?.online === true}
			{@const isOffline = s?.online === false}

			{#if column.id === 'status'}
				{#if tile.loading && !s}
					<Loader2 class="w-3.5 h-3.5 animate-spin text-muted-foreground" />
				{:else if isOnline}
					<Circle class="w-3 h-3 fill-emerald-500 text-emerald-500" />
				{:else if isOffline}
					<Circle class="w-3 h-3 fill-destructive text-destructive" />
				{:else}
					<Circle class="w-3 h-3 fill-amber-500 text-amber-500" />
				{/if}

			{:else if column.id === 'name'}
				{#if s}
					<div class="flex items-center gap-2 min-w-0">
						<EnvironmentIcon icon={s.icon || 'globe'} envId={s.id} class="w-4 h-4 text-muted-foreground shrink-0" />
						<span class="font-medium truncate">{s.name}</span>
					</div>
				{:else if tile.info}
					<div class="flex items-center gap-2 min-w-0">
						<EnvironmentIcon icon={tile.info.icon || 'globe'} envId={tile.info.id} class="w-4 h-4 text-muted-foreground shrink-0" />
						<span class="font-medium truncate">{tile.info.name}</span>
					</div>
				{:else}
					<div class="h-4 w-32 bg-muted animate-pulse rounded" />
				{/if}

			{:else if column.id === 'connection'}
				{#if s}
					<div class="flex items-center gap-1.5 text-muted-foreground">
						{#if s.connectionType === 'hawser-standard'}
							<Route class="w-3.5 h-3.5 shrink-0" />
						{:else if s.connectionType === 'hawser-edge'}
							<UndoDot class="w-3.5 h-3.5 shrink-0" />
						{:else if s.connectionType === 'direct'}
							<Plug class="w-3.5 h-3.5 shrink-0" />
						{:else}
							<Icon iconNode={whale} class="w-3.5 h-3.5 shrink-0" />
						{/if}
						<span class="text-xs">{connectionLabel(s.connectionType)}</span>
					</div>
				{:else if tile.loading}
					<div class="h-4 w-16 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'host'}
				{#if s?.host && !isOffline}
					<span class="text-xs text-muted-foreground font-mono truncate block" title={s.port ? `${s.host}:${s.port}` : s.host}>
						{s.host}{s.port ? `:${s.port}` : ''}
					</span>
				{:else if s?.socketPath}
					<span class="text-xs text-muted-foreground font-mono truncate block" title={s.socketPath}>
						{s.socketPath}
					</span>
				{:else if tile.loading}
					<div class="h-4 w-20 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'containers'}
				{#if s && !isOffline}
					<span class="text-emerald-500 font-medium">{s.containers.running}</span>
					<span class="text-muted-foreground">/ {s.containers.total}</span>
				{:else if tile.loading}
					<div class="h-4 w-12 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'updates'}
				{#if s && !isOffline}
					{#if s.containers.pendingUpdates > 0}
						<div class="flex items-center gap-1">
							<CircleArrowUp class="w-3.5 h-3.5 text-amber-500" />
							<span class="text-amber-500 font-medium">{s.containers.pendingUpdates}</span>
						</div>
					{:else}
						<span class="text-muted-foreground">0</span>
					{/if}
				{:else if tile.loading}
					<div class="h-4 w-8 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'cpu'}
				{#if s?.metrics && !isOffline}
					<div class="flex items-center gap-2">
						<div class="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
							<div
								class="h-full rounded-full transition-all {s.metrics.cpuPercent > 80 ? 'bg-destructive' : s.metrics.cpuPercent > 60 ? 'bg-amber-500' : 'bg-primary'}"
								style="width: {Math.min(s.metrics.cpuPercent, 100)}%"
							/>
						</div>
						<span class="text-xs tabular-nums">{formatPercent(s.metrics.cpuPercent)}</span>
					</div>
				{:else if tile.loading}
					<div class="h-4 w-16 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'memory'}
				{#if s?.metrics && !isOffline}
					<div class="flex items-center gap-2">
						<div class="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
							<div
								class="h-full rounded-full transition-all {s.metrics.memoryPercent > 80 ? 'bg-destructive' : s.metrics.memoryPercent > 60 ? 'bg-amber-500' : 'bg-primary'}"
								style="width: {Math.min(s.metrics.memoryPercent, 100)}%"
							/>
						</div>
						<span class="text-xs tabular-nums">{formatPercent(s.metrics.memoryPercent)}</span>
					</div>
				{:else if tile.loading}
					<div class="h-4 w-16 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'images'}
				{#if s && !isOffline}
					{s.images.total}
				{:else if tile.loading}
					<div class="h-4 w-8 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'volumes'}
				{#if s && !isOffline}
					{s.volumes.total}
				{:else if tile.loading}
					<div class="h-4 w-8 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'stacks'}
				{#if s && !isOffline}
					<span class="text-emerald-500 font-medium">{s.stacks.running}</span>
					<span class="text-muted-foreground">/ {s.stacks.total}</span>
				{:else if tile.loading}
					<div class="h-4 w-12 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'events'}
				{#if s && !isOffline}
					{s.events.today}
				{:else if tile.loading}
					<div class="h-4 w-8 bg-muted animate-pulse rounded" />
				{:else}
					<span class="text-muted-foreground">-</span>
				{/if}

			{:else if column.id === 'labels'}
				{#if s?.labels && s.labels.length > 0}
					<div class="flex flex-wrap gap-1">
						{#each s.labels as label}
							{@const colors = getLabelColors(label)}
							<span
								class="px-1.5 py-0.5 text-[11px] rounded-sm font-medium leading-tight whitespace-nowrap"
								style="background-color: {colors.bgColor}; color: {colors.color}"
							>
								{label}
							</span>
						{/each}
					</div>
				{/if}
			{/if}
		{/snippet}
	</DataGrid>
</div>
