/**
 * DataGrid Component Types
 *
 * Extends the base grid types with component-specific interfaces
 * for the reusable DataGrid component.
 */

import type { Snippet } from 'svelte';
import type { GridId, ColumnConfig, ColumnPreference } from '$lib/types';

// Re-export base types for convenience
export type { GridId, ColumnConfig, ColumnPreference };

/**
 * Sort state for the grid
 */
export interface DataGridSortState {
	field: string;
	direction: 'asc' | 'desc';
}

/**
 * Row state passed to cell snippets
 */
export interface DataGridRowState {
	isSelected: boolean;
	isHighlighted: boolean;
	isSelectable: boolean;
	isExpanded: boolean;
	index: number;
}

/**
 * Main DataGrid component props
 */
export interface DataGridProps<T> {
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

	// Row interaction
	onRowClick?: (item: T, event: MouseEvent) => void;
	highlightedKey?: unknown;
	rowClass?: (item: T) => string;

	// State
	loading?: boolean;

	// CSS
	class?: string;
	wrapperClass?: string;

	// Snippets for customization
	headerCell?: Snippet<[ColumnConfig, DataGridSortState | undefined]>;
	cell?: Snippet<[ColumnConfig, T, DataGridRowState]>;
	emptyState?: Snippet;
	loadingState?: Snippet;
}

/**
 * Context provided to child components
 */
export interface DataGridContext<T = unknown> {
	// Grid configuration
	gridId: GridId;
	keyField: keyof T;

	// Column state
	orderedColumns: string[];
	getDisplayWidth: (colId: string) => number;
	getColumnConfig: (colId: string) => ColumnConfig | undefined;

	// Selection helpers
	selectable: boolean;
	isSelected: (key: unknown) => boolean;
	toggleSelection: (key: unknown) => void;
	selectAll: () => void;
	selectNone: () => void;
	allSelected: boolean;
	someSelected: boolean;

	// Sort helpers
	sortState: DataGridSortState | undefined;
	toggleSort: (colId: string) => void;

	// Resize helpers
	handleResize: (colId: string, width: number) => void;
	handleResizeEnd: (colId: string, width: number) => void;

	// Row state
	highlightedKey: unknown;
}
