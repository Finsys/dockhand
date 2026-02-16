<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Check, X, Loader2, Circle, Ban } from 'lucide-svelte';
	import { onDestroy } from 'svelte';

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	}

	const progressText: Record<string, string> = {
		remove: 'removing',
		start: 'starting',
		stop: 'stopping',
		restart: 'restarting',
		down: 'stopping'
	};

	// Local type definitions (matching server types)
	type ItemStatus = 'pending' | 'processing' | 'success' | 'error' | 'cancelled';

	type BatchEvent =
		| { type: 'start'; total: number }
		| { type: 'progress'; id: string; name: string; status: ItemStatus; message?: string; error?: string; current: number; total: number }
		| { type: 'complete'; summary: { total: number; success: number; failed: number } }
		| { type: 'error'; error: string };

	interface Props {
		open: boolean;
		title: string;
		operation: string;
		entityType: 'containers' | 'images' | 'volumes' | 'networks' | 'stacks';
		items: Array<{ id: string; name: string }>;
		envId?: number;
		options?: Record<string, any>;
		totalSize?: number;
		onClose: () => void;
		onComplete: () => void;
	}

	let {
		open = $bindable(),
		title,
		operation,
		entityType,
		items,
		envId,
		options = {},
		totalSize,
		onClose,
		onComplete
	}: Props = $props();

	// State
	type ItemState = {
		id: string;
		name: string;
		status: ItemStatus;
		error?: string;
	};

	let itemStates = $state<ItemState[]>([]);
	let isRunning = $state(false);
	let isComplete = $state(false);
	let successCount = $state(0);
	let failCount = $state(0);
	let cancelledCount = $state(0);
	let abortController: AbortController | null = null;

	// Progress calculation
	const progress = $derived(() => {
		if (itemStates.length === 0) return 0;
		const completed = itemStates.filter(i => i.status === 'success' || i.status === 'error' || i.status === 'cancelled').length;
		return Math.round((completed / itemStates.length) * 100);
	});

	// Initialize when modal opens
	$effect(() => {
		if (open && items.length > 0 && !isRunning && !isComplete) {
			startOperation();
		}
	});

	// Cleanup on destroy
	onDestroy(() => {
		if (abortController) {
			abortController.abort();
		}
	});

	async function startOperation() {
		// Initialize item states
		itemStates = items.map(item => ({
			id: item.id,
			name: item.name,
			status: 'pending' as ItemStatus
		}));

		isRunning = true;
		isComplete = false;
		successCount = 0;
		failCount = 0;
		cancelledCount = 0;

		abortController = new AbortController();

		try {
			const response = await fetch(`/api/batch${envId ? `?env=${envId}` : ''}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					operation,
					entityType,
					items,
					options
				}),
				signal: abortController.signal
			});

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || 'Request failed');
			}

			if (!response.body) {
				throw new Error('No response body');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						try {
							const event: BatchEvent = JSON.parse(line.slice(6));
							handleEvent(event);
						} catch {
							// Ignore parse errors
						}
					}
				}
			}
		} catch (error: any) {
			if (error.name === 'AbortError') {
				// User cancelled - mark remaining as cancelled
				let cancelled = 0;
				itemStates = itemStates.map(item => {
					if (item.status === 'pending' || item.status === 'processing') {
						cancelled++;
						return { ...item, status: 'cancelled' as ItemStatus };
					}
					return item;
				});
				cancelledCount = cancelled;
			} else {
				console.error('Batch operation error:', error);
			}
		} finally {
			isRunning = false;
			isComplete = true;
			abortController = null;
		}
	}

	function handleEvent(event: BatchEvent) {
		switch (event.type) {
			case 'progress':
				itemStates = itemStates.map(item =>
					item.id === event.id
						? { ...item, status: event.status, error: event.error }
						: item
				);
				if (event.status === 'success') successCount++;
				if (event.status === 'error') failCount++;
				break;
			case 'complete':
				successCount = event.summary.success;
				failCount = event.summary.failed;
				break;
		}
	}

	function handleCancel() {
		if (abortController) {
			abortController.abort();
		}
	}

	function handleClose() {
		if (isRunning) {
			// Confirm before closing during operation
			if (!confirm('Operation is still running. Cancel and close?')) {
				return;
			}
			handleCancel();
		}
		open = false;
		// Reset state for next use
		itemStates = [];
		isRunning = false;
		isComplete = false;
		successCount = 0;
		failCount = 0;
		cancelledCount = 0;
		onClose();
		if (isComplete) {
			onComplete();
		}
	}

	function handleOk() {
		open = false;
		itemStates = [];
		isRunning = false;
		isComplete = false;
		successCount = 0;
		failCount = 0;
		cancelledCount = 0;
		onClose();
		onComplete();
	}
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => !isOpen && handleClose()}>
	<Dialog.Content class="w-full max-w-lg" onInteractOutside={(e) => isRunning && e.preventDefault()}>
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>
				{#if isRunning}
					Processing {items.length} {entityType}...
				{:else if isComplete}
					Completed: {successCount} succeeded{#if failCount > 0}, {failCount} failed{/if}{#if cancelledCount > 0}, {cancelledCount} cancelled{/if}{#if totalSize && successCount > 0} ({formatBytes(totalSize)}){/if}
				{:else}
					Preparing to {operation} {items.length} {entityType}...
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<!-- Progress bar -->
		<div class="py-2">
			<Progress value={progress()} class="h-2" />
			<div class="text-xs text-muted-foreground mt-1 text-right">
				{progress()}%
			</div>
		</div>

		<!-- Items list -->
		<div class="max-h-80 overflow-y-auto border rounded-md">
			{#each itemStates as item (item.id)}
				<div class="px-3 py-2 border-b last:border-b-0 text-sm {item.status === 'error' ? 'bg-red-50 dark:bg-red-950/20' : ''} {item.status === 'cancelled' ? 'bg-amber-50 dark:bg-amber-950/20' : ''}">
					<div class="flex items-center gap-2">
						<!-- Status icon -->
						<div class="w-5 h-5 flex items-center justify-center flex-shrink-0">
							{#if item.status === 'pending'}
								<Circle class="w-4 h-4 text-muted-foreground" />
							{:else if item.status === 'processing'}
								<Loader2 class="w-4 h-4 text-blue-500 animate-spin" />
							{:else if item.status === 'success'}
								<Check class="w-4 h-4 text-green-500" />
							{:else if item.status === 'error'}
								<X class="w-4 h-4 text-red-500" />
							{:else if item.status === 'cancelled'}
								<Ban class="w-4 h-4 text-amber-500" />
							{/if}
						</div>

						<!-- Item name -->
						<span class="flex-1 truncate font-mono text-xs" title={item.name}>
							{item.name}
						</span>

						<!-- Status text -->
						<span class="text-xs text-muted-foreground flex-shrink-0">
							{#if item.status === 'pending'}
								pending
							{:else if item.status === 'processing'}
								{progressText[operation] ?? operation}...
							{:else if item.status === 'success'}
								done
							{:else if item.status === 'error'}
								<span class="text-red-500">failed</span>
							{:else if item.status === 'cancelled'}
								<span class="text-amber-500">cancelled</span>
							{/if}
						</span>
					</div>
					<!-- Error message on separate line -->
					{#if item.status === 'error' && item.error}
						<div class="mt-1 ml-7 text-xs text-red-600 dark:text-red-400 break-words">
							{item.error}
						</div>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Footer: Summary + Button in one row -->
		<div class="flex items-center justify-between pt-2">
			<div class="flex items-center gap-3 text-sm">
				<div class="flex items-center gap-1" title="Succeeded">
					<Check class="w-4 h-4 text-green-500" />
					<span class="tabular-nums">{successCount}</span>
				</div>
				<div class="flex items-center gap-1" title="Failed">
					<X class="w-4 h-4 text-red-500" />
					<span class="tabular-nums">{failCount}</span>
				</div>
				<div class="flex items-center gap-1" title="Cancelled">
					<Ban class="w-4 h-4 text-amber-500" />
					<span class="tabular-nums">{cancelledCount}</span>
				</div>
				<div class="flex items-center gap-1 text-muted-foreground" title="Pending">
					<Circle class="w-4 h-4" />
					<span class="tabular-nums">{items.length - successCount - failCount - cancelledCount}</span>
				</div>
			</div>
			{#if isRunning}
				<Button variant="outline" size="sm" onclick={handleCancel}>
					Cancel
				</Button>
			{:else}
				<Button size="sm" onclick={handleOk}>
					OK
				</Button>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
