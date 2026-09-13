<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { DataGrid } from '$lib/components/data-grid';
	import { Plus, Trash2, Pencil, HardDrive, Server, CheckCircle, XCircle, AlertCircle, Wifi, Database, RefreshCw, Search, FolderSync, Archive, Loader2, Save, CircleHelp, Unlock, PackageCheck, Eraser, BarChart3, Wrench, FolderCheck, KeyRound } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Label } from '$lib/components/ui/label';
	import { appSettings } from '$lib/stores/settings';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Table from '$lib/components/ui/table';
	import { formatDateTime, formatRelativeTime } from '$lib/stores/settings';
	import { FolderOpen, Box, Layers, FileStack, Camera, ChevronRight, ChevronDown } from 'lucide-svelte';
	import { formatBytes } from '$lib/utils/format';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import { LoadingState } from '$lib/components/ui/loading-state';
	import { getRepoTypeIcon, getRepoTypeLabel } from '$lib/utils/backup';
	import { shouldSaveBackupImage } from '$lib/utils/backup-image';
	import { summarizeTestResults, formatTestSummary, type TestOutcome } from '$lib/utils/backup-test-summary';
	import SnapshotBrowser from '../../containers/SnapshotBrowser.svelte';
	import type { Component } from 'svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import DestinationModal from './DestinationModal.svelte';
	import BackupLogModal from '../../backups/BackupLogModal.svelte';
	import { watchJob, readJobResponse } from '$lib/utils/sse-fetch';
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
	let environments = $state<Array<{ id: number; name: string; icon?: string }>>([]);
	let loading = $state(true);
	let showModal = $state(false);
	let editingDest = $state<Destination | null>(null);
	let confirmDeleteId = $state<number | null>(null);
	let confirmAction = $state<{ destId: number; task: string } | null>(null);
	let searchQuery = $state('');
	// Sort + status filter for the destinations grid.
	let destSort = $state<{ field: string; direction: 'asc' | 'desc' }>({ field: 'name', direction: 'asc' });
	let statusFilter = $state<'all' | 'success' | 'needs_init' | 'failed'>('all');
	let testingId = $state<number | null>(null);

	let testingAll = $state(false);
	// Shared live-log modal for every restic maintenance action (verify/check/prune/
	// repair/unlock) — the same BackupLogModal used by backup/restore, so all
	// destination actions share one elegant log UI instead of a raw toast dump.
	let actionLogOpen = $state(false);
	let actionLogTitle = $state('');
	let actionLogIcon = $state<any>(undefined);
	let actionLogStatus = $state<'running' | 'success' | 'error'>('running');
	let actionLogLogs = $state<string[]>([]);
	let actionLogError = $state('');
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

		// Clear statuses so UI shows spinners
		for (const dest of destinations) {
			dest.lastTestStatus = null;
		}
		destinations = [...destinations];
		repoStats = new Map();

		// Run all tests + stats in parallel, update UI incrementally. Collect the
		// three-way outcome per destination; a needs-init repo is NOT a failure.
		const outcomes = await Promise.all(destinations.map(async (dest): Promise<TestOutcome> => {
			try {
				const res = await fetch(`/api/backup/destinations/${dest.id}/test`, { method: 'POST' });
				const data = await res.json();
				if (data.success) {
					dest.lastTestStatus = 'success';
					destinations = [...destinations];
					await fetchRepoStats(dest.id);
					return 'success';
				}
				const status: TestOutcome = data.status === 'needs_init' ? 'needs_init' : 'failed';
				dest.lastTestStatus = status;
				dest.lastTestError = data.error || null;
				destinations = [...destinations];
				return status;
			} catch {
				dest.lastTestStatus = 'failed';
				destinations = [...destinations];
				return 'failed';
			}
		}));

		testingAll = false;
		const summary = formatTestSummary(summarizeTestResults(outcomes));
		toast[summary.severity](summary.text);
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

	const REPO_TASK_TITLES: Record<string, string> = {
		unlock: 'Unlock repository',
		prune: 'Prune unused data',
		check: 'Check integrity',
		'repair-index': 'Repair index',
		'repair-snapshots': 'Repair snapshots'
	};

	async function runRepoTask(destId: number, task: string) {
		runningTask = { destId, task };
		// `stats` is a silent read that only populates the cells — no log modal.
		if (task === 'stats') {
			try {
				const res = await fetch(`/api/backup/destinations/${destId}/task`, {
					method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task })
				});
				const data = await res.json();
				if (data.success && data.stats) {
					const m = new Map(repoStats);
					m.set(destId, data.stats);
					repoStats = m;
				} else if (!data.success) {
					toast.error(data.error || 'Stats failed');
				}
			} catch (err: any) {
				toast.error(err.message || 'Stats failed');
			} finally {
				runningTask = null;
			}
			return;
		}

		const dest = destinations.find((d) => d.id === destId);
		await streamRepoAction(
			`${REPO_TASK_TITLES[task] || task}${dest ? ` - ${dest.name}` : ''}`,
			`/api/backup/destinations/${destId}/task`,
			{ task },
			dest?.repository
		);
		runningTask = null;
	}

	function verifyDestination(dest: any) {
		streamRepoAction(`Verify data integrity - ${dest.name}`, `/api/backup/destinations/${dest.id}/verify`, {}, dest.repository);
	}

	/** Run a restic maintenance action, streaming its output live into the shared
	 *  BackupLogModal (identical UX to backup/restore logs). */
	async function streamRepoAction(title: string, url: string, body: Record<string, unknown>, repository?: string) {
		actionLogTitle = title;
		actionLogIcon = repository ? getRepoTypeIcon(repository) : undefined;
		actionLogStatus = 'running';
		actionLogLogs = [];
		actionLogError = '';
		actionLogOpen = true;
		try {
			const res = await fetch(url, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
			});
			const data = await res.json();
			if (data.jobId) {
				const result = await watchJob(data.jobId, (line) => {
					const d = line.data as any;
					if (line.event === 'progress' && d?.message) {
						actionLogLogs = [...actionLogLogs, d.message];
					}
				}) as any;
				if (result?.success === false) {
					actionLogStatus = 'error';
					actionLogError = result.error || 'Action failed';
				} else {
					actionLogStatus = 'success';
				}
			} else if (data.error) {
				actionLogStatus = 'error';
				actionLogError = data.error;
			} else {
				// Backward-compat JSON path (Accept negotiated to one-shot): show result.
				actionLogStatus = data.success ? 'success' : 'error';
				if (!data.success) actionLogError = data.error || 'Action failed';
			}
		} catch (err: any) {
			actionLogStatus = 'error';
			actionLogError = err.message || 'Action failed';
		}
	}

	// Browse repository snapshots
	let browseOpen = $state(false);
	let browseDestId = $state(0);
	let browseDestName = $state('');
	let browseDestRepo = $state('');
	let browseSnapshots = $state<any[]>([]);
	let browseLoading = $state(false);

	function snapName(snap: any): string {
		return (snap.tags || []).find((t: string) => t.startsWith('dockhand:name='))?.replace('dockhand:name=', '') || '';
	}
	function snapType(snap: any): string {
		return (snap.tags || []).find((t: string) => t.startsWith('dockhand:type='))?.replace('dockhand:type=', '') || '';
	}
	// Environment a snapshot belongs to, from its dockhand:envid tag. Returns the
	// resolved env (name + icon) when it still exists, { missing: true } when the
	// env was deleted, or null when the snapshot is unscoped ('local', no envid tag).
	function snapEnv(snap: any): { id: number; name: string; icon: string } | { missing: true } | null {
		const tag = (snap.tags || []).find((t: string) => t.startsWith('dockhand:envid='));
		if (!tag) return null;
		const id = parseInt(tag.replace('dockhand:envid=', ''));
		if (isNaN(id)) return null;
		const env = environments.find((e) => e.id === id);
		return env ? { id: env.id, name: env.name, icon: env.icon || 'globe' } : { missing: true };
	}
	let browseFilterName = $state('');
	let browseFilterEnv = $state('');
	// DataGrid sort + expand state for the repo-snapshots grid.
	let browseGridSort = $state<{ field: string; direction: 'asc' | 'desc' }>({ field: 'latest', direction: 'desc' });
	let browseExpandedKeys = $state<Set<unknown>>(new Set());

	type SnapGroup = {
		key: string; name: string; type: string;
		env: { id: number; name: string; icon: string } | { missing: true } | null;
		envLabel: string; snapshots: any[]; latest: string; count: number;
	};

	// Group the repo's snapshots by owning environment + target name. Source is the
	// snapshot tags (name/type/envid), NOT backup_configs — so this works on a fresh
	// instance with no configs (the restore-on-new-box case). Env is resolved eagerly
	// in-memory from the already-fetched tags + environments list (no per-snapshot I/O).
	const browseGroups = $derived.by(() => {
		const nf = browseFilterName.trim().toLowerCase();
		const ef = browseFilterEnv.trim().toLowerCase();
		const groups = new Map<string, SnapGroup>();
		for (const s of browseSnapshots) {
			const name = snapName(s);
			const e = snapEnv(s);
			const envLabel = e ? ('missing' in e ? 'missing' : e.name) : '';
			if (nf && !name.toLowerCase().includes(nf)) continue;
			if (ef && !envLabel.toLowerCase().includes(ef)) continue;
			const envKey = e ? ('missing' in e ? 'missing' : String(e.id)) : 'local';
			const gkey = `${envKey}:${name}`;
			let g = groups.get(gkey);
			if (!g) { g = { key: gkey, name, type: snapType(s), env: e, envLabel, snapshots: [], latest: '', count: 0 }; groups.set(gkey, g); }
			g.snapshots.push(s);
		}
		const arr = [...groups.values()];
		for (const g of arr) {
			g.snapshots.sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
			g.latest = g.snapshots[0]?.time ?? '';
			g.count = g.snapshots.length;
		}
		const { field, direction } = browseGridSort;
		const key = (g: SnapGroup) =>
			field === 'type' ? g.type :
			field === 'envLabel' ? g.envLabel :
			field === 'latest' ? g.latest :
			field === 'count' ? String(g.count).padStart(6, '0') :
			g.name;
		arr.sort((a, b) => {
			const ka = key(a), kb = key(b);
			const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
			return direction === 'asc' ? cmp : -cmp;
		});
		return arr;
	});

	function toggleBrowseGroup(g: SnapGroup) {
		const next = new Set(browseExpandedKeys);
		next.has(g.key) ? next.delete(g.key) : next.add(g.key);
		browseExpandedKeys = next;
	}


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
			// List all snapshots in this destination (no configId filter). Job-polling so a
			// slow `restic snapshots` behind a proxy isn't aborted at ~15s.
			const res = await fetch(`/api/backup/snapshots?destinationId=${dest.id}`, {
				headers: { Accept: 'text/event-stream' }
			});
			const d = await readJobResponse(res);
			if (d?.error) {
				const errMsg = d.error || 'Failed to list snapshots';
				try { const p = JSON.parse(errMsg); toast.error(p.message || errMsg); } catch { toast.error(errMsg); }
			} else {
				browseSnapshots = d.snapshots ?? d;
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

	const filteredDestinations = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		let rows = destinations.filter(d => {
			if (q && !(
				d.name.toLowerCase().includes(q) ||
				d.repository.toLowerCase().includes(q) ||
				getTypeLabel(d.repository).toLowerCase().includes(q)
			)) return false;
			if (statusFilter !== 'all' && (d.lastTestStatus ?? '') !== statusFilter) return false;
			return true;
		});
		// Sort key per column. 'status' orders by a fixed rank so like statuses group.
		const statusRank: Record<string, number> = { success: 0, needs_init: 1, failed: 2, '': 3 };
		const key = (d: Destination) =>
			destSort.field === 'type' ? getTypeLabel(d.repository) :
			destSort.field === 'repository' ? d.repository :
			destSort.field === 'status' ? String(statusRank[d.lastTestStatus ?? ''] ?? 3) :
			d.name;
		rows = [...rows].sort((a, b) => {
			const ka = key(a).toLowerCase(), kb = key(b).toLowerCase();
			const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
			return destSort.direction === 'asc' ? cmp : -cmp;
		});
		return rows;
	});

	async function fetchData() {
		loading = true;
		repoStats = new Map();
		try {
			const [destRes, configRes, envRes] = await Promise.all([
				fetch('/api/backup/destinations'),
				fetch('/api/backup/configs'),
				fetch('/api/environments')
			]);
			destinations = await destRes.json();
			const configData = await configRes.json();
			configs = Array.isArray(configData) ? configData : [];
			if (envRes.ok) { const envData = await envRes.json(); environments = Array.isArray(envData) ? envData : []; }
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
			<Select.Root type="single" value={statusFilter} onValueChange={(v) => statusFilter = (v as typeof statusFilter) ?? 'all'}>
				<Select.Trigger class="h-8 w-40 text-sm">
					{statusFilter === 'success' ? 'Initialized' : statusFilter === 'needs_init' ? 'Needs init' : statusFilter === 'failed' ? 'Failed' : 'All statuses'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="all">All statuses</Select.Item>
					<Select.Item value="success"><CheckCircle class="w-3.5 h-3.5 text-green-500 mr-1.5 inline" />Initialized</Select.Item>
					<Select.Item value="needs_init"><AlertCircle class="w-3.5 h-3.5 text-amber-500 mr-1.5 inline" />Needs init</Select.Item>
					<Select.Item value="failed"><XCircle class="w-3.5 h-3.5 text-destructive mr-1.5 inline" />Failed</Select.Item>
				</Select.Content>
			</Select.Root>
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
			onSortChange={(s) => destSort = { field: s.field, direction: s.direction }}
			class="border-none"
			wrapperClass="border rounded-lg"
		>
			{#snippet cell(column, dest)}
				{#if column.id === 'type'}
					{@const TypeIcon = getTypeIcon(dest.repository)}
					<div class="flex items-center gap-1.5 min-w-0" title={getTypeLabel(dest.repository)}>
						<TypeIcon class="w-4 h-4 shrink-0 text-muted-foreground" />
						<span class="text-xs text-muted-foreground truncate">{getTypeLabel(dest.repository)}</span>
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
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => verifyDestination(dest)} title="Verify data integrity">
								<FolderCheck class="grid-action-icon grid-action-info text-muted-foreground" />
							</button>
							<ConfirmPopover
								open={confirmAction?.destId === dest.id && confirmAction.task === 'unlock'}
								action="Unlock" itemType="repository" itemName={dest.name} confirmText="Unlock" position="left" title="Unlock repository"
								onConfirm={() => { confirmAction = null; runRepoTask(dest.id, 'unlock'); }}
								onOpenChange={(o) => confirmAction = o ? { destId: dest.id, task: 'unlock' } : null}
							>
								{#snippet children({ open })}
									{#if runningTask?.destId === dest.id && runningTask.task === 'unlock'}<Loader2 class="grid-action-icon text-muted-foreground animate-spin" />{:else}<Unlock class="grid-action-icon grid-action-edit text-muted-foreground" />{/if}
								{/snippet}
							</ConfirmPopover>
							<ConfirmPopover
								open={confirmAction?.destId === dest.id && confirmAction.task === 'prune'}
								action="Prune" itemType="unused data from" itemName={dest.name} confirmText="Prune" variant="destructive" position="left" title="Prune unused data"
								onConfirm={() => { confirmAction = null; runRepoTask(dest.id, 'prune'); }}
								onOpenChange={(o) => confirmAction = o ? { destId: dest.id, task: 'prune' } : null}
							>
								{#snippet children({ open })}
									{#if runningTask?.destId === dest.id && runningTask.task === 'prune'}<Loader2 class="grid-action-icon text-muted-foreground animate-spin" />{:else}<Eraser class="grid-action-icon grid-action-delete {open ? 'text-destructive' : 'text-muted-foreground'}" />{/if}
								{/snippet}
							</ConfirmPopover>
							<ConfirmPopover
								open={confirmAction?.destId === dest.id && confirmAction.task === 'repair'}
								action="Repair" itemType="index for" itemName={dest.name} confirmText="Repair" variant="destructive" position="left" title="Repair index"
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
	<Dialog.Content class="max-w-6xl w-[calc(100vw-4rem)] h-[88vh] flex flex-col overflow-hidden">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<FolderOpen class="w-5 h-5" />
				Repository snapshots on
				<svelte:component this={getRepoTypeIcon(browseDestRepo)} class="w-4 h-4" />
				<span class="text-amber-600 dark:text-amber-400">{browseDestName}</span>
			</Dialog.Title>
		</Dialog.Header>
		{#if !browseLoading && browseSnapshots.length > 0}
			<div class="flex gap-2 pb-3 flex-shrink-0">
				<Input bind:value={browseFilterName} placeholder="Filter by name..." class="h-8 max-w-xs" />
				<Input bind:value={browseFilterEnv} placeholder="Filter by environment..." class="h-8 max-w-xs" />
			</div>
		{/if}
		<div class="flex-1 min-h-0">
			{#if browseLoading}
				<LoadingState class="h-full" label="Loading snapshots..." />
			{:else if browseSnapshots.length === 0}
				<div class="flex h-full items-center justify-center"><p class="text-sm text-muted-foreground">No snapshots in this repository.</p></div>
			{:else}
				<DataGrid
					data={browseGroups}
					keyField="key"
					gridId="repoSnapshots"
					rowHeight={36}
					sortState={{ field: browseGridSort.field, direction: browseGridSort.direction }}
					onSortChange={(s) => browseGridSort = { field: s.field, direction: s.direction }}
					expandable
					bind:expandedKeys={browseExpandedKeys}
					onRowClick={(g) => toggleBrowseGroup(g)}
					class="border-none"
					wrapperClass="border rounded-lg h-full"
				>
					{#snippet cell(column, group, rowState)}
						{#if column.id === 'expand'}
							<button type="button" class="p-0.5 hover:bg-muted rounded transition-colors" onclick={(e) => { e.stopPropagation(); toggleBrowseGroup(group); }}>
								{#if rowState.isExpanded}<ChevronDown class="w-3 h-3" />{:else}<ChevronRight class="w-3 h-3" />{/if}
							</button>
						{:else if column.id === 'name'}
							<span class="inline-flex items-center gap-1.5 min-w-0">
								<span class="text-xs font-medium truncate">{group.name}</span>
								<span class="shrink-0 rounded-full bg-primary/15 px-1.5 text-2xs text-primary">{group.count}</span>
							</span>
						{:else if column.id === 'type'}
							<div class="flex justify-center">
								{#if group.type === 'stack'}
									<Layers class="w-3.5 h-3.5 text-purple-500" />
								{:else}
									<Box class="w-3.5 h-3.5 text-blue-500" />
								{/if}
							</div>
						{:else if column.id === 'environment'}
							{#if group.env && !('missing' in group.env)}
								<span class="inline-flex items-center gap-1.5 text-xs truncate">
									<EnvironmentIcon icon={group.env.icon} envId={group.env.id} class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
									<span class="truncate">{group.env.name}</span>
								</span>
							{:else if group.env}
								<Badge variant="secondary" class="text-2xs font-normal text-muted-foreground">missing</Badge>
							{:else}
								<span class="text-xs text-muted-foreground">—</span>
							{/if}
						{:else if column.id === 'latest'}
							{#if group.latest}
								<span class="text-xs text-muted-foreground">{formatDateTime(group.latest)} <span class="opacity-60">({formatRelativeTime(group.latest)})</span></span>
							{:else}
								<span class="text-xs text-muted-foreground">—</span>
							{/if}
						{:else if column.id === 'snapshots'}
							<span class="text-xs text-muted-foreground">{group.count}</span>
						{/if}
					{/snippet}

					{#snippet expandedRow(group)}
						<div class="px-8 py-2">
							<div class="max-h-64 overflow-y-auto pr-2 rounded-md border bg-muted/20">
								<Table.Root>
									<Table.Header class="sticky top-0 z-10 bg-background">
										<Table.Row>
											<Table.Head class="w-28 py-1.5 text-xs" style="padding-left:8px">ID</Table.Head>
											<Table.Head class="py-1.5 text-xs" style="padding-left:8px">Created</Table.Head>
											<Table.Head class="w-16 py-1.5 text-xs text-right" style="padding-right:8px">Browse</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each group.snapshots as snap}
											<Table.Row class="cursor-pointer hover:bg-muted/50" onclick={() => { snapshotBrowseDestId = browseDestId; snapshotBrowseId = snap.id; snapshotBrowseName = group.name; snapshotBrowseOpen = true; }}>
												<Table.Cell class="font-mono text-xs text-muted-foreground py-1" style="padding-left:8px">{snap.shortId}</Table.Cell>
												<Table.Cell class="text-xs py-1" style="padding-left:8px">{formatDateTime(snap.time)} <span class="text-muted-foreground opacity-60">({formatRelativeTime(snap.time)})</span></Table.Cell>
												<Table.Cell class="text-right py-1">
													<span class="inline-flex p-1 rounded hover:bg-muted transition-colors text-muted-foreground" title="Browse snapshot content">
														<FolderOpen class="w-3.5 h-3.5" />
													</span>
												</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							</div>
						</div>
					{/snippet}
				</DataGrid>
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

<BackupLogModal
	bind:open={actionLogOpen}
	title={actionLogTitle}
	icon={actionLogIcon}
	status={actionLogStatus}
	logs={actionLogLogs}
	error={actionLogError}
/>

<RotatePasswordModal
	bind:open={rotateModalOpen}
	destinationId={rotateDestId}
	destinationName={rotateDestName}
/>
