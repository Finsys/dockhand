<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Loader2, FolderOpen, File, FileText, ChevronRight, ArrowUp, AlertCircle, FolderPlus, Search, Import } from 'lucide-svelte';
	import type { Component } from 'svelte';
	import RecentLocationsPanel from './RecentLocationsPanel.svelte';

	export interface FileEntry {
		name: string;
		path: string;
		type: 'file' | 'directory' | 'symlink';
		size: number;
		mtime: string;
		mode: string;
	}

	interface Props {
		open: boolean;
		title?: string;
		/** Optional icon component to display before the title */
		icon?: Component<{ class?: string }>;
		description?: string;
		initialPath?: string;
		selectFilter?: RegExp;
		selectMode?: 'file' | 'directory' | 'file_or_directory' | 'adopt';
		/** For adopt mode: filter to highlight (e.g., /\.ya?ml$/i for compose files) */
		highlightFilter?: RegExp;
		/** For adopt mode: called when user clicks on a matching file */
		onFilePreview?: (entry: FileEntry) => void;
		/** For adopt mode: called when user clicks "Scan this folder" */
		onScanDirectory?: (path: string) => void;
		/** For adopt mode: show loading state on scan button */
		scanning?: boolean;
		onSelect: (path: string, name: string) => void;
		onClose: () => void;
	}

	let {
		open = $bindable(false),
		title = 'Select file',
		icon,
		description,
		initialPath = '/',
		selectFilter,
		selectMode = 'file',
		highlightFilter,
		onFilePreview,
		onScanDirectory,
		scanning = false,
		onSelect,
		onClose
	}: Props = $props();

	let currentPath = $state<string | null>(null);
	let entries = $state<FileEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Track selected file
	let selectedPath = $state<string | null>(null);
	let selectedName = $state<string | null>(null);

	// Reference to recent locations panel
	let recentLocationsPanel = $state<{ addLocation: (path: string) => Promise<void>; getFirstLocation: () => string | null } | null>(null);

	// Expose methods for parent to call
	export function getCurrentPath(): string | null {
		return currentPath;
	}

	export function addRecentLocation(path: string): Promise<void> {
		return recentLocationsPanel?.addLocation(path) ?? Promise.resolve();
	}

	// Load directory when dialog opens
	$effect(() => {
		if (open && !currentPath) {
			// Wait a tick for the panel to load, then use first location or initialPath
			setTimeout(() => {
				const firstLocation = recentLocationsPanel?.getFirstLocation();
				loadDirectory(firstLocation || initialPath);
			}, 50);
		}
	});

	function handleRecentSelect(path: string) {
		loadDirectory(path);
	}

	async function loadDirectory(path: string) {
		loading = true;
		error = null;

		try {
			const res = await fetch(`/api/system/files?path=${encodeURIComponent(path)}`);
			const data = await res.json();

			if (!res.ok) {
				error = data.error || 'Failed to load directory';
				return;
			}

			currentPath = data.path;
			entries = data.entries;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load directory';
		} finally {
			loading = false;
		}
	}

	function handleEntryClick(entry: FileEntry, doubleClick: boolean = false) {
		if (selectMode === 'adopt') {
			// Adopt mode: click on directory navigates, click on highlighted file triggers preview
			if (entry.type === 'directory') {
				loadDirectory(entry.path);
			} else if (highlightFilter?.test(entry.name) && onFilePreview) {
				onFilePreview(entry);
			}
			return;
		}

		if (entry.type === 'directory') {
			if (selectMode === 'file_or_directory' && !doubleClick) {
				// Single click on directory in file_or_directory mode - select it
				selectedPath = entry.path;
				selectedName = entry.name;
			} else {
				// Double click or other modes - navigate into directory
				selectedPath = null;
				selectedName = null;
				loadDirectory(entry.path);
			}
		} else if (selectMode === 'file' || selectMode === 'file_or_directory') {
			// Select file
			selectedPath = entry.path;
			selectedName = entry.name;
		}
	}

	function handleGoUp() {
		if (!currentPath || currentPath === '/') return;

		const parent = currentPath.replace(/\/[^/]+$/, '') || '/';
		selectedPath = null;
		selectedName = null;
		loadDirectory(parent);
	}

	function handleConfirm() {
		if (selectMode === 'directory' && currentPath) {
			// In directory mode, select the current directory
			const name = currentPath === '/' ? '/' : currentPath.split('/').pop() || '';
			onSelect(currentPath, name);
			handleClose();
		} else if (selectedPath && selectedName) {
			// In file or file_or_directory mode, select the selected item
			onSelect(selectedPath, selectedName);
			handleClose();
		} else if (selectMode === 'file_or_directory' && currentPath) {
			// In file_or_directory mode with nothing selected, use current directory
			const name = currentPath === '/' ? '/' : currentPath.split('/').pop() || '';
			onSelect(currentPath, name);
			handleClose();
		}
	}

	function handleClose() {
		currentPath = null;
		entries = [];
		selectedPath = null;
		selectedName = null;
		error = null;
		open = false;
		onClose();
	}

	function handleScan() {
		if (currentPath && onScanDirectory) {
			onScanDirectory(currentPath);
		}
	}

	function isSelectable(entry: FileEntry): boolean {
		if (selectMode === 'adopt') {
			// In adopt mode, nothing is "selectable" in the traditional sense
			return false;
		}
		if (selectMode === 'directory') {
			return entry.type === 'directory';
		}
		if (selectMode === 'file_or_directory') {
			// Directories are always selectable, files must match filter
			if (entry.type === 'directory') return true;
			if (!selectFilter) return true;
			return selectFilter.test(entry.name);
		}
		// File mode
		if (entry.type === 'directory') return false;
		if (!selectFilter) return true;
		return selectFilter.test(entry.name);
	}

	function isHighlighted(entry: FileEntry): boolean {
		if (entry.type === 'directory') return false;
		if (!highlightFilter) return false;
		return highlightFilter.test(entry.name);
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	const canGoUp = $derived(currentPath && currentPath !== '/');

	// In directory mode, only show directories; otherwise show all
	const filteredEntries = $derived(
		selectMode === 'directory'
			? entries.filter(e => e.type === 'directory')
			: entries
	);

	const isAdoptMode = $derived(selectMode === 'adopt');
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
	<Dialog.Content class="max-w-4xl h-[80vh] flex flex-col {isAdoptMode ? 'p-0 gap-0' : ''}">
		<Dialog.Header class={isAdoptMode ? 'px-6 py-4 border-b shrink-0' : ''}>
			<Dialog.Title class="flex items-center gap-2">
				{#if icon}
					<svelte:component this={icon} class="w-5 h-5" />
				{/if}
				{title}
			</Dialog.Title>
			{#if description}
				<Dialog.Description>{description}</Dialog.Description>
			{/if}
		</Dialog.Header>

		<div class="flex-1 overflow-hidden flex {isAdoptMode ? 'min-h-0' : ''}">
			<!-- Recent locations sidebar -->
			<RecentLocationsPanel
				bind:this={recentLocationsPanel}
				{currentPath}
				onSelect={handleRecentSelect}
			/>

			<!-- Main browser area -->
			<div class="flex-1 flex flex-col min-h-0">
				<!-- Path bar -->
				<div class="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
					<button
						type="button"
						class="p-1 rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
						disabled={!canGoUp}
						onclick={handleGoUp}
						title="Go up"
					>
						<ArrowUp class="w-4 h-4" />
					</button>
					<code class="text-xs bg-muted px-2 py-1 rounded truncate flex-1">{currentPath || '/'}</code>
					{#if isAdoptMode}
						<Button
							variant="default"
							size="sm"
							onclick={handleScan}
							disabled={scanning || !currentPath}
						>
							{#if scanning}
								<Loader2 class="w-4 h-4 animate-spin" />
								Scanning...
							{:else}
								<Search class="w-4 h-4" />
								Scan this folder
							{/if}
						</Button>
					{/if}
				</div>

				<!-- File list -->
				<div class="flex-1 overflow-auto">
				{#if loading}
					<div class="flex items-center justify-center py-12">
						<Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
					</div>
				{:else if error}
					<div class="flex flex-col items-center justify-center py-12 px-4 text-center">
						<div class="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
							<AlertCircle class="w-8 h-8 text-red-500" />
						</div>
						<p class="text-red-600 dark:text-red-400 font-medium">Unable to browse files</p>
						<p class="text-sm text-muted-foreground mt-1">{error}</p>
						<Button variant="outline" size="sm" class="mt-4" onclick={() => currentPath && loadDirectory(currentPath)}>
							Retry
						</Button>
					</div>
				{:else if filteredEntries.length === 0}
					<div class="flex flex-col items-center justify-center py-12 text-muted-foreground">
						<FolderOpen class="w-12 h-12 mb-3 opacity-50" />
						<p>{selectMode === 'directory' ? 'No subdirectories' : 'Directory is empty'}</p>
					</div>
				{:else}
					<div class="divide-y">
						{#each filteredEntries as entry}
							{@const selectable = isSelectable(entry)}
							{@const highlighted = isHighlighted(entry)}
							<button
								type="button"
								class="w-full flex items-center gap-3 px-4 {isAdoptMode ? 'py-1.5' : 'py-2'} hover:bg-muted/50 text-left transition-colors
									{entry.type === 'directory' ? 'cursor-pointer' : (selectable || highlighted) ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}
									{selectedPath === entry.path ? 'bg-blue-50 dark:bg-blue-900/20' : ''}"
								onclick={() => (entry.type === 'directory' || selectable || highlighted) && handleEntryClick(entry, false)}
								ondblclick={() => entry.type === 'directory' && handleEntryClick(entry, true)}
								disabled={entry.type !== 'directory' && !selectable && !highlighted}
							>
								{#if entry.type === 'directory'}
									<FolderOpen class="w-4 h-4 text-blue-500 shrink-0" />
								{:else if highlighted}
									<FileText class="w-4 h-4 text-green-500 shrink-0" />
								{:else}
									<File class="w-4 h-4 text-zinc-400 shrink-0 {selectable ? 'text-green-500' : ''}" />
								{/if}
								<span class="flex-1 truncate {isAdoptMode ? 'text-xs' : 'text-sm'} {(selectable || highlighted) && entry.type !== 'directory' ? 'text-green-600 dark:text-green-400 font-medium' : ''}">
									{entry.name}
								</span>
								{#if highlighted && isAdoptMode}
									<Badge variant="secondary" class="text-xs">Compose file</Badge>
								{:else if entry.type !== 'directory' && !isAdoptMode}
									<span class="text-xs text-muted-foreground">{formatSize(entry.size)}</span>
								{/if}
								{#if entry.type === 'directory'}
									<ChevronRight class="w-4 h-4 text-muted-foreground" />
								{/if}
							</button>
						{/each}
					</div>
				{/if}
				</div>
			</div>
		</div>

		{#if !isAdoptMode}
			<Dialog.Footer class="border-t pt-4">
				{#if selectMode === 'directory'}
					<div class="flex-1 flex items-center gap-2 min-w-0">
						<span class="text-xs text-muted-foreground shrink-0">Selected:</span>
						<code class="text-xs font-mono bg-muted px-2 py-1 rounded truncate" title={currentPath || '/'}>{currentPath || '/'}</code>
					</div>
				{:else if selectMode === 'file_or_directory'}
					<div class="flex-1 flex items-center gap-2 min-w-0">
						{#if selectedPath}
							<span class="text-xs text-muted-foreground shrink-0">Selected:</span>
							<code class="text-xs font-mono bg-muted px-2 py-1 rounded truncate" title={selectedPath}>{selectedPath}</code>
						{:else}
							<span class="text-xs text-muted-foreground">Click to select file or folder, double-click to enter folder</span>
						{/if}
					</div>
				{:else if selectedPath}
					<div class="flex-1 flex items-center gap-2 min-w-0">
						<span class="text-xs text-muted-foreground shrink-0">Selected:</span>
						<code class="text-xs font-mono bg-muted px-2 py-1 rounded truncate" title={selectedPath}>{selectedPath}</code>
					</div>
				{:else}
					<div class="flex-1 text-xs text-muted-foreground">
						Click a file to select it
					</div>
				{/if}
				<Button variant="outline" onclick={handleClose}>
					Cancel
				</Button>
				{#if selectMode === 'directory'}
					<Button onclick={handleConfirm}>
						<FolderPlus class="w-4 h-4" />
						Select
					</Button>
				{:else if selectMode === 'file_or_directory'}
					<Button onclick={handleConfirm}>
						Select
					</Button>
				{:else}
					<Button
						disabled={!selectedPath}
						onclick={handleConfirm}
					>
						Select
					</Button>
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
