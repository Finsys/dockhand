<script lang="ts" module>
	export interface GridItemLayout {
		id: number;
		x: number;
		y: number;
		w: number;
		h: number;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';

	interface Props {
		items: GridItemLayout[];
		cols?: number;
		rowHeight?: number;
		gap?: number;
		minW?: number;
		maxW?: number;
		minH?: number;
		maxH?: number;
		locked?: boolean;
		onchange?: (items: GridItemLayout[]) => void;
		onitemclick?: (id: number) => void;
		children: import('svelte').Snippet<[{ item: GridItemLayout; width: number; height: number }]>;
	}

	let {
		items = $bindable([]),
		cols = 4,
		rowHeight = 175,
		gap = 10,
		minW = 1,
		maxW = 2,
		minH = 1,
		maxH = 4,
		locked = false,
		onchange,
		onitemclick,
		children
	}: Props = $props();

	// Drag threshold - if mouse moves less than this, treat as click
	const DRAG_THRESHOLD = 5;

	let containerRef: HTMLDivElement;
	let containerWidth = $state(0);

	// Calculate column width based on container
	const colWidth = $derived(containerWidth > 0 ? (containerWidth - (cols - 1) * gap) / cols : 280);

	// Calculate max rows based on items
	const maxRow = $derived(
		items.length > 0 ? Math.max(...items.map((item) => item.y + item.h)) : 1
	);

	// Grid height based on content
	const gridHeight = $derived(maxRow * rowHeight + (maxRow - 1) * gap);

	// Dragging state
	let dragItem = $state<GridItemLayout | null>(null);
	let dragStartX = $state(0);
	let dragStartY = $state(0);
	let dragOffsetX = $state(0);
	let dragOffsetY = $state(0);

	// Resizing state
	let resizeItem = $state<GridItemLayout | null>(null);
	let resizeStartW = $state(0);
	let resizeStartH = $state(0);
	let resizeStartX = $state(0);
	let resizeStartY = $state(0);
	// Pixel-based resize offsets for smooth visual feedback
	let resizePixelDeltaX = $state(0);
	let resizePixelDeltaY = $state(0);

	// Preview position during drag/resize
	let previewX = $state(0);
	let previewY = $state(0);
	let previewW = $state(1);
	let previewH = $state(1);

	// Store original positions before drag/resize for real-time displacement
	let originalPositions = $state<Map<number, { x: number; y: number }>>(new Map());
	let lastPreviewX = $state(-1);
	let lastPreviewY = $state(-1);
	let lastPreviewW = $state(-1);
	let lastPreviewH = $state(-1);
	let dragActuallyMoved = $state(false);

	// Convert pixel position to grid units
	function pixelToGrid(px: number, cellSize: number): number {
		return Math.round(px / (cellSize + gap));
	}

	// Convert grid units to pixel position
	function gridToPixel(grid: number, cellSize: number): number {
		return grid * (cellSize + gap);
	}

	// Get item position in pixels
	function getItemStyle(item: GridItemLayout): string {
		const left = gridToPixel(item.x, colWidth);
		const top = gridToPixel(item.y, rowHeight);
		const width = item.w * colWidth + (item.w - 1) * gap;
		const height = item.h * rowHeight + (item.h - 1) * gap;
		return `left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px;`;
	}

	// Check for collisions with other items
	function hasCollision(
		item: GridItemLayout,
		testItem: { x: number; y: number; w: number; h: number }
	): boolean {
		if (item.id === dragItem?.id || item.id === resizeItem?.id) return false;
		return !(
			testItem.x + testItem.w <= item.x ||
			testItem.x >= item.x + item.w ||
			testItem.y + testItem.h <= item.y ||
			testItem.y >= item.y + item.h
		);
	}

	// Find valid position avoiding collisions
	function findValidPosition(
		x: number,
		y: number,
		w: number,
		h: number,
		excludeId: number
	): { x: number; y: number } {
		// Clamp to grid bounds
		x = Math.max(0, Math.min(x, cols - w));
		y = Math.max(0, y);

		const testItem = { x, y, w, h };

		// Check for collisions
		const hasAnyCollision = items.some((item) => item.id !== excludeId && hasCollision(item, testItem));

		if (!hasAnyCollision) {
			return { x, y };
		}

		// If collision, try to find nearby valid position
		for (let offsetY = 0; offsetY <= 10; offsetY++) {
			for (let offsetX = -2; offsetX <= 2; offsetX++) {
				const testX = Math.max(0, Math.min(x + offsetX, cols - w));
				const testY = Math.max(0, y + offsetY);
				const test = { x: testX, y: testY, w, h };
				const collision = items.some((item) => item.id !== excludeId && hasCollision(item, test));
				if (!collision) {
					return { x: testX, y: testY };
				}
			}
		}

		return { x, y };
	}

	// Push colliding items down (returns new array)
	function pushCollidingItems(movedItem: GridItemLayout, sourceItems: GridItemLayout[]): GridItemLayout[] {
		const newItems = sourceItems.map(item => ({ ...item }));
		let changed = true;
		let iterations = 0;
		const maxIterations = 100; // Prevent infinite loops

		while (changed && iterations < maxIterations) {
			changed = false;
			iterations++;
			for (const item of newItems) {
				if (item.id === movedItem.id) continue;

				if (hasCollision(item, movedItem)) {
					// Push this item down
					item.y = movedItem.y + movedItem.h;
					changed = true;
				}
			}
		}

		return newItems;
	}

	// Push items in real-time during drag/resize
	function pushItemsRealTime(ghostItem: { x: number; y: number; w: number; h: number }, excludeId: number) {
		// First restore original positions
		const baseItems = items.map(item => {
			const orig = originalPositions.get(item.id);
			if (orig && item.id !== excludeId) {
				return { ...item, x: orig.x, y: orig.y };
			}
			return { ...item };
		});

		// Then push items based on ghost position
		const movedItem = { ...ghostItem, id: excludeId };
		items = pushCollidingItems(movedItem as GridItemLayout, baseItems);
	}

	// Drag handlers
	function handleDragStart(e: PointerEvent, item: GridItemLayout) {
		if (e.button !== 0) return;
		e.preventDefault();

		if (locked) {
			onitemclick?.(item.id);
			return;
		}

		dragItem = item;
		dragStartX = e.clientX;
		dragStartY = e.clientY;
		dragOffsetX = 0;
		dragOffsetY = 0;
		dragActuallyMoved = false;
		previewX = item.x;
		previewY = item.y;
		previewW = item.w;
		previewH = item.h;
		lastPreviewX = item.x;
		lastPreviewY = item.y;

		// Store original positions for all items
		originalPositions = new Map(items.map(i => [i.id, { x: i.x, y: i.y }]));

		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		window.addEventListener('pointermove', handleDragMove);
		window.addEventListener('pointerup', handleDragEnd);
	}

	function handleDragMove(e: PointerEvent) {
		if (!dragItem) return;

		dragOffsetX = e.clientX - dragStartX;
		dragOffsetY = e.clientY - dragStartY;

		// Check if movement exceeds threshold (for click vs drag detection)
		if (!dragActuallyMoved && (Math.abs(dragOffsetX) > DRAG_THRESHOLD || Math.abs(dragOffsetY) > DRAG_THRESHOLD)) {
			dragActuallyMoved = true;
		}

		// Calculate new grid position
		const startLeft = gridToPixel(dragItem.x, colWidth);
		const startTop = gridToPixel(dragItem.y, rowHeight);
		const newLeft = startLeft + dragOffsetX;
		const newTop = startTop + dragOffsetY;

		const newX = pixelToGrid(newLeft, colWidth);
		const newY = pixelToGrid(newTop, rowHeight);

		// Clamp to valid range
		previewX = Math.max(0, Math.min(newX, cols - dragItem.w));
		previewY = Math.max(0, newY);

		// Push items in real-time if preview position changed
		if (previewX !== lastPreviewX || previewY !== lastPreviewY) {
			lastPreviewX = previewX;
			lastPreviewY = previewY;
			pushItemsRealTime({ x: previewX, y: previewY, w: dragItem.w, h: dragItem.h }, dragItem.id);
		}
	}

	function handleDragEnd(e: PointerEvent) {
		if (!dragItem) return;

		const clickedItemId = dragItem.id;

		// If we didn't actually drag (just clicked), treat as a click
		if (!dragActuallyMoved) {
			window.removeEventListener('pointermove', handleDragMove);
			window.removeEventListener('pointerup', handleDragEnd);
			dragItem = null;
			dragOffsetX = 0;
			dragOffsetY = 0;
			originalPositions = new Map();
			onitemclick?.(clickedItemId);
			return;
		}

		// Update item position (items are already pushed during drag)
		items = items.map((item) =>
			item.id === dragItem!.id ? { ...item, x: previewX, y: previewY } : item
		);

		onchange?.(items);

		window.removeEventListener('pointermove', handleDragMove);
		window.removeEventListener('pointerup', handleDragEnd);
		dragItem = null;
		dragOffsetX = 0;
		dragOffsetY = 0;
		originalPositions = new Map();
	}

	// Resize handlers
	function handleResizeStart(e: PointerEvent, item: GridItemLayout) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();

		resizeItem = item;
		resizeStartW = item.w;
		resizeStartH = item.h;
		resizeStartX = e.clientX;
		resizeStartY = e.clientY;
		resizePixelDeltaX = 0;
		resizePixelDeltaY = 0;
		previewX = item.x;
		previewY = item.y;
		previewW = item.w;
		previewH = item.h;
		lastPreviewW = item.w;
		lastPreviewH = item.h;

		// Store original positions for all items
		originalPositions = new Map(items.map(i => [i.id, { x: i.x, y: i.y }]));

		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		window.addEventListener('pointermove', handleResizeMove);
		window.addEventListener('pointerup', handleResizeEnd);
	}

	function handleResizeMove(e: PointerEvent) {
		if (!resizeItem) return;

		const deltaX = e.clientX - resizeStartX;
		const deltaY = e.clientY - resizeStartY;

		// Track raw pixel delta for smooth visual feedback
		resizePixelDeltaX = deltaX;
		resizePixelDeltaY = deltaY;

		// Calculate new size in grid units
		const newW = Math.round(resizeStartW + deltaX / (colWidth + gap));
		const newH = Math.round(resizeStartH + deltaY / (rowHeight + gap));

		// Clamp to min/max
		previewW = Math.max(minW, Math.min(maxW, newW, cols - resizeItem.x));
		previewH = Math.max(minH, Math.min(maxH, newH));

		// Push items in real-time if preview size changed
		if (previewW !== lastPreviewW || previewH !== lastPreviewH) {
			lastPreviewW = previewW;
			lastPreviewH = previewH;
			pushItemsRealTime({ x: resizeItem.x, y: resizeItem.y, w: previewW, h: previewH }, resizeItem.id);
		}
	}

	function handleResizeEnd(e: PointerEvent) {
		if (!resizeItem) return;

		// Update item size (items are already pushed during resize)
		items = items.map((item) =>
			item.id === resizeItem!.id ? { ...item, w: previewW, h: previewH } : item
		);

		onchange?.(items);

		window.removeEventListener('pointermove', handleResizeMove);
		window.removeEventListener('pointerup', handleResizeEnd);
		resizeItem = null;
		resizePixelDeltaX = 0;
		resizePixelDeltaY = 0;
		originalPositions = new Map();
	}

	// Observe container width
	$effect(() => {
		if (!containerRef) return;

		const observer = new ResizeObserver((entries) => {
			containerWidth = entries[0].contentRect.width;
		});
		observer.observe(containerRef);

		return () => observer.disconnect();
	});
</script>

<div
	class="draggable-grid"
	bind:this={containerRef}
	style="height: {gridHeight}px;"
>
	{#each items as item (item.id)}
		{@const isDragTarget = dragItem?.id === item.id}
		{@const isDragging = isDragTarget && dragActuallyMoved}
		{@const isResizing = resizeItem?.id === item.id}
		{@const isActive = isDragging || isResizing}
		{@const itemWidth = item.w * colWidth + (item.w - 1) * gap}
		{@const itemHeight = item.h * rowHeight + (item.h - 1) * gap}

		<!-- Preview placeholder during drag/resize -->
		{#if isDragging || isResizing}
			<div
				class="grid-item-preview"
				data-size="{isResizing ? previewW : previewW}×{isResizing ? previewH : previewH}"
				style="left: {gridToPixel(isResizing ? item.x : previewX, colWidth)}px; top: {gridToPixel(isResizing ? item.y : previewY, rowHeight)}px; width: {previewW * colWidth + (previewW - 1) * gap}px; height: {previewH * rowHeight + (previewH - 1) * gap}px;"
			></div>
		{/if}

		<!-- Actual item -->
		{@const baseWidth = item.w * colWidth + (item.w - 1) * gap}
		{@const baseHeight = item.h * rowHeight + (item.h - 1) * gap}
		{@const minPixelW = minW * colWidth + (minW - 1) * gap}
		{@const maxPixelW = Math.min(maxW, cols - item.x) * colWidth + (Math.min(maxW, cols - item.x) - 1) * gap}
		{@const minPixelH = minH * rowHeight + (minH - 1) * gap}
		{@const maxPixelH = maxH * rowHeight + (maxH - 1) * gap}
		{@const currentWidth = isResizing ? Math.max(minPixelW, Math.min(maxPixelW, baseWidth + resizePixelDeltaX)) : baseWidth}
		{@const currentHeight = isResizing ? Math.max(minPixelH, Math.min(maxPixelH, baseHeight + resizePixelDeltaY)) : baseHeight}
		<div
			class="grid-item"
			class:dragging={isDragging}
			class:resizing={isResizing}
			style="left: {gridToPixel(item.x, colWidth)}px; top: {gridToPixel(item.y, rowHeight)}px; width: {currentWidth}px; height: {currentHeight}px; {isDragTarget ? `transform: translate(${dragOffsetX}px, ${dragOffsetY}px);` : ''}"
			onpointerdown={(e) => {
				if (locked) {
					e.preventDefault();
					onitemclick?.(item.id);
					return;
				}
				// Check if clicking on resize handle area (bottom-right 28x28 corner)
				const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
				const x = e.clientX - rect.left;
				const y = e.clientY - rect.top;
				const isInResizeArea = x > rect.width - 28 && y > rect.height - 28;

				if (isInResizeArea) {
					handleResizeStart(e, item);
				} else {
					handleDragStart(e, item);
				}
			}}
		>
			<!-- Content -->
			<div class="grid-item-content">
				{@render children({ item, width: itemWidth, height: itemHeight })}
			</div>

			<!-- Resize handle visual indicator -->
			{#if !locked}
				<div class="tile-resize-handle">
					<svg viewBox="0 0 10 10" fill="currentColor">
						<path d="M9 1v8H1" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
					</svg>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.draggable-grid {
		position: relative;
		width: 100%;
		min-height: 300px;
	}

	.grid-item {
		position: absolute;
		backface-visibility: hidden;
		-webkit-backface-visibility: hidden;
		cursor: pointer;
		touch-action: none;
	}

	.grid-item.dragging {
		z-index: 100;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
		cursor: grabbing;
	}

	.grid-item.dragging,
	.grid-item.dragging * {
		cursor: grabbing !important;
	}

	.grid-item.resizing {
		z-index: 100;
	}

	.grid-item.resizing,
	.grid-item.resizing * {
		cursor: grabbing !important;
	}

	.grid-item.dragging *,
	.grid-item.resizing * {
		user-select: none;
		-webkit-user-select: none;
	}

	.grid-item-content {
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.tile-resize-handle {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 28px;
		height: 28px;
		cursor: grab;
		z-index: 20;
		display: flex;
		align-items: flex-end;
		justify-content: flex-end;
		padding: 6px;
		opacity: 0;
		transition: opacity 0.2s ease;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		background: transparent;
	}

	.tile-resize-handle svg {
		width: 12px;
		height: 12px;
		color: hsl(var(--muted-foreground) / 0.6);
		transition: color 0.2s ease;
		pointer-events: none;
	}

	.grid-item:hover .tile-resize-handle {
		opacity: 1;
	}

	.tile-resize-handle:hover svg {
		color: hsl(var(--primary));
	}

	.grid-item-preview {
		position: absolute;
		background: hsl(var(--primary) / 0.12);
		border: 2px dashed hsl(var(--primary) / 0.6);
		border-radius: 8px;
		z-index: 0;
		transition: left 0.15s ease, top 0.15s ease, width 0.15s ease, height 0.15s ease;
		box-shadow:
			inset 0 0 20px hsl(var(--primary) / 0.1),
			0 0 15px hsl(var(--primary) / 0.15);
	}

	.grid-item-preview::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: 6px;
		background: repeating-linear-gradient(
			45deg,
			transparent,
			transparent 8px,
			hsl(var(--primary) / 0.05) 8px,
			hsl(var(--primary) / 0.05) 16px
		);
		animation: stripes 0.5s linear infinite;
	}

	@keyframes stripes {
		0% {
			background-position: 0 0;
		}
		100% {
			background-position: 22.6px 0;
		}
	}

	/* Size indicator badge on preview */
	.grid-item-preview::after {
		content: attr(data-size);
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: hsl(var(--primary));
		color: hsl(var(--primary-foreground));
		padding: 4px 10px;
		border-radius: 6px;
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
	}
</style>
