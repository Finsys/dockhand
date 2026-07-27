<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { DataGrid } from '$lib/components/data-grid';
	import { Plus, Trash2, Pencil, HardDrive, Server, CheckCircle, XCircle, AlertCircle, Wifi, Database, RefreshCw, Search, FolderSync, Archive, Loader2, Save, CircleHelp, Unlock, PackageCheck, Eraser, BarChart3, Wrench, FolderCheck, KeyRound } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Label } from '$lib/components/ui/label';
	import { appSettings } from '$lib/stores/settings';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Table from '$lib/components/ui/table';
	import { formatDateTime } from '$lib/stores/settings';
	import { FolderOpen, Box, Layers, FileStack, Camera, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-svelte';
	import { formatBytes } from '$lib/utils/format';
	import { getRepoTypeIcon, getRepoTypeLabel } from '$lib/utils/backup';
	import { shouldSaveBackupImage } from '$lib/utils/backup-image';
	import SnapshotBrowser from '../../containers/SnapshotBrowser.svelte';
	import type { Component } from 'svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import DestinationModal from './DestinationModal.svelte';
	import VerifyModal from './VerifyModal.svelte';
	import RotatePasswordModal from './RotatePasswordModal.svelte';
	import { EmptyState } from '$lib/components/ui/empty-state';

	interface Destination {
		id: number;
		name: string;
		repository: string;
		envVars?: Record<string, string>;
		flags?: string;
		lastTestStatus?: string | null;
		lastTestError?: string | null;
		lastTestAt?: string | null;
		createdAt: string;
		updatedAt: string;
	}

	interface BackupConfig {
		id: number;
		destinationId: number;
		targetName: string;
		type: string;
	}

	let destinations = $state<Destination[]>([]);
	let configs = $state<BackupConfig[]>([]);
	let loading = $state(true);
	let showModal = $state(false);
	let editingDest = $state<Destination | null>(null);
	let confirmDeleteId = $state<number | null>(null);
	let confirmAction = $state<{ destId: number; task: string } | null>(null);
	let searchQuery = $state('');
	let testingId = $state<number | null>(null);

	let testingAll = $state(false);
	let verifyModalOpen = $state(false);
	let verifyDestId = $state(0);
	let verifyDestName = $state('');
	let rotateModalOpen = $state(false);
	let rotateDestId = $state(0);
	let rotateDestName = $state('');
	let repoStats = $state<Map<number, { totalSize: number; totalFiles: number; snapshots: number }>>(new Map());
	let loadingStats = $state<Set<number>>(new Set());
	let fetchingAllStats = $state(false);

	async function fetchRepoStats(destId: number) {
		const s = new Set(loadingStats); s.add(destId); loadingStats = s;
		try {
			const res = await fetch(`/api/backup/destinations/${destId}/task`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ task: 'stats' })
			});
			const data = await res.json();
			if (data.success && data.stats) {
				const m = new Map(repoStats);
				m.set(destId, data.stats);
				repoStats = m;
			}
		} catch {} finally {
			const s2 = new Set(loadingStats); s2.delete(destId); loadingStats = s2;
		}
	}

	async function fetchAllStats() {
		fetchingAllStats = true;
		// Skip destinations that aren't initialized (failed, needs_init, or never tested)
		const healthy = destinations.filter(d => d.lastTestStatus === 'success');
		await Promise.all(healthy.map(d => fetchRepoStats(d.id)));
		fetchingAllStats = false;
	}

	async function testAllDestinations() {
		testingAll = true;
		let passed = 0;
		let failed = 0;

		// Clear statuses so UI shows spinners
		for (const dest of destinations) {
			dest.lastTestStatus = null;
		}
		destinations = [...destinations];
		repoStats = new Map();

		// Run all tests + stats in parallel, update UI incrementally
		await Promise.allSettled(destinations.map(async (dest) => {
			try {
				const res = await fetch(`/api/backup/destinations/${dest.id}/test`, { method: 'POST' });
				const data = await res.json();
				if (data.success) {
					passed++;
					dest.lastTestStatus = 'success';
					destinations = [...destinations];
					await fetchRepoStats(dest.id);
				} else {
					failed++;
					dest.lastTestStatus = data.status === 'needs_init' ? 'needs_init' : 'failed';
					dest.lastTestError = data.error || null;
					destinations = [...destinations];
				}
			} catch {
				failed++;
				dest.lastTestStatus = 'failed';
				destinations = [...destinations];
			}
		}));

		testingAll = false;
		if (failed === 0) toast.success(`All ${passed} destinations tested & stats collected`);
		else toast.error(`${failed} failed, ${passed} passed`);
	}

	// Backup helper image setting
	// Pre-filled from the store, which carries the API's real version-pinned default
	// (fnsys/dockhand-backup:<version>). No local `:latest` guess — that value is
	// wrong (the engine uses the versioned image) and misleading to persist.
	let backupImage = $state($appSettings.defaultBackupImage);
	// The value we loaded the field with. We persist ONLY when the user changed it,
	// so leaving the pre-filled versioned default untouched keeps the DB row empty and
	// the engine keeps tracking the app version across upgrades (see backup-image.ts).
	let backupImageInitial = $state($appSettings.defaultBackupImage);
	let savingImage = $state(false);
	let imageSavedOk = $state(false);

	async function saveBackupImage() {
		if (!shouldSaveBackupImage(backupImage, backupImageInitial)) {
			// Unchanged — nothing to persist. Give the same confirmation feedback.
			imageSavedOk = true;
			setTimeout(() => { imageSavedOk = false; }, 2000);
			return;
		}
		savingImage = true;
		try {
			const res = await fetch('/api/settings/general', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ defaultBackupImage: backupImage })
			});
			if (res.ok) {
				backupImageInitial = backupImage;
				imageSavedOk = true;
				setTimeout(() => { imageSavedOk = false; }, 2000);
			}
			else toast.error('Failed to save');
		} catch { toast.error('Failed to save'); }
		finally { savingImage = false; }
	}
	let initializingId = $state<number | null>(null);
	let runningTask = $state<{ destId: number; task: string } | null>(null);

	async function runRepoTask(destId: number, task: string) {
		runningTask = { destId, task };
		try {
			const res = await fetch(`/api/backup/destinations/${destId}/task`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ task })
			});
			const data = await res.json();
			if (data.success) {
				if (task === 'stats' && data.stats) {
					const m = new Map(repoStats);
					m.set(destId, data.stats);
					repoStats = m;
				}
				toast.success(data.output || `${task} completed`);
			} else {
				toast.error(data.error || `${task} failed`);
			}
		} catch (err: any) {
			toast.error(err.message || `${task} failed`);
		} finally {
			runningTask = null;
		}
	}

	// Browse repository snapshots
	let browseOpen = $state(false);
	let browseDestId = $state(0);
	let browseDestName = $state('');
	let browseDestRepo = $state('');
	let browseSnapshots = $state<any[]>([]);
	let browseLoading = $state(false);

	// Snapshot list sorting — default newest first (by snapshot timestamp).
	type BrowseSortField = 'shortId' | 'time' | 'type' | 'name';
	let browseSort = $state<{ field: BrowseSortField; dir: 'asc' | 'desc' }>({ field: 'time', dir: 'desc' });
	function snapName(snap: any): string {
		return (snap.tags || []).find((t: string) => t.startsWith('dockhand:name='))?.replace('dockhand:name=', '') || '';
	}
	function snapType(snap: any): string {
		return (snap.tags || []).find((t: string) => t.startsWith('dockhand:type='))?.replace('dockhand:type=', '') || '';
	}
	function toggleBrowseSort(field: BrowseSortField) {
		if (browseSort.field === field) browseSort = { field, dir: browseSort.dir === 'asc' ? 'desc' : 'asc' };
		else browseSort = { field, dir: field === 'time' ? 'desc' : 'asc' };
	}
	const sortedBrowseSnapshots = $derived.by(() => {
		const { field, dir } = browseSort;
		const key = (s: any) =>
			field === 'shortId' ? (s.shortId ?? '') :
			field === 'time' ? (s.time ?? '') :
			field === 'type' ? snapType(s) :
			snapName(s);
		return [...browseSnapshots].sort((a, b) => {
			const ka = key(a), kb = key(b);
			const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
			return dir === 'asc' ? cmp : -cmp;
		});
	});

	// Snapshot file browser
	let snapshotBrowseOpen = $state(false);
	let snapshotBrowseId = $state('');
	let snapshotBrowseDestId = $state(0);
	let snapshotBrowseName = $state('');

	async function browseDestination(dest: Destination) {
		browseDestId = dest.id;
		browseDestName = dest.name;
		browseDestRepo = dest.repository;
		browseSnapshots = [];
		browseOpen = true;
		browseLoading = true;
		try {
			// List all snapshots in this destination (no configId filter)
			const res = await fetch(`/api/backup/snapshots?destinationId=${dest.id}`);
			if (res.ok) { const d = await res.json(); browseSnapshots = d.snapshots ?? d; }
			else {
				const data = await res.json();
				const errMsg = data.error || 'Failed to list snapshots';
				try { const p = JSON.parse(errMsg); toast.error(p.message || errMsg); } catch { toast.error(errMsg); }
			}
		} catch { toast.error('Failed to list snapshots'); }
		finally { browseLoading = false; }
	}

	const getTypeIcon = getRepoTypeIcon;
	const getTypeLabel = getRepoTypeLabel;

	function getUsageCount(destId: number): { containers: number; stacks: number } {
		const related = configs.filter(c => c.destinationId === destId);
		return {
			containers: related.filter(c => c.type === 'container').length,
			stacks: related.filter(c => c.type === 'stack').length
		};
	}

	const filteredDestinations = $derived(
		searchQuery.trim()
			? destinations.filter(d =>
				d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
				d.repository.toLowerCase().includes(searchQuery.toLowerCase()) ||
				getTypeLabel(d.repository).toLowerCase().includes(searchQuery.toLowerCase())
			)
			: destinations
	);

	async function fetchData() {
		loading = true;
		repoStats = new Map();
		try {
			const [destRes, configRes] = await Promise.all([
				fetch('/api/backup/destinations'),
				fetch('/api/backup/configs')
			]);
			destinations = await destRes.json();
			const configData = await configRes.json();
			configs = Array.isArray(configData) ? configData : [];
		} catch (error) {
			console.error('Failed to fetch backup data:', error);
			toast.error('Failed to fetch backup destinations');
		} finally {
			loading = false;
		}
	}

	async function openModal(dest?: Destination) {
		if (dest) {
			// The LIST endpoint omits envVars (cloud creds) for security.
			// Re-fetch the single destination so the modal can pre-fill the
			// credential fields.
			try {
				const res = await fetch(`/api/backup/destinations/${dest.id}`);
				if (res.ok) {
					editingDest = await res.json();
				} else {
					editingDest = dest; // fall back to what we have
				}
			} catch {
				editingDest = dest;
			}
		} else {
			editingDest = null;
		}
		showModal = true;
	}

	async function testDestination(id: number) {
		testingId = id;
		try {
			const res = await fetch(`/api/backup/destinations/${id}/test`, { method: 'POST' });
			const data = await res.json();
			if (data.success) {
				toast.success('Connection test successful');
			} else if (data.status === 'needs_init') {
				toast.warning(data.error || 'Repository needs initialization');
			} else {
				toast.error(data.error || 'Connection test failed');
			}
		} catch { toast.error('Connection test failed'); }
		finally { testingId = null; await fetchData(); }
	}

	async function initDestination(id: number) {
		initializingId = id;
		try {
			const res = await fetch(`/api/backup/destinations/${id}/init`, { method: 'POST' });
			const data = await res.json();
			toast[data.success ? 'success' : 'error'](data.message || data.error || 'Init failed');
		} catch { toast.error('Init failed'); }
		finally { initializingId = null; await fetchData(); }
	}

	async function deleteDestination(id: number) {
		try {
			const response = await fetch(`/api/backup/destinations/${id}`, { method: 'DELETE' });
			if (response.ok) {
				await fetchData();
				toast.success('Destination deleted');
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to delete destination');
			}
		} catch { toast.error('Failed to delete destination'); }
	}

	onMount(() => { fetchData(); });
</script>

<div class="space-y-4">
	<!-- Backup helper image -->
	<div class="flex items-center gap-3 p-3 border rounded-md bg-muted/20">
		<Label class="text-xs shrink-0 flex items-center gap-1.5">
			Backup helper image
			<Tooltip.Provider delayDuration={200}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						<CircleHelp class="w-3 h-3 text-muted-foreground/70 cursor-help" />
					</Tooltip.Trigger>
					<Tooltip.Portal>
						<Tooltip.Content side="bottom" sideOffset={4} class="!w-80 text-xs">
							Docker image with restic for backup/restore. Auto-pulled on first run. Change for private registries.
						</Tooltip.Content>
					</Tooltip.Portal>
				</Tooltip.Root>
			</Tooltip.Provider>
		</Label>
		<Input bind:value={backupImage} class="w-80" />
		<Button variant="outline" size="sm" class="h-8" onclick={saveBackupImage} disabled={savingImage}>
			{#if savingImage}<Loader2 class="w-3.5 h-3.5 animate-spin" />{:else if imageSavedOk}<CheckCircle class="w-3.5 h-3.5 text-green-500" />{:else}<Save class="w-3.5 h-3.5" />{/if}
		</Button>
	</div>

	<div class="flex justify-between items-center">
		<div class="flex items-center gap-3">
			<div class="relative">
				<Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
				<Input
					bind:value={searchQuery}
					placeholder="Filter destinations..."
					class="pl-9 h-8 w-64 text-sm"
				/>
			</div>
			<Badge variant="secondary" class="text-xs">{destinations.length} destination{destinations.length !== 1 ? 's' : ''}</Badge>
		</div>
		<div class="flex gap-2">
			{#if $canAccess('backups', 'manage')}
				<Button size="sm" onclick={() => openModal()}>
					<Plus class="w-4 h-4 mr-1" />
					Add destination
				</Button>
			{/if}
			<Button size="sm" variant="outline" onclick={testAllDestinations} disabled={testingAll}>
				{#if testingAll}<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />{:else}<Wifi class="w-3.5 h-3.5 mr-1" />{/if}
				Test all
			</Button>
			<Button size="sm" variant="outline" onclick={fetchData}>
				<RefreshCw class="w-3.5 h-3.5" />
			</Button>
		</div>
	</div>

	{#if loading && destinations.length === 0}
		<p class="text-muted-foreground text-sm">Loading backup destinations...</p>
	{:else if destinations.length === 0}
		<EmptyState
			icon={Archive as unknown as Component}
			title="No backup destinations"
			description="Add a backup destination to start protecting your container data"
		/>
	{:else}
		<DataGrid
			data={filteredDestinations}
			keyField="id"
			gridId="backupDestinations"
			loading={loading}
			onRowClick={(dest) => openModal(dest)}
			class="border-none"
			wrapperClass="border rounded-lg"
		>
			{#snippet cell(column, dest)}
				{#if column.id === 'type'}
					{@const TypeIcon = getTypeIcon(dest.repository)}
					<div class="flex items-center gap-1.5" title={getTypeLabel(dest.repository)}>
						<TypeIcon class="w-4 h-4 text-muted-foreground" />
						<span class="text-xs text-muted-foreground">{getTypeLabel(dest.repository)}</span>
					</div>
				{:else if column.id === 'name'}
					<span class="font-medium text-sm">{dest.name}</span>
				{:else if column.id === 'repository'}
					<span class="text-xs text-muted-foreground truncate block" title={dest.repository}>
						{dest.repository}
					</span>
				{:else if column.id === 'usage'}
					{@const usage = getUsageCount(dest.id)}
					{#if usage.containers > 0 || usage.stacks > 0}
						<div class="flex items-center gap-1.5">
							{#if usage.containers > 0}
								<span class="flex items-center gap-0.5 text-xs text-muted-foreground" title="{usage.containers} container{usage.containers !== 1 ? 's' : ''} using this repository"><Box class="w-3 h-3" />{usage.containers}</span>
							{/if}
							{#if usage.stacks > 0}
								<span class="flex items-center gap-0.5 text-xs text-muted-foreground" title="{usage.stacks} stack{usage.stacks !== 1 ? 's' : ''} using this repository"><Layers class="w-3 h-3" />{usage.stacks}</span>
							{/if}
						</div>
					{:else}
						<span class="text-xs text-muted-foreground/50">—</span>
					{/if}
				{:else if column.id === 'stats'}
					{@const stat = repoStats.get(dest.id)}
					{#if stat}
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<span class="flex items-center gap-0.5" title="Total size"><HardDrive class="w-3 h-3" />{formatBytes(stat.totalSize)}</span>
							<span class="flex items-center gap-0.5" title="Files"><FileStack class="w-3 h-3" />{stat.totalFiles}</span>
							<span class="flex items-center gap-0.5" title="Snapshots"><Camera class="w-3 h-3" />{stat.snapshots}</span>
						</div>
					{:else if loadingStats.has(dest.id)}
						<Loader2 class="w-3 h-3 animate-spin text-muted-foreground" />
					{:else}
						<span class="text-xs text-muted-foreground/50">—</span>
					{/if}
				{:else if column.id === 'status'}
					{#if dest.lastTestStatus === 'success'}
						<div class="flex items-center gap-1.5">
							<CheckCircle class="w-3.5 h-3.5 text-green-500" />
							<span class="text-xs text-green-600 dark:text-green-400">Initialized</span>
						</div>
					{:else if dest.lastTestStatus === 'needs_init'}
						<div class="flex items-center gap-1.5">
							<AlertCircle class="w-3.5 h-3.5 text-amber-500" />
							<span class="text-xs text-amber-600 dark:text-amber-400">Needs init</span>
						</div>
					{:else if dest.lastTestStatus === 'failed'}
						<Tooltip.Root>
							<Tooltip.Trigger>
								<div class="flex items-center gap-1.5">
									<XCircle class="w-3.5 h-3.5 text-destructive" />
									<span class="text-xs text-destructive">Failed</span>
								</div>
							</Tooltip.Trigger>
							{#if dest.lastTestError}
								<Tooltip.Content class="max-w-sm whitespace-normal text-xs">{dest.lastTestError}</Tooltip.Content>
							{/if}
						</Tooltip.Root>
					{:else if testingAll}
						<div class="flex items-center gap-1.5">
							<Loader2 class="w-3.5 h-3.5 text-muted-foreground animate-spin" />
							<span class="text-xs text-muted-foreground">Testing...</span>
						</div>
					{:else}
						<div class="flex items-center gap-1.5">
							<AlertCircle class="w-3.5 h-3.5 text-muted-foreground" />
							<span class="text-xs text-muted-foreground">Not tested</span>
						</div>
					{/if}
				{:else if column.id === 'actions'}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="flex items-center justify-end gap-0.5" onclick={(e) => e.stopPropagation()}>
						{#if dest.lastTestStatus === 'success'}
							<!-- Repo actions (only for initialized repos) -->
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => browseDestination(dest)} title="Browse snapshots">
								<FolderOpen class="grid-action-icon grid-action-info text-muted-foreground" />
							</button>
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => runRepoTask(dest.id, 'stats')} disabled={runningTask?.destId === dest.id} title="Repository stats">
								{#if runningTask?.destId === dest.id && runningTask.task === 'stats'}<Loader2 class="grid-action-icon text-muted-foreground animate-spin" />{:else}<BarChart3 class="grid-action-icon grid-action-info text-muted-foreground" />{/if}
							</button>
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => runRepoTask(dest.id, 'check')} disabled={runningTask?.destId === dest.id} title="Check integrity">
								{#if runningTask?.destId === dest.id && runningTask.task === 'check'}<Loader2 class="grid-action-icon text-muted-foreground animate-spin" />{:else}<PackageCheck class="grid-action-icon grid-action-info text-muted-foreground" />{/if}
							</button>
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => { verifyDestId = dest.id; verifyDestName = dest.name; verifyModalOpen = true; }} title="Verify data integrity">
								<FolderCheck class="grid-action-icon grid-action-info text-muted-foreground" />
							</button>
							<ConfirmPopover
								open={confirmAction?.destId === dest.id && confirmAction.task === 'unlock'}
								action="Unlock" itemType="repository" itemName={dest.name} confirmText="Unlock" position="left"
								onConfirm={() => { confirmAction = null; runRepoTask(dest.id, 'unlock'); }}
								onOpenChange={(o) => confirmAction = o ? { destId: dest.id, task: 'unlock' } : null}
							>
								{#snippet children({ open })}
									{#if runningTask?.destId === dest.id && runningTask.task === 'unlock'}<Loader2 class="grid-action-icon text-muted-foreground animate-spin" />{:else}<Unlock class="grid-action-icon grid-action-edit text-muted-foreground" />{/if}
								{/snippet}
							</ConfirmPopover>
							<ConfirmPopover
								open={confirmAction?.destId === dest.id && confirmAction.task === 'prune'}
								action="Prune" itemType="unused data from" itemName={dest.name} confirmText="Prune" variant="destructive" position="left"
								onConfirm={() => { confirmAction = null; runRepoTask(dest.id, 'prune'); }}
								onOpenChange={(o) => confirmAction = o ? { destId: dest.id, task: 'prune' } : null}
							>
								{#snippet children({ open })}
									{#if runningTask?.destId === dest.id && runningTask.task === 'prune'}<Loader2 class="grid-action-icon text-muted-foreground animate-spin" />{:else}<Eraser class="grid-action-icon grid-action-delete {open ? 'text-destructive' : 'text-muted-foreground'}" />{/if}
								{/snippet}
							</ConfirmPopover>
							<ConfirmPopover
								open={confirmAction?.destId === dest.id && confirmAction.task === 'repair'}
								action="Repair" itemType="index for" itemName={dest.name} confirmText="Repair" variant="destructive" position="left"
								onConfirm={() => { confirmAction = null; runRepoTask(dest.id, 'repair-index'); }}
								onOpenChange={(o) => confirmAction = o ? { destId: dest.id, task: 'repair' } : null}
							>
								{#snippet children({ open })}
									{#if runningTask?.destId === dest.id && runningTask.task === 'repair-index'}<Loader2 class="grid-action-icon text-muted-foreground animate-spin" />{:else}<Wrench class="grid-action-icon grid-action-delete {open ? 'text-destructive' : 'text-muted-foreground'}" />{/if}
								{/snippet}
							</ConfirmPopover>
						{/if}
						<!-- Init (only when needs_init) -->
						{#if dest.lastTestStatus === 'needs_init'}
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors text-amber-500 hover:text-amber-600" onclick={() => initDestination(dest.id)} disabled={initializingId === dest.id} title="Initialize repository">
								{#if initializingId === dest.id}<Loader2 class="w-3 h-3 animate-spin" />{:else}<Database class="w-3 h-3" />{/if}
							</button>
						{/if}
						<!-- Always visible: test, edit, delete -->
						<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => testDestination(dest.id)} disabled={testingId === dest.id} title="Test connection">
							{#if testingId === dest.id}<RefreshCw class="grid-action-icon text-muted-foreground animate-spin" />{:else}<Wifi class="grid-action-icon grid-action-restart text-muted-foreground" />{/if}
						</button>
						{#if $canAccess('backups', 'manage')}
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => { rotateDestId = dest.id; rotateDestName = dest.name; rotateModalOpen = true; }} title="Rotate repository password">
								<KeyRound class="grid-action-icon grid-action-edit text-muted-foreground" />
							</button>
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => openModal(dest)} title="Edit">
								<Pencil class="grid-action-icon grid-action-edit text-muted-foreground" />
							</button>
							<ConfirmPopover
								open={confirmDeleteId === dest.id}
								action="Delete"
								itemType="destination"
								itemName={dest.name}
								title="Remove"
								position="left"
								onConfirm={() => deleteDestination(dest.id)}
								onOpenChange={(open) => confirmDeleteId = open ? dest.id : null}
							>
								{#snippet children({ open })}
									<Trash2 class="grid-action-icon grid-action-delete {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
								{/snippet}
							</ConfirmPopover>
						{/if}
					</div>
				{/if}
			{/snippet}
		</DataGrid>
	{/if}
</div>

<DestinationModal
	bind:open={showModal}
	destination={editingDest}
	existingDestinations={destinations}
	onClose={() => { showModal = false; editingDest = null; }}
	onSaved={fetchData}
/>

<Dialog.Root bind:open={browseOpen}>
	<Dialog.Content class="max-w-2xl h-[70vh] flex flex-col overflow-hidden">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<FolderOpen class="w-5 h-5" />
				Repository snapshots on
				<svelte:component this={getRepoTypeIcon(browseDestRepo)} class="w-4 h-4" />
				<span class="text-amber-600 dark:text-amber-400">{browseDestName}</span>
			</Dialog.Title>
		</Dialog.Header>
		<div class="flex-1 overflow-y-auto">
			{#if browseLoading}
				<div class="flex items-center justify-center py-12"><Loader2 class="w-6 h-6 animate-spin text-muted-foreground" /></div>
			{:else if browseSnapshots.length === 0}
				<p class="text-sm text-muted-foreground p-4">No snapshots in this repository.</p>
			{:else}
				{#snippet sortHead(field: BrowseSortField, label: string, extra = '')}
					<Table.Head class={extra}>
						<button type="button" class="inline-flex items-center gap-1 hover:text-foreground transition-colors" onclick={() => toggleBrowseSort(field)}>
							{label}
							{#if browseSort.field === field}
								{#if browseSort.dir === 'asc'}<ArrowUp class="w-3 h-3" />{:else}<ArrowDown class="w-3 h-3" />{/if}
							{:else}
								<ArrowUpDown class="w-3 h-3 opacity-40" />
							{/if}
						</button>
					</Table.Head>
				{/snippet}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							{@render sortHead('shortId', 'ID', 'w-24')}
							{@render sortHead('time', 'Created')}
							{@render sortHead('type', 'Type', 'w-16')}
							{@render sortHead('name', 'Name')}
							<Table.Head class="w-12 text-right">Browse</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each sortedBrowseSnapshots as snap}
							{@const name = snapName(snap)}
							{@const type = snapType(snap)}
							<Table.Row class="cursor-pointer hover:bg-muted/50" onclick={() => { snapshotBrowseDestId = browseDestId; snapshotBrowseId = snap.id; snapshotBrowseName = name; snapshotBrowseOpen = true; }}>
								<Table.Cell class="font-mono text-xs text-muted-foreground">{snap.shortId}</Table.Cell>
								<Table.Cell class="text-xs">{formatDateTime(snap.time)}</Table.Cell>
								<Table.Cell>
									{#if type === 'container'}
										<Box class="w-3.5 h-3.5 text-blue-500" />
									{:else if type === 'stack'}
										<Layers class="w-3.5 h-3.5 text-purple-500" />
									{:else}
										<Box class="w-3.5 h-3.5 text-muted-foreground" />
									{/if}
								</Table.Cell>
								<Table.Cell class="text-xs">{name}</Table.Cell>
								<Table.Cell class="text-right">
									<span class="inline-flex p-1 rounded hover:bg-muted transition-colors text-muted-foreground" title="Browse snapshot content">
										<FolderOpen class="w-3.5 h-3.5" />
									</span>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</div>
		<Dialog.Footer class="pt-4">
			<Button variant="outline" onclick={() => browseOpen = false}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<SnapshotBrowser
	bind:open={snapshotBrowseOpen}
	destinationId={snapshotBrowseDestId}
	snapshotId={snapshotBrowseId}
	targetName={snapshotBrowseName}
/>

<VerifyModal
	bind:open={verifyModalOpen}
	destinationId={verifyDestId}
	destinationName={verifyDestName}
/>

<RotatePasswordModal
	bind:open={rotateModalOpen}
	destinationId={rotateDestId}
	destinationName={rotateDestName}
/>
