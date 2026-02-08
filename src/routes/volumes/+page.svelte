<svelte:head>
	<title>Volumes - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Trash2, Search, Plus, Eye, Check, XCircle, RefreshCw, Icon, AlertTriangle, X, HardDrive, Stamp, FolderOpen, Download, Database, Server, CircleDot, Circle } from 'lucide-svelte';
	import { broom } from '@lucide/lab';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import BatchOperationModal from '$lib/components/BatchOperationModal.svelte';
	import CreateVolumeModal from './CreateVolumeModal.svelte';
	import VolumeInspectModal from './VolumeInspectModal.svelte';
	import VolumeBrowserModal from './VolumeBrowserModal.svelte';
	import CloneVolumeModal from './CloneVolumeModal.svelte';
	import ContainerInspectModal from '../containers/ContainerInspectModal.svelte';
	import { appSettings } from '$lib/stores/settings';
	import type { VolumeInfo } from '$lib/types';
	import { currentEnvironment, environments, appendEnvParam, clearStaleEnvironment } from '$lib/stores/environment';
	import MultiSelectFilter from '$lib/components/MultiSelectFilter.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { onDockerEvent, isVolumeListChange } from '$lib/stores/events';
	import { canAccess } from '$lib/stores/auth';
	import { formatDateTime } from '$lib/stores/settings';
	import { EmptyState, NoEnvironment } from '$lib/components/ui/empty-state';
	import { DataGrid } from '$lib/components/data-grid';

	type SortField = 'name' | 'driver' | 'stack' | 'created';
	type SortDirection = 'asc' | 'desc';

	let volumes = $state<VolumeInfo[]>([]);
	let loading = $state(true);
	let envId = $state<number | null>(null);

	// Polling interval - module scope for cleanup in onDestroy
	let refreshInterval: ReturnType<typeof setInterval> | null = null;
	let unsubscribeDockerEvent: (() => void) | null = null;

	// Search and sort state - with debounce
	let searchInput = $state('');
	let searchQuery = $state('');
	let sortField = $state<SortField>('name');
	let sortDirection = $state<SortDirection>('asc');

	// Filter state
	let driverFilter = $state<string[]>([]);
	let usageFilter = $state<string[]>([]);

	// Driver icon mapping
	const driverIconMap: Record<string, { icon: any; color: string }> = {
		local: { icon: Database, color: 'text-emerald-500' },
		nfs: { icon: Server, color: 'text-sky-500' },
		cifs: { icon: Server, color: 'text-sky-500' },
		tmpfs: { icon: Database, color: 'text-amber-500' }
	};

	// Available filter options (derived from current volumes)
	const driverOptions = $derived(
		[...new Set(volumes.map(v => v.driver))].sort().map(d => {
			const mapping = driverIconMap[d] || { icon: Database, color: 'text-muted-foreground' };
			return { value: d, label: d, icon: mapping.icon, color: mapping.color };
		})
	);

	// Usage filter options (static)
	const usageOptions = [
		{ value: 'in-use', label: 'In use', icon: CircleDot, color: 'text-emerald-500' },
		{ value: 'unused', label: 'Unused', icon: Circle, color: 'text-muted-foreground' }
	];

	// Confirmation popover state
	let confirmDeleteName = $state<string | null>(null);

	// Delete error state
	let deleteError = $state<{ name: string; message: string } | null>(null);

	// Timeout tracking for cleanup
	let pendingTimeouts: ReturnType<typeof setTimeout>[] = [];

	// Multi-select state
	let selectedVolumes = $state<Set<string>>(new Set());
	let confirmBulkRemove = $state(false);

	// Row highlighting state
	let highlightedRowId = $state<string | null>(null);

	// Batch operation modal state
	let showBatchOpModal = $state(false);
	let batchOpTitle = $state('');
	let batchOpOperation = $state('');
	let batchOpItems = $state<Array<{ id: string; name: string }>>([]);

	// Check if all filtered volumes are selected
	const allFilteredSelected = $derived(
		filteredVolumes.length > 0 && filteredVolumes.every(v => selectedVolumes.has(v.name))
	);
	const someFilteredSelected = $derived(
		filteredVolumes.some(v => selectedVolumes.has(v.name)) && !allFilteredSelected
	);
	const selectedInFilter = $derived(
		filteredVolumes.filter(v => selectedVolumes.has(v.name))
	);

	function selectNone() {
		selectedVolumes = new Set();
	}

	function bulkRemove() {
		batchOpTitle = `Removing ${selectedInFilter.length} volume${selectedInFilter.length !== 1 ? 's' : ''}`;
		batchOpOperation = 'remove';
		batchOpItems = selectedInFilter.map(v => ({ id: v.name, name: v.name }));
		showBatchOpModal = true;
	}

	function handleBatchComplete() {
		selectedVolumes = new Set();
		fetchVolumes();
	}

	// Modal state
	let showCreateModal = $state(false);
	let showInspectModal = $state(false);
	let inspectVolumeName = $state('');
	let showBrowserModal = $state(false);
	let browseVolumeName = $state('');
	let showCloneModal = $state(false);
	let cloneVolumeName = $state('');
	let exportingVolume = $state<string | null>(null);

	// Container inspect modal state
	let showContainerInspectModal = $state(false);
	let inspectContainerId = $state('');
	let inspectContainerName = $state('');

	// Prune state
	let confirmPrune = $state(false);
	let pruneStatus = $state<'idle' | 'pruning' | 'success' | 'error'>('idle');

	// Debounce search input
	let searchTimeout: ReturnType<typeof setTimeout>;
	$effect(() => {
		const input = searchInput; // Track dependency
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			searchQuery = input;
		}, 200);
		return () => clearTimeout(searchTimeout);
	});

	// Track if initial fetch has been done
	let initialFetchDone = $state(false);

	// Subscribe to environment changes using $effect
	$effect(() => {
		const env = $currentEnvironment;
		const newEnvId = env?.id ?? null;

		// Only fetch if environment actually changed or this is initial load
		if (env && (newEnvId !== envId || !initialFetchDone)) {
			envId = newEnvId;
			initialFetchDone = true;
			fetchVolumes();
		} else if (!env) {
			// No environment - clear data and stop loading
			envId = null;
			volumes = [];
			loading = false;
		}
	});

	// Filtered and sorted volumes - use $derived.by for complex logic
	const filteredVolumes = $derived.by(() => {
		let result = volumes;

		// Filter by driver
		if (driverFilter.length > 0) {
			result = result.filter(vol => driverFilter.includes(vol.driver));
		}

		// Filter by usage
		if (usageFilter.length > 0) {
			result = result.filter(vol => {
				const isInUse = vol.usedBy && vol.usedBy.length > 0;
				if (usageFilter.includes('in-use') && usageFilter.includes('unused')) {
					return true; // Both selected = show all
				}
				if (usageFilter.includes('in-use')) {
					return isInUse;
				}
				if (usageFilter.includes('unused')) {
					return !isInUse;
				}
				return true;
			});
		}

		// Filter by search query
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			result = result.filter(vol =>
				vol.name.toLowerCase().includes(query) ||
				(vol.labels['com.docker.compose.project'] || '').toLowerCase().includes(query)
			);
		}

		// Sort
		result = [...result].sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case 'name':
					cmp = a.name.localeCompare(b.name);
					break;
				case 'driver':
					cmp = a.driver.localeCompare(b.driver);
					break;
				case 'stack':
					const stackA = a.labels['com.docker.compose.project'] || '';
					const stackB = b.labels['com.docker.compose.project'] || '';
					cmp = stackA.localeCompare(stackB);
					break;
				case 'created':
					cmp = new Date(a.created).getTime() - new Date(b.created).getTime();
					break;
			}
			// Secondary sort by name for stability when primary values are equal
			if (cmp === 0 && sortField !== 'name') {
				cmp = a.name.localeCompare(b.name);
			}
			return sortDirection === 'asc' ? cmp : -cmp;
		});

		return result;
	});


	async function fetchVolumes() {
		loading = true;
		try {
			const response = await fetch(appendEnvParam('/api/volumes', envId));
			if (!response.ok) {
				// Handle stale environment ID (e.g., after database reset)
				if (response.status === 404 && envId) {
					clearStaleEnvironment(envId);
					environments.refresh();
					return;
				}
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			volumes = await response.json();
		} catch (error) {
			console.error('Failed to fetch volumes:', error);
			toast.error('Failed to load volumes');
		} finally {
			loading = false;
		}
	}

	async function removeVolume(name: string) {
		deleteError = null;
		try {
			const response = await fetch(appendEnvParam(`/api/volumes/${encodeURIComponent(name)}?force=true`, envId), { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json();
				deleteError = { name, message: data.details || data.error || 'Failed to remove volume' };
				toast.error(`Failed to remove ${name}`);
				// Auto-hide error after 5 seconds
				pendingTimeouts.push(setTimeout(() => {
					if (deleteError?.name === name) deleteError = null;
				}, 5000));
				return;
			}
			toast.success(`Removed ${name}`);
			await fetchVolumes();
		} catch (error) {
			console.error('Failed to remove volume:', error);
			deleteError = { name, message: 'Failed to remove volume' };
			toast.error(`Failed to remove ${name}`);
			pendingTimeouts.push(setTimeout(() => {
				if (deleteError?.name === name) deleteError = null;
			}, 5000));
		}
	}

	function formatDate(dateString: string): string {
		if (!dateString) return 'N/A';
		return formatDateTime(dateString);
	}

	function inspectVolume(volumeName: string) {
		inspectVolumeName = volumeName;
		showInspectModal = true;
	}

	function browseVolume(volumeName: string) {
		browseVolumeName = volumeName;
		showBrowserModal = true;
	}

	function cloneVolume(volumeName: string) {
		cloneVolumeName = volumeName;
		showCloneModal = true;
	}

	function openContainerInspect(containerId: string, containerName: string) {
		inspectContainerId = containerId;
		inspectContainerName = containerName;
		showContainerInspectModal = true;
	}

	async function exportVolume(volumeName: string) {
		exportingVolume = volumeName;
		try {
			const format = $appSettings.downloadFormat || 'tar';
			const url = appendEnvParam(
				`/api/volumes/${encodeURIComponent(volumeName)}/export?path=/&format=${format}`,
				envId
			);

			const link = document.createElement('a');
			link.href = url;
			link.download = '';
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);

			toast.success(`Exporting ${volumeName}...`);
		} catch (err) {
			console.error('Failed to export volume:', err);
			toast.error(`Failed to export ${volumeName}`);
		} finally {
			pendingTimeouts.push(setTimeout(() => {
				if (exportingVolume === volumeName) exportingVolume = null;
			}, 2000));
		}
	}

	async function pruneVolumes() {
		pruneStatus = 'pruning';
		confirmPrune = false;
		try {
			const response = await fetch(appendEnvParam('/api/prune/volumes', envId), {
				method: 'POST'
			});
			if (response.ok) {
				pruneStatus = 'success';
				toast.success('Unused volumes pruned');
				await fetchVolumes();
			} else {
				pruneStatus = 'error';
				toast.error('Failed to prune volumes');
			}
		} catch (error) {
			pruneStatus = 'error';
			toast.error('Failed to prune volumes');
		}
		pendingTimeouts.push(setTimeout(() => {
			pruneStatus = 'idle';
		}, 3000));
	}


	// Handle tab visibility changes (e.g., user switches back from another tab)
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible' && envId) {
			fetchVolumes();
		}
	}

	onMount(() => {
		// Initial fetch is handled by $effect - no need to duplicate here

		// Listen for tab visibility changes to refresh when user returns
		document.addEventListener('visibilitychange', handleVisibilityChange);
		document.addEventListener('resume', handleVisibilityChange);

		// Subscribe to volume events (SSE connection is global in layout)
		unsubscribeDockerEvent = onDockerEvent((event) => {
			if (envId && isVolumeListChange(event)) {
				fetchVolumes();
			}
		});

		refreshInterval = setInterval(() => {
			if (envId) fetchVolumes();
		}, 30000);

		// Note: In Svelte 5, cleanup must be in onDestroy, not returned from onMount
	});

	// Cleanup on component destroy
	onDestroy(() => {
		// Clear polling interval
		if (refreshInterval) {
			clearInterval(refreshInterval);
			refreshInterval = null;
		}

		// Unsubscribe from Docker events
		if (unsubscribeDockerEvent) {
			unsubscribeDockerEvent();
			unsubscribeDockerEvent = null;
		}

		document.removeEventListener('visibilitychange', handleVisibilityChange);
		document.removeEventListener('resume', handleVisibilityChange);
		pendingTimeouts.forEach(id => clearTimeout(id));
		pendingTimeouts = [];
	});
</script>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<PageHeader icon={HardDrive} title="Volumes" count={volumes.length} />
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative">
				<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				<Input
					type="text"
					placeholder="Search volumes..."
					bind:value={searchInput}
					onkeydown={(e) => e.key === 'Escape' && (searchInput = '')}
					class="pl-8 h-8 w-48 text-sm"
				/>
			</div>
			<MultiSelectFilter
				bind:value={driverFilter}
				options={driverOptions}
				placeholder="Driver"
				pluralLabel="drivers"
				width="w-28"
				defaultIcon={Database}
			/>
			<MultiSelectFilter
				bind:value={usageFilter}
				options={usageOptions}
				placeholder="Usage"
				pluralLabel="usages"
				width="w-28"
				defaultIcon={CircleDot}
			/>
			{#if $canAccess('volumes', 'remove')}
			<ConfirmPopover
				open={confirmPrune}
				action="Prune"
				itemType="unused volumes"
				title="Prune volumes"
				position="left"
				onConfirm={pruneVolumes}
				onOpenChange={(open) => confirmPrune = open}
				unstyled
			>
				{#snippet children({ open })}
					<span class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm bg-background shadow-xs border hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 {pruneStatus === 'pruning' ? 'opacity-50 pointer-events-none' : ''}">
						{#if pruneStatus === 'pruning'}
							<RefreshCw class="w-3.5 h-3.5 animate-spin" />
						{:else if pruneStatus === 'success'}
							<Check class="w-3.5 h-3.5 text-green-600" />
						{:else if pruneStatus === 'error'}
							<XCircle class="w-3.5 h-3.5 text-destructive" />
						{:else}
							<Icon iconNode={broom} class="w-3.5 h-3.5" />
						{/if}
						Prune
					</span>
				{/snippet}
			</ConfirmPopover>
			{/if}
			<Button size="sm" variant="outline" onclick={fetchVolumes}>Refresh</Button>
			{#if $canAccess('volumes', 'create')}
			<Button size="sm" variant="secondary" onclick={() => showCreateModal = true}>
				<Plus class="w-3.5 h-3.5" />
				Create
			</Button>
			{/if}
		</div>
	</div>

	<!-- Selection bar - always reserve space to prevent layout shift -->
	<div class="h-4 shrink-0">
		{#if selectedVolumes.size > 0}
			<div class="flex items-center gap-1 text-xs text-muted-foreground h-full">
			<span>{selectedInFilter.length} selected</span>
			<button
				type="button"
				class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:border-foreground/30 hover:shadow transition-all"
				onclick={selectNone}
			>
				Clear
			</button>
			{#if $canAccess('volumes', 'remove')}
			<ConfirmPopover
				open={confirmBulkRemove}
				action="Delete"
				itemType="{selectedInFilter.length} volume{selectedInFilter.length !== 1 ? 's' : ''}"
				title="Delete {selectedInFilter.length}"
				unstyled
				onConfirm={bulkRemove}
				onOpenChange={(open) => confirmBulkRemove = open}
			>
				{#snippet children({ open })}
					<span class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-destructive hover:border-destructive/40 hover:shadow transition-all cursor-pointer">
						<Trash2 class="w-3 h-3" />
						Delete
					</span>
				{/snippet}
			</ConfirmPopover>
			{/if}
			</div>
		{/if}
	</div>

	{#if !loading && ($environments.length === 0 || !$currentEnvironment)}
		<NoEnvironment />
	{:else if !loading && volumes.length === 0}
		<EmptyState
			icon={HardDrive}
			title="No volumes found"
			description="Create a volume to persist container data"
		/>
	{:else}
		<DataGrid
			data={filteredVolumes}
			keyField="name"
			gridId="volumes"
			loading={loading}
			selectable
			bind:selectedKeys={selectedVolumes}
			sortState={{ field: sortField, direction: sortDirection }}
			onSortChange={(state) => { sortField = state.field as SortField; sortDirection = state.direction; }}
			highlightedKey={highlightedRowId}
			onRowClick={(volume) => { highlightedRowId = highlightedRowId === volume.name ? null : volume.name; }}
		>
			{#snippet cell(column, volume, rowState)}
				{@const stack = volume.labels['com.docker.compose.project']}
				{#if column.id === 'name'}
					<code class="text-xs truncate block" title={volume.name}>{volume.name}</code>
				{:else if column.id === 'driver'}
					<Badge variant="outline" class="text-xs py-0 px-1.5 shadow-sm rounded-sm">{volume.driver}</Badge>
				{:else if column.id === 'scope'}
					<span class="text-xs">{volume.scope}</span>
				{:else if column.id === 'stack'}
					{#if stack}
						<Badge variant="secondary" class="text-xs py-0 px-1.5 shadow-sm rounded-sm">{stack}</Badge>
					{:else}
						<span class="text-muted-foreground text-xs">-</span>
					{/if}
				{:else if column.id === 'usedBy'}
					{#if volume.usedBy && volume.usedBy.length > 0}
						<div class="flex flex-wrap gap-1">
							{#each volume.usedBy.slice(0, 3) as container}
								<button
									type="button"
									onclick={() => openContainerInspect(container.containerId, container.containerName)}
									class="text-xs text-primary hover:underline cursor-pointer truncate max-w-[100px]"
									title={container.containerName}
								>
									{container.containerName}
								</button>
							{/each}
							{#if volume.usedBy.length > 3}
								<span class="text-xs text-muted-foreground">+{volume.usedBy.length - 3}</span>
							{/if}
						</div>
					{:else}
						<span class="text-muted-foreground text-xs">-</span>
					{/if}
				{:else if column.id === 'created'}
					<span class="text-xs text-muted-foreground">{formatDate(volume.created)}</span>
				{:else if column.id === 'actions'}
					<div class="flex items-center justify-end gap-1">
						{#if $canAccess('volumes', 'inspect')}
						<button
							type="button"
							onclick={() => inspectVolume(volume.name)}
							title="View details"
							class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
						>
							<Eye class="w-3 h-3 text-muted-foreground hover:text-foreground" />
						</button>
						<button
							type="button"
							onclick={() => browseVolume(volume.name)}
							title="Browse files"
							class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
						>
							<FolderOpen class="w-3 h-3 text-muted-foreground hover:text-foreground" />
						</button>
						<button
							type="button"
							onclick={() => exportVolume(volume.name)}
							title="Export volume as {$appSettings.downloadFormat || 'tar'}"
							class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer {exportingVolume === volume.name ? 'animate-pulse' : ''}"
							disabled={exportingVolume === volume.name}
						>
							<Download class="w-3 h-3 text-muted-foreground hover:text-foreground" />
						</button>
						{/if}
						{#if $canAccess('volumes', 'create')}
						<button
							type="button"
							onclick={() => cloneVolume(volume.name)}
							title="Clone volume"
							class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
						>
							<Stamp class="w-3 h-3 text-muted-foreground hover:text-foreground" />
						</button>
						{/if}
						{#if $canAccess('volumes', 'remove')}
						<div class="relative">
							<ConfirmPopover
								open={confirmDeleteName === volume.name}
								action="Delete"
								itemType="volume"
								itemName={volume.name}
								title="Remove"
								onConfirm={() => removeVolume(volume.name)}
								onOpenChange={(open) => confirmDeleteName = open ? volume.name : null}
							>
								{#snippet children({ open })}
									<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
								{/snippet}
							</ConfirmPopover>
							{#if deleteError?.name === volume.name}
								<div class="absolute bottom-full right-0 mb-1 z-50 bg-destructive text-destructive-foreground rounded-md shadow-lg p-2 text-xs flex items-start gap-2 max-w-lg w-max">
									<AlertTriangle class="w-3 h-3 flex-shrink-0 mt-0.5" />
									<span class="break-words">{deleteError.message}</span>
									<button onclick={() => deleteError = null} class="flex-shrink-0 hover:bg-white/20 rounded p-0.5">
										<X class="w-3 h-3" />
									</button>
								</div>
							{/if}
						</div>
						{/if}
					</div>
				{/if}
			{/snippet}
		</DataGrid>
	{/if}
</div>

<CreateVolumeModal
	bind:open={showCreateModal}
	onClose={() => showCreateModal = false}
	onSuccess={fetchVolumes}
/>

<VolumeInspectModal
	bind:open={showInspectModal}
	volumeName={inspectVolumeName}
/>

<VolumeBrowserModal
	bind:open={showBrowserModal}
	volumeName={browseVolumeName}
	{envId}
	onclose={() => showBrowserModal = false}
/>

<CloneVolumeModal
	bind:open={showCloneModal}
	volumeName={cloneVolumeName}
	{envId}
	onclose={() => showCloneModal = false}
	onsuccess={fetchVolumes}
/>

<ContainerInspectModal
	bind:open={showContainerInspectModal}
	containerId={inspectContainerId}
	containerName={inspectContainerName}
/>

<BatchOperationModal
	bind:open={showBatchOpModal}
	title={batchOpTitle}
	operation={batchOpOperation}
	entityType="volumes"
	items={batchOpItems}
	envId={envId ?? undefined}
	onClose={() => showBatchOpModal = false}
	onComplete={handleBatchComplete}
/>
