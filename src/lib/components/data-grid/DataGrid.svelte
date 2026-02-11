<script lang="ts" generics="T">
	import { onMount, onDestroy } from 'svelte';
	import type { Snippet } from 'svelte';
	import { CheckSquare, Square as SquareIcon, ArrowUp, ArrowDown, ArrowUpDown, ChevronDown, ChevronRight } from 'lucide-svelte';
	import { columnResize } from '$lib/actions/column-resize';
	import { gridPreferencesStore } from '$lib/stores/grid-preferences';
	import { getAllColumnConfigs } from '$lib/config/grid-columns';
	import ColumnSettingsPopover from '$lib/components/ColumnSettingsPopover.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import type { GridId, ColumnConfig, ColumnPreference } from '$lib/types';
	import type { DataGridSortState, DataGridRowState } from './types';
	import { setDataGridContext } from './context';

	// Props
	interface Props {
		// Required
		data: T[];
		keyField: keyof T;
		gridId: GridId;

		// Virtual Scroll Mode (OFF by default)
		virtualScroll?: boolean;
		rowHeight?: number;
		bufferRows?: number;

		// Selection
		selectable?: boolean;
		selectedKeys?: Set<unknown>;
		onSelectionChange?: (keys: Set<unknown>) => void;

		// Sorting
		sortState?: DataGridSortState;
		onSortChange?: (state: DataGridSortState) => void;

		// Infinite scroll (virtual mode)
		hasMore?: boolean;
		onLoadMore?: () => void;
		loadMoreThreshold?: number;

		// Visible range callback (for virtual scroll)
		onVisibleRangeChange?: (start: number, end: number, total: number) => void;

		// Row interaction
		onRowClick?: (item: T, event: MouseEvent) => void;
		highlightedKey?: unknown;
		rowClass?: (item: T) => string;

		// Selection filter - return false to make an item non-selectable
		selectableFilter?: (item: T) => boolean;

		// Expandable rows
		expandable?: boolean;
		expandedKeys?: Set<unknown>;
		onExpandChange?: (key: unknown, expanded: boolean) => void;
		expandedRow?: Snippet<[T, DataGridRowState]>;

		// State
		loading?: boolean;
		skeletonRows?: number;

		// CSS
		class?: string;
		wrapperClass?: string;

		// Snippets for customization
		headerCell?: Snippet<[ColumnConfig, DataGridSortState | undefined]>;
		cell?: Snippet<[ColumnConfig, T, DataGridRowState]>;
		emptyState?: Snippet;
		loadingState?: Snippet;
		footer?: Snippet;
	}

	let {
		data,
		keyField,
		gridId,
		virtualScroll = false,
		rowHeight = 33,
		bufferRows = 10,
		selectable = false,
		selectedKeys = $bindable(new Set<unknown>()),
		onSelectionChange,
		sortState,
		onSortChange,
		hasMore = false,
		onLoadMore,
		loadMoreThreshold = 200,
		onVisibleRangeChange,
		onRowClick,
		highlightedKey,
		rowClass,
		selectableFilter,
		expandable = false,
		expandedKeys = $bindable(new Set<unknown>()),
		onExpandChange,
		expandedRow,
		loading = false,
		skeletonRows = 8,
		class: className = '',
		wrapperClass = '',
		headerCell,
		cell,
		emptyState,
		loadingState,
		footer
	}: Props = $props();

	// Column configuration
	const columnConfigs = getAllColumnConfigs(gridId);
	const columnConfigMap = new Map(columnConfigs.map((c) => [c.id, c]));
	const fixedStartCols = columnConfigs.filter((c) => c.fixed === 'start').map((c) => c.id);
	const fixedEndCols = columnConfigs.filter((c) => c.fixed === 'end').map((c) => c.id);

	// Grid preferences (reactive)
	const gridPrefs = $derived($gridPreferencesStore);

	// Get ordered visible columns from preferences (excluding fixed columns)
	const orderedColumns = $derived.by(() => {
		const prefs = gridPrefs[gridId];
		if (!prefs?.columns?.length) {
			// Default: all configurable columns visible
			return columnConfigs.filter((c) => !c.fixed).map((c) => c.id);
		}
		// Filter out fixed columns - they're rendered separately via fixedStartCols/fixedEndCols
		const fixedIds = new Set([...fixedStartCols, ...fixedEndCols]);
		return prefs.columns.filter((c) => c.visible && !fixedIds.has(c.id)).map((c) => c.id);
	});

	// Identify visible grow columns (columns with grow: true that are currently visible)
	const visibleGrowCols = $derived(
		orderedColumns.filter((id) => columnConfigMap.get(id)?.grow)
	);

	// Helper to check if column is a grow column
	function isGrowColumn(colId: string): boolean {
		return visibleGrowCols.includes(colId);
	}

	// Saved column widths from preferences
	const savedWidths = $derived.by(() => {
		const prefs = gridPrefs[gridId];
		const widths = new Map<string, number>();
		if (prefs?.columns) {
			for (const col of prefs.columns) {
				if (col.width !== undefined) {
					widths.set(col.id, col.width);
				}
			}
		}
		return widths;
	});

	// Local widths for smooth resize feedback (not persisted until mouseup)
	let localWidths = $state<Map<string, number>>(new Map());

	// RAF throttling for performance
	let resizeRAF: number | null = null;
	let scrollRAF: number | null = null;
	let visibleRangeRAF: number | null = null;
	let containerResizeRAF: number | null = null;
	let loadMorePending = false;

	// Helper to get base width for a column (without grow calculation)
	function getBaseWidth(colId: string): number {
		if (localWidths.has(colId)) return localWidths.get(colId)!;
		if (savedWidths.has(colId)) return savedWidths.get(colId)!;
		return columnConfigMap.get(colId)?.width ?? 100;
	}

	// Calculate width for grow columns (distributes remaining space equally)
	const growColumnWidth = $derived.by(() => {
		if (!scrollContainerWidth || visibleGrowCols.length === 0) return null;

		// Sum of all fixed-width columns (non-grow)
		let fixedTotal = 0;

		// Fixed start columns (select, expand)
		for (const colId of fixedStartCols) {
			fixedTotal += getBaseWidth(colId);
		}

		// Visible non-grow columns
		for (const colId of orderedColumns) {
			if (!visibleGrowCols.includes(colId)) {
				fixedTotal += getBaseWidth(colId);
			}
		}

		// Fixed end columns (actions)
		for (const colId of fixedEndCols) {
			fixedTotal += getBaseWidth(colId);
		}

		// Distribute remaining space equally among grow columns
		// No buffer - grow columns absorb all remaining space
		const remaining = Math.max(0, scrollContainerWidth - fixedTotal);
		const perGrowCol = remaining / visibleGrowCols.length;

		// Respect minimum widths
		const minWidth = Math.max(
			...visibleGrowCols.map((id) => columnConfigMap.get(id)?.minWidth ?? 60)
		);

		return Math.max(perGrowCol, minWidth);
	});

	// Calculate total table width (sum of all column widths)
	const totalTableWidth = $derived.by(() => {
		let total = 0;
		for (const colId of fixedStartCols) {
			total += getBaseWidth(colId);
		}
		for (const colId of orderedColumns) {
			total += getDisplayWidth(colId);
		}
		for (const colId of fixedEndCols) {
			total += getBaseWidth(colId);
		}
		return total;
	});

	// Get display width for a column (priority: local > saved > grow-calculated > default)
	function getDisplayWidth(colId: string): number {
		// For non-grow columns, use base width
		if (!isGrowColumn(colId)) {
			return getBaseWidth(colId);
		}

		// For grow columns: if user has resized, use their width
		if (localWidths.has(colId)) return localWidths.get(colId)!;
		if (savedWidths.has(colId)) return savedWidths.get(colId)!;

		// Otherwise use calculated grow width
		if (growColumnWidth) {
			return growColumnWidth;
		}

		return columnConfigMap.get(colId)?.width ?? 100;
	}

	// Get column config by ID
	function getColumnConfig(colId: string): ColumnConfig | undefined {
		return columnConfigMap.get(colId);
	}

	// Handle resize during drag (RAF throttled for performance)
	function handleResize(colId: string, width: number) {
		if (resizeRAF) return; // Skip if already pending
		resizeRAF = requestAnimationFrame(() => {
			resizeRAF = null;
			localWidths.set(colId, width);
			localWidths = new Map(localWidths); // Trigger reactivity
		});
	}

	// Handle resize end - persist to store
	async function handleResizeEnd(colId: string, width: number) {
		await gridPreferencesStore.setColumnWidth(gridId, colId, width);
		localWidths.delete(colId);
		localWidths = new Map(localWidths);
	}

	// Selection helpers
	function isItemSelectable(item: T): boolean {
		return selectableFilter ? selectableFilter(item) : true;
	}

	const selectableData = $derived(data.filter(isItemSelectable));
	const allSelected = $derived(selectableData.length > 0 && selectableData.every((item) => selectedKeys.has(item[keyField])));
	const someSelected = $derived(selectableData.some((item) => selectedKeys.has(item[keyField])) && !allSelected);

	function isSelected(key: unknown): boolean {
		return selectedKeys.has(key);
	}

	function toggleSelection(key: unknown) {
		const newKeys = new Set(selectedKeys);
		if (newKeys.has(key)) {
			newKeys.delete(key);
		} else {
			newKeys.add(key);
		}
		selectedKeys = newKeys;
		onSelectionChange?.(newKeys);
	}

	function selectAll() {
		// Add all selectable items to existing selection (preserves filtered-out selections)
		const newKeys = new Set(selectedKeys);
		for (const item of selectableData) {
			newKeys.add(item[keyField]);
		}
		selectedKeys = newKeys;
		onSelectionChange?.(newKeys);
	}

	function selectNone() {
		// Remove only selectable items from selection (preserves filtered-out selections)
		const newKeys = new Set(selectedKeys);
		for (const item of selectableData) {
			newKeys.delete(item[keyField]);
		}
		selectedKeys = newKeys;
		onSelectionChange?.(newKeys);
	}

	function toggleSelectAll() {
		if (allSelected) {
			selectNone();
		} else {
			selectAll();
		}
	}

	// Expand helpers
	function isExpanded(key: unknown): boolean {
		return expandedKeys.has(key);
	}

	function toggleExpand(key: unknown) {
		const newKeys = new Set(expandedKeys);
		const nowExpanded = !newKeys.has(key);
		if (nowExpanded) {
			newKeys.add(key);
		} else {
			newKeys.delete(key);
		}
		expandedKeys = newKeys;
		onExpandChange?.(key, nowExpanded);
	}

	// Sort helpers
	function toggleSort(field: string) {
		if (!onSortChange) return;

		if (sortState?.field === field) {
			onSortChange({
				field,
				direction: sortState.direction === 'asc' ? 'desc' : 'asc'
			});
		} else {
			onSortChange({ field, direction: 'asc' });
		}
	}

	// Virtual scroll state
	let scrollContainer = $state<HTMLDivElement | null>(null);
	let scrollTop = $state(0);
	let containerHeight = $state(600);

	// Container width for grow column calculation
	let scrollContainerWidth = $state(0);

	// Virtual scroll calculations
	const totalHeight = $derived(virtualScroll ? data.length * rowHeight : 0);

	// Memoization state for visibleData to prevent creating new arrays on every scroll
	let prevStartIndex = -1;
	let prevEndIndex = -1;
	let prevDataRef: T[] | null = null;
	let cachedVisibleData: T[] = [];

	// Memoized startIndex/endIndex/visibleData calculation
	const startIndex = $derived(virtualScroll ? Math.max(0, Math.floor(scrollTop / rowHeight) - bufferRows) : 0);
	const endIndex = $derived(
		virtualScroll ? Math.min(data.length, Math.ceil((scrollTop + containerHeight) / rowHeight) + bufferRows) : data.length
	);

	// Memoized visibleData - only create new array when bounds or data actually change
	const visibleData = $derived.by(() => {
		if (!virtualScroll) return data;

		// If data reference changed, we must reslice
		const dataChanged = data !== prevDataRef;

		// Only create new array if bounds or data actually changed
		if (!dataChanged && startIndex === prevStartIndex && endIndex === prevEndIndex && cachedVisibleData.length > 0) {
			return cachedVisibleData;
		}

		prevStartIndex = startIndex;
		prevEndIndex = endIndex;
		prevDataRef = data;
		cachedVisibleData = data.slice(startIndex, endIndex);
		return cachedVisibleData;
	});

	const offsetY = $derived(virtualScroll ? startIndex * rowHeight : 0);

	// Notify parent of visible range changes (throttled via RAF)
	$effect(() => {
		if (virtualScroll && onVisibleRangeChange && data.length > 0) {
			// Capture values for RAF callback
			const st = scrollTop;
			const ch = containerHeight;
			const len = data.length;
			const rh = rowHeight;
			const cb = onVisibleRangeChange;

			if (visibleRangeRAF) cancelAnimationFrame(visibleRangeRAF);
			visibleRangeRAF = requestAnimationFrame(() => {
				visibleRangeRAF = null;
				// Calculate actual visible range (without buffer)
				const visibleStart = Math.max(1, Math.floor(st / rh) + 1);
				const visibleEnd = Math.min(len, Math.ceil((st + ch) / rh));
				cb(visibleStart, Math.max(visibleEnd, visibleStart), len);
			});
		}
	});

	// Handle scroll for virtual mode (RAF throttled for performance)
	function handleScroll(event: Event) {
		if (!virtualScroll) return;
		if (scrollRAF) return; // Skip if already pending

		scrollRAF = requestAnimationFrame(() => {
			scrollRAF = null;
			const target = event.target as HTMLDivElement;
			scrollTop = target.scrollTop;

			// Update container height on scroll (in case of resize)
			containerHeight = target.clientHeight;

			// Infinite scroll trigger (with guard to prevent repeated calls)
			if (hasMore && onLoadMore && !loadMorePending) {
				const scrollBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
				if (scrollBottom < loadMoreThreshold) {
					loadMorePending = true;
					onLoadMore();
					// Reset after a short delay to allow the next load
					setTimeout(() => { loadMorePending = false; }, 100);
				}
			}
		});
	}

	// Update container dimensions on mount and resize
	onMount(() => {
		if (scrollContainer) {
			// Track width for grow column calculation (always needed)
			scrollContainerWidth = scrollContainer.clientWidth;

			// Track height for virtual scroll
			if (virtualScroll) {
				containerHeight = scrollContainer.clientHeight;
			}

			const resizeObserver = new ResizeObserver((entries) => {
				// Throttle with RAF to prevent "ResizeObserver loop" warnings
				if (containerResizeRAF) return;
				containerResizeRAF = requestAnimationFrame(() => {
					containerResizeRAF = null;
					for (const entry of entries) {
						scrollContainerWidth = entry.contentRect.width;
						if (virtualScroll) {
							containerHeight = entry.contentRect.height;
						}
					}
				});
			});
			resizeObserver.observe(scrollContainer);

			return () => {
				resizeObserver.disconnect();
			};
		}
	});

	// Cleanup RAF handles on destroy
	onDestroy(() => {
		if (resizeRAF) cancelAnimationFrame(resizeRAF);
		if (scrollRAF) cancelAnimationFrame(scrollRAF);
		if (visibleRangeRAF) cancelAnimationFrame(visibleRangeRAF);
		if (containerResizeRAF) cancelAnimationFrame(containerResizeRAF);
	});

	// Set context for child components
	setDataGridContext({
		gridId,
		keyField: keyField as keyof unknown,
		orderedColumns,
		getDisplayWidth,
		getColumnConfig,
		selectable,
		isSelected,
		toggleSelection,
		selectAll,
		selectNone,
		allSelected,
		someSelected,
		sortState,
		toggleSort,
		handleResize,
		handleResizeEnd,
		highlightedKey
	});

	// Row state cache to prevent creating new objects on every scroll
	// Use $derived to track dependencies synchronously (unlike $effect which is async)
	let rowStateCache = new WeakMap<object, DataGridRowState>();

	// Track cache invalidation keys - when these change, cache is stale
	let cachedSelectedKeysRef: Set<unknown> | null = null;
	let cachedExpandedKeysRef: Set<unknown> | null = null;
	let cachedHighlightedKeyRef: unknown = undefined;

	// Helper to get row state (memoized via WeakMap)
	// Cache is invalidated synchronously when selection/expansion changes
	function getRowState(item: T, index: number): DataGridRowState {
		const actualIndex = virtualScroll ? startIndex + index : index;

		// Check if cache needs to be cleared (synchronous check)
		if (selectedKeys !== cachedSelectedKeysRef ||
			expandedKeys !== cachedExpandedKeysRef ||
			highlightedKey !== cachedHighlightedKeyRef) {
			rowStateCache = new WeakMap();
			cachedSelectedKeysRef = selectedKeys;
			cachedExpandedKeysRef = expandedKeys;
			cachedHighlightedKeyRef = highlightedKey;
		}

		// Try to get cached state
		const cached = rowStateCache.get(item as object);
		if (cached && cached.index === actualIndex) {
			return cached;
		}

		// Create new state object and cache it
		const state: DataGridRowState = {
			isSelected: isSelected(item[keyField]),
			isHighlighted: highlightedKey === item[keyField],
			isSelectable: isItemSelectable(item),
			isExpanded: isExpanded(item[keyField]),
			index: actualIndex
		};

		rowStateCache.set(item as object, state);
		return state;
	}

	// Helper to check if column is resizable
	function isResizable(colId: string): boolean {
		const config = columnConfigMap.get(colId);
		// Fixed columns are not resizable by default, but can be made resizable explicitly
		if (config?.fixed) {
			return config.resizable === true;
		}
		return config?.resizable !== false;
	}

	// Helper to check if column is sortable
	function isSortable(colId: string): boolean {
		const config = columnConfigMap.get(colId);
		return config?.sortable === true;
	}

	// Helper to get sort field
	function getSortField(colId: string): string {
		const config = columnConfigMap.get(colId);
		return config?.sortField ?? colId;
	}

	// Generate skeleton row indices
	const skeletonIndices = $derived(Array.from({ length: skeletonRows }, (_, i) => i));
</script>

{#snippet skeletonContent()}
	<table class="text-sm table-fixed data-grid {className}" style="width: {totalTableWidth}px">
		<thead class="bg-muted sticky top-0 z-10">
			<tr>
				<!-- Fixed start columns -->
				{#each fixedStartCols as colId (colId)}
					<th class="py-2 px-1 font-medium {colId === 'select' ? 'select-col' : ''} {colId === 'expand' ? 'expand-col' : ''}" style="width: {getDisplayWidth(colId)}px"></th>
				{/each}

				<!-- Configurable columns -->
				{#each orderedColumns as colId (colId)}
					{@const colConfig = columnConfigMap.get(colId)}
					{#if colConfig}
						<th class="{colConfig.align === 'right' ? 'text-right' : colConfig.align === 'center' ? 'text-center' : 'text-left'} py-2 px-2 font-medium" style="width: {getDisplayWidth(colId)}px">
							{colConfig.label}
						</th>
					{/if}
				{/each}

				<!-- Fixed end columns (actions) -->
				{#each fixedEndCols as colId (colId)}
					<th class="text-right py-2 px-2 font-medium actions-col" style="width: {getDisplayWidth(colId)}px">
						{#if colId === 'actions'}
							<div class="flex items-center justify-end gap-1">
								<span>Actions</span>
								<ColumnSettingsPopover {gridId} />
							</div>
						{/if}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each skeletonIndices as i (i)}
				<tr class="border-b border-muted">
					<!-- Fixed start columns -->
					{#each fixedStartCols as colId (colId)}
						<td class="py-1.5 px-1 {colId === 'select' ? 'select-col' : ''} {colId === 'expand' ? 'expand-col' : ''}" style="width: {getDisplayWidth(colId)}px">
							<Skeleton class="h-4 w-4" />
						</td>
					{/each}

					<!-- Configurable columns -->
					{#each orderedColumns as colId (colId)}
						{@const colConfig = columnConfigMap.get(colId)}
						{#if colConfig}
							{@const width = getDisplayWidth(colId)}
							<td class="py-1.5 px-2 {colConfig.noTruncate ? 'no-truncate' : ''}" style="width: {width}px">
								<Skeleton class="h-4" style="width: {Math.max(30, Math.min(width - 16, width * 0.7))}px" />
							</td>
						{/if}
					{/each}

					<!-- Fixed end columns -->
					{#each fixedEndCols as colId (colId)}
						<td class="py-1.5 px-2 actions-col" style="width: {getDisplayWidth(colId)}px">
							<Skeleton class="h-4 w-12" />
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
{/snippet}

{#snippet tableHeader()}
	<thead class="bg-muted sticky top-0 z-10">
		<tr>
			<!-- Fixed start columns (select checkbox, expand chevron) -->
			{#each fixedStartCols as colId (colId)}
				{@const colConfig = columnConfigMap.get(colId)}
				<th class="py-2 px-1 font-medium {colId === 'select' ? 'select-col' : ''} {colId === 'expand' ? 'expand-col' : ''}" style="width: {getDisplayWidth(colId)}px">
					{#if colId === 'select' && selectable}
						<button
							type="button"
							onclick={toggleSelectAll}
							class="flex items-center justify-center transition-colors opacity-40 hover:opacity-100 cursor-pointer"
							title={allSelected ? 'Deselect all' : 'Select all'}
						>
							{#if allSelected}
								<CheckSquare class="w-3.5 h-3.5 text-muted-foreground" />
							{:else if someSelected}
								<CheckSquare class="w-3.5 h-3.5 text-muted-foreground" />
							{:else}
								<SquareIcon class="w-3.5 h-3.5 text-muted-foreground" />
							{/if}
						</button>
					{:else if colId === 'expand' && expandable}
						<!-- Expand column header is empty -->
					{:else if headerCell}
						{@render headerCell(colConfig!, sortState)}
					{:else}
						{colConfig?.label ?? ''}
					{/if}
				</th>
			{/each}

			<!-- Configurable columns -->
			{#each orderedColumns as colId (colId)}
				{@const colConfig = columnConfigMap.get(colId)}
				{#if colConfig}
					<th
						class="{colConfig.align === 'right' ? 'text-right' : colConfig.align === 'center' ? 'text-center' : 'text-left'} py-2 px-2 font-medium"
						style="width: {getDisplayWidth(colId)}px"
					>
						{#if headerCell}
							{@render headerCell(colConfig, sortState)}
						{:else if isSortable(colId)}
							<button
								type="button"
								onclick={() => toggleSort(getSortField(colId))}
								class="flex items-center gap-1 hover:text-foreground transition-colors w-full {colConfig.align === 'right' ? 'justify-end' : colConfig.align === 'center' ? 'justify-center' : ''}"
							>
								{colConfig.label}
								{#if sortState?.field === getSortField(colId)}
									{#if sortState.direction === 'asc'}
										<ArrowUp class="w-3 h-3" />
									{:else}
										<ArrowDown class="w-3 h-3" />
									{/if}
								{:else}
									<ArrowUpDown class="w-3 h-3 opacity-30" />
								{/if}
							</button>
						{:else}
							{colConfig.label}
						{/if}

						<!-- Resize handle -->
						{#if isResizable(colId)}
							<div
								class="resize-handle"
								use:columnResize={{
									onResize: (w) => handleResize(colId, w),
									onResizeEnd: (w) => handleResizeEnd(colId, w),
									minWidth: colConfig.minWidth
								}}
							></div>
						{/if}
					</th>
				{/if}
			{/each}

			<!-- Fixed end columns (actions) -->
			{#each fixedEndCols as colId (colId)}
				{@const colConfig = columnConfigMap.get(colId)}
				<th class="text-right py-2 px-2 font-medium actions-col" style="width: {getDisplayWidth(colId)}px">
					{#if colId === 'actions'}
						<div class="flex items-center justify-end gap-1">
							<span>Actions</span>
							<ColumnSettingsPopover {gridId} />
						</div>
					{:else if headerCell}
						{@render headerCell(colConfig!, sortState)}
					{:else}
						{colConfig?.label ?? ''}
					{/if}

					<!-- Resize handle for fixed end columns -->
					{#if isResizable(colId)}
						<div
							class="resize-handle resize-handle-left"
							use:columnResize={{
								onResize: (w) => handleResize(colId, w),
								onResizeEnd: (w) => handleResizeEnd(colId, w),
								minWidth: colConfig?.minWidth
							}}
						></div>
					{/if}
				</th>
			{/each}
		</tr>
	</thead>
{/snippet}

{#snippet tableBody()}
	<tbody>
		{#each visibleData as item, index (item[keyField])}
			{@const rowState = getRowState(item, index)}
			<tr
				class="group cursor-pointer {rowState.isHighlighted ? 'selected' : ''} {rowState.isSelected ? 'checkbox-selected' : ''} {rowState.isExpanded ? 'row-expanded' : ''} {rowClass?.(item) ?? ''}"
				onclick={(e) => onRowClick?.(item, e)}
			>
				<!-- Fixed start columns (select checkbox, expand chevron) -->
				{#each fixedStartCols as colId (colId)}
					{@const colConfig = columnConfigMap.get(colId)}
					<td class="py-1.5 px-1 {colId === 'select' ? 'select-col' : ''} {colId === 'expand' ? 'expand-col' : ''}" style="width: {getDisplayWidth(colId)}px">
						{#if colId === 'select' && selectable}
							{#if rowState.isSelectable}
								<button
									type="button"
									onclick={(e) => {
										e.stopPropagation();
										toggleSelection(item[keyField]);
									}}
									class="flex items-center justify-center w-full h-full min-h-[24px] transition-colors cursor-pointer {rowState.isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-40 hover:!opacity-100'}"
								>
									{#if rowState.isSelected}
										<CheckSquare class="w-3.5 h-3.5 text-muted-foreground" />
									{:else}
										<SquareIcon class="w-3.5 h-3.5 text-muted-foreground" />
									{/if}
								</button>
							{/if}
						{:else if colId === 'expand' && expandable}
							<button
								type="button"
								onclick={(e) => {
									e.stopPropagation();
									toggleExpand(item[keyField]);
								}}
								class="flex items-center justify-center transition-colors cursor-pointer opacity-50 hover:opacity-100"
								title={rowState.isExpanded ? 'Collapse' : 'Expand'}
							>
								{#if rowState.isExpanded}
									<ChevronDown class="w-4 h-4 text-muted-foreground" />
								{:else}
									<ChevronRight class="w-4 h-4 text-muted-foreground" />
								{/if}
							</button>
						{:else if cell}
							{@render cell(colConfig!, item, rowState)}
						{/if}
					</td>
				{/each}

				<!-- Configurable columns -->
				{#each orderedColumns as colId (colId)}
					{@const colConfig = columnConfigMap.get(colId)}
					{#if colConfig}
						<td class="py-1.5 px-2 {colConfig.noTruncate ? 'no-truncate' : ''}" style="width: {getDisplayWidth(colId)}px">
							{#if cell}
								{@render cell(colConfig, item, rowState)}
							{:else}
								<!-- Default: render as text -->
								{String(item[colId as keyof T] ?? '')}
							{/if}
						</td>
					{/if}
				{/each}

				<!-- Fixed end columns (actions) -->
				{#each fixedEndCols as colId (colId)}
					{@const colConfig = columnConfigMap.get(colId)}
					<td class="py-1.5 px-2 text-right actions-col" style="width: {getDisplayWidth(colId)}px" onclick={(e) => e.stopPropagation()}>
						{#if cell}
							{@render cell(colConfig!, item, rowState)}
						{/if}
					</td>
				{/each}
			</tr>

			<!-- Expanded row content -->
			{#if rowState.isExpanded && expandedRow}
				<tr class="expanded-row">
					<td colspan={fixedStartCols.length + orderedColumns.length + fixedEndCols.length}>
						{@render expandedRow(item, rowState)}
					</td>
				</tr>
			{/if}
		{/each}
	</tbody>
{/snippet}

{#snippet tableContent()}
	<table class="text-sm table-fixed data-grid {className}" style="width: {totalTableWidth}px">
		{@render tableHeader()}
		{@render tableBody()}
	</table>
{/snippet}

<div class="flex-1 min-h-0 overflow-auto rounded-lg data-grid-wrapper {wrapperClass}" bind:this={scrollContainer} onscroll={handleScroll}>
	{#if loading && data.length === 0}
		{#if loadingState}
			{@render loadingState()}
		{:else}
			{@render skeletonContent()}
		{/if}
	{:else if data.length === 0 && emptyState}
		{@render emptyState()}
	{:else if virtualScroll}
		<!-- Virtual scroll mode with spacer rows for sticky header support -->
		<table class="text-sm table-fixed data-grid {className}" style="width: {totalTableWidth}px">
			{@render tableHeader()}
			<tbody>
				<!-- Top spacer -->
				{#if offsetY > 0}
					<tr><td colspan={fixedStartCols.length + orderedColumns.length + fixedEndCols.length} style="height: {offsetY}px; padding: 0; border: none;"></td></tr>
				{/if}
				<!-- Visible rows -->
				{#each visibleData as item, index (item[keyField])}
					{@const rowState = getRowState(item, index)}
					<tr
						class="group cursor-pointer {rowState.isHighlighted ? 'selected' : ''} {rowState.isSelected ? 'checkbox-selected' : ''} {rowState.isExpanded ? 'row-expanded' : ''} {rowClass?.(item) ?? ''}"
						onclick={(e) => onRowClick?.(item, e)}
					>
						{#each fixedStartCols as colId (colId)}
							{@const colConfig = columnConfigMap.get(colId)}
							<td class="py-1.5 px-1 {colId === 'select' ? 'select-col' : ''} {colId === 'expand' ? 'expand-col' : ''}" style="width: {getDisplayWidth(colId)}px">
								{#if colId === 'select' && selectable}
									{#if rowState.isSelectable}
										<button
											type="button"
											onclick={(e) => { e.stopPropagation(); toggleSelection(item[keyField]); }}
											class="flex items-center justify-center w-full h-full min-h-[24px] transition-colors cursor-pointer {rowState.isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-40 hover:!opacity-100'}"
										>
											{#if rowState.isSelected}
												<CheckSquare class="w-3.5 h-3.5 text-muted-foreground" />
											{:else}
												<SquareIcon class="w-3.5 h-3.5 text-muted-foreground" />
											{/if}
										</button>
									{/if}
								{:else if colId === 'expand' && expandable}
									<button
										type="button"
										onclick={(e) => { e.stopPropagation(); toggleExpand(item[keyField]); }}
										class="flex items-center justify-center transition-colors cursor-pointer opacity-50 hover:opacity-100"
										title={rowState.isExpanded ? 'Collapse' : 'Expand'}
									>
										{#if rowState.isExpanded}
											<ChevronDown class="w-4 h-4 text-muted-foreground" />
										{:else}
											<ChevronRight class="w-4 h-4 text-muted-foreground" />
										{/if}
									</button>
								{:else if cell}
									{@render cell(colConfig!, item, rowState)}
								{/if}
							</td>
						{/each}
						{#each orderedColumns as colId (colId)}
							{@const colConfig = columnConfigMap.get(colId)}
							{#if colConfig}
								<td class="py-1.5 px-2 {colConfig.noTruncate ? 'no-truncate' : ''}" style="width: {getDisplayWidth(colId)}px">
									{#if cell}
										{@render cell(colConfig, item, rowState)}
									{:else}
										{String(item[colId as keyof T] ?? '')}
									{/if}
								</td>
							{/if}
						{/each}
						{#each fixedEndCols as colId (colId)}
							{@const colConfig = columnConfigMap.get(colId)}
							<td class="py-1.5 px-2 text-right actions-col" style="width: {getDisplayWidth(colId)}px" onclick={(e) => e.stopPropagation()}>
								{#if cell}
									{@render cell(colConfig!, item, rowState)}
								{/if}
							</td>
						{/each}
					</tr>
					{#if rowState.isExpanded && expandedRow}
						<tr class="expanded-row">
							<td colspan={fixedStartCols.length + orderedColumns.length + fixedEndCols.length}>
								{@render expandedRow(item, rowState)}
							</td>
						</tr>
					{/if}
				{/each}
				<!-- Bottom spacer -->
				{#if totalHeight - offsetY - (visibleData.length * rowHeight) > 0}
					<tr><td colspan={fixedStartCols.length + orderedColumns.length + fixedEndCols.length} style="height: {totalHeight - offsetY - (visibleData.length * rowHeight)}px; padding: 0; border: none;"></td></tr>
				{/if}
				<!-- Footer (rendered at the bottom of virtual scroll) -->
				{#if footer}
					<tr><td colspan={fixedStartCols.length + orderedColumns.length + fixedEndCols.length} class="p-0 border-none">{@render footer()}</td></tr>
				{/if}
			</tbody>
		</table>
	{:else}
		<!-- Standard mode -->
		{@render tableContent()}
	{/if}
</div>
