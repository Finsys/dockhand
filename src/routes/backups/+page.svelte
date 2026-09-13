<svelte:head>
	<title>Backups - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';
	import { formatBytes } from '$lib/utils/format';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { SnapshotLoadProgress } from '$lib/components/ui/snapshot-load-progress';
	import * as Select from '$lib/components/ui/select';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { DataGrid } from '$lib/components/data-grid';
	import type { DataGridRowState } from '$lib/components/data-grid';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import {
		Archive, Box, Layers, ChevronDown, ChevronRight, RefreshCw, Search, Play, Pause, Trash2, FolderOpen, RotateCcw,
		CheckCircle, XCircle, AlertCircle, Loader2, Clock, X, ArrowLeftRight, Package, Pencil
	} from 'lucide-svelte';
	import RotateCwFadingClock from '$lib/components/icons/RotateCwFadingClock.svelte';
	import { formatDateTime, formatRelativeTime } from '$lib/stores/settings';
	import { currentEnvironment } from '$lib/stores/environment';
	import { watchJob, readJobResponse } from '$lib/utils/sse-fetch';
	import { getRepoTypeIcon, formatCron, retentionSummary, classifyJobResult, tagLogLine } from '$lib/utils/backup';
	import SnapshotBrowser from '../containers/SnapshotBrowser.svelte';
	import RestoreModal from '../containers/RestoreModal.svelte';
	import BackupLogModal from './BackupLogModal.svelte';
	import SnapshotDiffModal from './SnapshotDiffModal.svelte';
	import CreateBackupModal from './CreateBackupModal.svelte';
	import EditBackupConfigModal from './EditBackupConfigModal.svelte';
	import ContainerIcon from '$lib/components/ContainerIcon.svelte';

	interface BackupConfig {
		key: string;
		id: number;
		type: 'container' | 'stack';
		targetName: string;
		environmentId: number | null;
		destinationId: number;
		enabled: boolean;
		schedule: string | null;
		retention: string | null;
		lastBackupAt: string | null;
		lastBackupStatus: string | null;
		// Joined data
		environmentName?: string;
		environmentIcon?: string;
		destinationName?: string;
		destinationRepository?: string;
		// Orphan flag: found in repo but no config
		isOrphan?: boolean;
	}

	interface Snapshot {
		id: string;
		shortId: string;
		time: string;
		hostname: string;
		tags: string[] | null;
		paths: string[];
		// Attached by loadSnapshots so the Repo column shows an icon + name. For orphans
		// (searched across all destinations) it comes per-snapshot; for a config's own
		// snapshots it falls back to the config's destination.
		_destinationId?: number;
		_destinationName?: string;
		_destinationRepository?: string;
	}

	interface Destination {
		id: number;
		name: string;
		repository: string;
	}

	interface Environment {
		id: number;
		name: string;
		icon?: string;
	}

	let configs = $state<BackupConfig[]>([]);
	let destinations = $state<Destination[]>([]);
	let environments = $state<Environment[]>([]);
	let loading = $state(true);
	let searchQuery = $state('');
	let filterType = $state<string>('');
	let filterEnvId = $state<string>('');
	let filterStatus = $state<string>('');
	let sortField = $state('targetName');
	let sortDirection = $state<'asc' | 'desc'>('asc');
	let filterDestId = $state<string>('');

	// Expand state
	let expandedKeys = $state<Set<string>>(new Set());
	let snapshotsMap = $state<Map<string, Snapshot[]>>(new Map());
	let loadingSnapshots = $state<Set<string>>(new Set());
	// Map of snapshotId → { filesNew, filesChanged, dataAdded }
	let snapshotStats = $state<Map<string, { filesNew: number; filesChanged: number; dataAdded: number }>>(new Map());

	const SNAPSHOT_PAGE_SIZE = 10;
	let snapshotLimits = $state<Map<string, number>>(new Map());

	// Snapshot counts loaded async per destination, keyed by targetName:destId
	let snapshotCounts = $state<Map<string, number>>(new Map());
	let snapshotCountsLoading = $state(true);
	// Progress of the per-destination snapshot count sweep: how many destinations have
	// responded out of the total. Drives an "X / N" indicator so a slow/unreachable
	// repo (backend restic timeout is 5 min) shows visible progress instead of an
	// indeterminate spinner. done === total means the sweep finished.
	let snapshotCountsDone = $state(0);
	let snapshotCountsTotal = $state(0);
	// Orphan targets: found in repos but no config exists
	interface OrphanTarget { key: string; targetName: string; type: string; destinationId: number; destinationName?: string; destinationRepository?: string; snapshotCount: number; latestSnapshot?: string; }
	let orphanTargets = $state<OrphanTarget[]>([]);
	let showCreateModal = $state(false);

	// Action states
	let runningBackup = $state<number | null>(null);
	let lastError = $state<{ configId: number; message: string } | null>(null);

	// Backup progress modal (Play on a config — restore shows its log inline).
	let logModalOpen = $state(false);
	let logModalTitle = $state('');
	let logModalProgress = $state(0);
	let logModalStatus = $state<'running' | 'success' | 'error'>('running');
	let logModalLogs = $state<string[]>([]);
	let logModalError = $state('');
	let logModalConfigId = $state<number | null>(null);
	// True once the backup passes the point cancel can still stop it: restic is done,
	// the snapshot exists, and only repo-only phases (verify / retention) remain — these
	// run in-process and aren't killable, so we disable Cancel rather than let it lie.
	let logModalPastCancel = $state(false);
	const canCancelBackup = $derived(logModalStatus === 'running' && !logModalPastCancel);

	async function stopBackup() {
		if (!logModalConfigId) return;
		try {
			const res = await fetch(`/api/backup/configs/${logModalConfigId}/stop`, { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			// Only declare it cancelled if the backend actually signalled a running
			// helper. If it was already past the point of no return (restic done,
			// applying retention), `stopped` is false — let the real progress stream
			// finish and report the true 'Completed' status instead of a false 'Cancelled'.
			if (body?.stopped) {
				logModalLogs = [...logModalLogs, '⚠ Backup cancelled by user'];
				logModalStatus = 'error';
				logModalError = 'Cancelled';
			} else {
				logModalLogs = [...logModalLogs, 'Backup is finishing and can no longer be cancelled.'];
				toast.info('Backup was already finishing — it will complete.');
			}
		} catch { toast.error('Failed to stop backup'); }
	}
	let confirmDeleteSnapshot = $state<string | null>(null);
	let deletingSnapshot = $state<string | null>(null);
	let confirmDeleteConfig = $state<number | null>(null);
	let deletingConfig = $state<number | null>(null);
	let togglingConfig = $state<number | null>(null);
	// Edit-config modal (reuses the container/stack Backups tab — BackupPanel).
	let editModalOpen = $state(false);
	let editConfig = $state<BackupConfig | null>(null);

	// Snapshot browser / restore
	let showBrowser = $state(false);
	let browserDestId = $state(0);
	let browserSnapshotId = $state('');
	let browserTargetName = $state('');
	let browserTargetType = $state<'container' | 'stack'>('container');
	let browserEnvId = $state<number | undefined>(undefined);
	let showRestore = $state(false);
	let restoreDestId = $state(0);
	let restoreSnapshotId = $state('');
	let restoreContainerName = $state('');
	let restoreEnvId = $state<number | undefined>(undefined);
	let restoreDestName = $state('');
	let restoreDestRepo = $state('');

	// Snapshot diff
	let showDiff = $state(false);
	let diffDestId = $state(0);
	let diffSnapA = $state<{ id: string; shortId: string; time: string }>({ id: '', shortId: '', time: '' });
	let diffSnapB = $state<{ id: string; shortId: string; time: string }>({ id: '', shortId: '', time: '' });
	// Single pending snapshot for diff — click one to select, click another to compare
	let diffPending = $state<{ snapshot: any; configDestId: number } | null>(null);

	function toggleDiffSnapshot(snapshot: any, configDestId: number) {
		if (diffPending?.snapshot.id === snapshot.id) {
			// Deselect
			diffPending = null;
		} else if (diffPending) {
			// Second selection — open diff (older first)
			const snaps = [diffPending.snapshot, snapshot];
			snaps.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
			diffDestId = snaps[0]._destinationId || configDestId;
			diffSnapA = snaps[0];
			diffSnapB = snaps[1];
			showDiff = true;
			diffPending = null;
		} else {
			// First selection
			diffPending = { snapshot, configDestId };
		}
	}

	const getDestIcon = getRepoTypeIcon;

	// Convert orphans to pseudo-configs for unified grid
	const orphanAsConfigs = $derived<BackupConfig[]>(orphanTargets.map(o => ({
		key: o.key,
		id: 0,
		type: o.type as 'container' | 'stack',
		targetName: o.targetName,
		environmentId: null,
		destinationId: o.destinationId,
		enabled: false,
		schedule: null,
		retention: null,
		lastBackupAt: o.latestSnapshot || null,
		lastBackupStatus: null,
		destinationName: o.destinationName,
		destinationRepository: o.destinationRepository,
		isOrphan: true
	})));

	const filteredConfigs = $derived.by(() => {
		let result = [...configs, ...orphanAsConfigs];
		if (filterType) result = result.filter(c => c.type === filterType);
		if (filterDestId) result = result.filter(c => String(c.destinationId) === filterDestId);
		if (filterEnvId) result = result.filter(c => String(c.environmentId) === filterEnvId);
		if (filterStatus === 'success') result = result.filter(c => c.lastBackupStatus === 'success');
		else if (filterStatus === 'failed') result = result.filter(c => c.lastBackupStatus === 'failed');
		else if (filterStatus === 'orphan') result = result.filter(c => c.isOrphan);
		else if (filterStatus === 'scheduled') result = result.filter(c => !c.isOrphan);
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter(c =>
				c.targetName.toLowerCase().includes(q) ||
				c.environmentName?.toLowerCase().includes(q) ||
				c.destinationName?.toLowerCase().includes(q)
			);
		}
		// Sort
		if (sortField) {
			result.sort((a: any, b: any) => {
				const va = a[sortField] ?? '';
				const vb = b[sortField] ?? '';
				const cmp = String(va).localeCompare(String(vb));
				return sortDirection === 'desc' ? -cmp : cmp;
			});
		}
		return result;
	});

	// Health stats derived from configs
	const healthStats = $derived.by(() => {
		const total = configs.length;
		const healthy = configs.filter(c => c.lastBackupStatus === 'success').length;
		const failed = configs.filter(c => c.lastBackupStatus === 'failed').length;
		const neverRun = configs.filter(c => !c.lastBackupStatus).length;
		const scheduled = configs.filter(c => c.enabled && c.schedule).length;
		const orphans = orphanTargets.length;

		// Stale: last backup > 48h ago for scheduled configs
		const staleThreshold = Date.now() - 48 * 60 * 60 * 1000;
		const stale = configs.filter(c => {
			if (!c.enabled || !c.schedule || !c.lastBackupAt) return false;
			return new Date(c.lastBackupAt).getTime() < staleThreshold;
		}).length;

		return { total, healthy, failed, neverRun, scheduled, orphans, stale };
	});

	async function fetchData() {
		loading = true;
		// Clear stale data before refresh
		snapshotsMap = new Map();
		snapshotCounts = new Map();
		orphanTargets = [];
		try {
			const [configRes, destRes, envRes] = await Promise.all([
				fetch('/api/backup/configs'),
				fetch('/api/backup/destinations'),
				fetch('/api/environments')
			]);
			const rawConfigs = await configRes.json();
			destinations = await destRes.json();
			environments = await envRes.json();

			// Join destination and environment data
			configs = (Array.isArray(rawConfigs) ? rawConfigs : []).map((c: any) => {
				const dest = destinations.find(d => d.id === c.destinationId);
				const env = environments.find(e => e.id === c.environmentId);
				return {
					...c,
					key: `backup-${c.id}`,
					environmentName: env?.name,
					environmentIcon: (env as any)?.icon,
					destinationName: dest?.name,
					destinationRepository: dest?.repository
				};
			});
		} catch (error) {
			console.error('Failed to fetch backup data:', error);
			toast.error('Failed to load backups');
		} finally {
			loading = false;
		}
		// Kick off async snapshot count loading
		loadSnapshotCounts();

		// fetchData() cleared snapshotsMap, but any EXPANDED config still shows its
		// (now-empty) snapshot list — reload those so an expanded row doesn't flip to
		// "No snapshots yet" after a refresh (e.g. right after a restore completes).
		for (const config of configs) {
			if (expandedKeys.has(config.key)) void loadSnapshots(config);
		}
	}

	async function loadSnapshotCounts() {
		snapshotCountsLoading = true;
		snapshotCountsDone = 0;
		snapshotCountsTotal = destinations.length;
		// Live config ids per destination — a snapshot's dockhand:configid tag matching
		// one of these belongs to a shown config; anything else is orphaned.
		const liveConfigIds = new Set(configs.map(c => c.id));

		// This install's id, fetched once: a snapshot is a LOCAL config's only when THIS
		// instance wrote it (configid collides across installs - #1351). Formerly read from
		// the snapshots list's X-Dockhand-Instance header, which job polling can't carry.
		const thisInstance = await fetch('/api/backup/instance')
			.then(r => r.ok ? r.json() : { instanceId: '' })
			.then(d => d.instanceId || '')
			.catch(() => '');

		// Query each destination once, then split its snapshots two ways: PER CONFIG
		// (by dockhand:configid) for the shown rows, and PER NAME for the orphan rows
		// (snapshots whose config was deleted). The right-column count must match the
		// expanded per-config list, so it's keyed by config, NOT by target name — two
		// configs backing the same container to the same repo have DIFFERENT counts.
		//
		// Each destination updates snapshotCounts as soon as IT responds, and the
		// "Loading" indicator clears after the FIRST one finishes - so a single slow or
		// unreachable repo can't hold the whole list hostage for its 30s timeout. The
		// rest keep filling in counts progressively behind the scenes.
		await Promise.allSettled(destinations.map(async (dest) => {
			try {
				// Job-polling so a slow `restic snapshots` behind a proxy isn't aborted at ~15s.
				const res = await fetch(`/api/backup/snapshots?destinationId=${dest.id}`, {
					headers: { Accept: 'text/event-stream' }
				});
				const d = await readJobResponse(res);
				if (!d || d.error) return;
				const snaps: any[] = d.snapshots ?? d;
				if (!Array.isArray(snaps)) return;

				const tagVal = (snap: any, prefix: string): string | undefined =>
					(snap.tags || []).find((t: string) => t.startsWith(prefix))?.slice(prefix.length);

				// Per-config counts (keyed by config.key = `backup-<id>`), and per-name
				// buckets of snapshots that belong to NO live config (orphans).
				const perConfig = new Map<number, number>();
				const orphanByName = new Map<string, any[]>();
				for (const snap of snaps) {
					const cid = Number(tagVal(snap, "dockhand:configid="));
					const isOwn = tagVal(snap, "dockhand:instance=") === thisInstance;
					if (isOwn && Number.isInteger(cid) && liveConfigIds.has(cid)) {
						perConfig.set(cid, (perConfig.get(cid) || 0) + 1);
					} else {
						const name = tagVal(snap, 'dockhand:name=') || 'unknown';
						const arr = orphanByName.get(name) || [];
						arr.push(snap);
						orphanByName.set(name, arr);
					}
				}

				const newCounts = new Map(snapshotCounts);
				for (const [cid, count] of perConfig) newCounts.set(`backup-${cid}`, count);

				const newOrphans = [...orphanTargets];
				for (const [name, orphanSnaps] of orphanByName) {
					newCounts.set(`orphan-${name}-${dest.id}`, orphanSnaps.length);
					if (!newOrphans.some(o => o.key === `orphan-${name}-${dest.id}`)) {
						const typeTag = (orphanSnaps[0]?.tags || []).find((t: string) => t.startsWith('dockhand:type='));
						newOrphans.push({
							key: `orphan-${name}-${dest.id}`,
							targetName: name,
							type: typeTag?.replace('dockhand:type=', '') || 'container',
							destinationId: dest.id,
							destinationName: dest.name,
							destinationRepository: dest.repository,
							snapshotCount: orphanSnaps.length,
							latestSnapshot: orphanSnaps[0]?.time
						});
					}
				}
				snapshotCounts = newCounts;
				orphanTargets = newOrphans;
			} catch {} finally { snapshotCountsDone += 1; }
		}));

		// Backstop: if there were zero destinations, nothing cleared it above.
		snapshotCountsLoading = false;
	}

	async function loadSnapshots(config: BackupConfig) {
		const key = config.key;
		const newLoading = new Set(loadingSnapshots);
		newLoading.add(key);
		loadingSnapshots = newLoading;

		try {
			// Query snapshots for this config's destination only (not allDestinations).
			// Job-polling so a slow `restic snapshots` behind a proxy isn't aborted at ~15s.
			const snapUrl = config.isOrphan
				? `/api/backup/snapshots?destinationId=${config.destinationId}`
				: `/api/backup/snapshots?configId=${config.id}`;
			const [snapJson, execRes] = await Promise.all([
				fetch(snapUrl, { headers: { Accept: 'text/event-stream' } }).then(readJobResponse),
				config.isOrphan ? Promise.resolve(new Response('{"executions":[]}')) : fetch(`/api/schedules/executions?scheduleType=backup&scheduleId=${config.id}&limit=50`)
			]);
			const snapError = snapJson?.error;
			let snapData = snapJson?.snapshots ?? snapJson;
			// For orphans, filter by target name (they can span destinations).
			if (config.isOrphan && Array.isArray(snapData)) {
				snapData = snapData.filter((s: any) => (s.tags || []).some((t: string) => t === `dockhand:name=${config.targetName}`));
			}
			// Attach the destination name + repository to every snapshot so the Repo
			// column shows an icon + name (not only for orphans — regular configs need
			// it too). Prefer per-snapshot dest info when present (multi-destination
			// searches), else fall back to the config's destination.
			if (Array.isArray(snapData)) {
				snapData = snapData.map((s: any) => ({
					...s,
					_destinationId: s._destinationId ?? config.destinationId,
					_destinationName: s._destinationName ?? config.destinationName,
					_destinationRepository: s._destinationRepository ?? config.destinationRepository
				}));
			}
			const newMap = new Map(snapshotsMap);
			if (!snapError) {
				newMap.set(key, Array.isArray(snapData) ? snapData : []);
			} else {
				newMap.set(key, []);
				toast.error(cleanErrorMessage(snapError || 'Failed to load snapshots'));
			}
			snapshotsMap = newMap;

			// Build snapshotId → stats map from executions
			if (execRes.ok) {
				const execData = await execRes.json();
				const newStats = new Map(snapshotStats);
				for (const exec of execData.executions || []) {
					if (exec.details?.snapshotId) {
						newStats.set(exec.details.snapshotId, {
							filesNew: exec.details.filesNew ?? 0,
							filesChanged: exec.details.filesChanged ?? 0,
							dataAdded: exec.details.dataAdded ?? 0
						});
					}
				}
				snapshotStats = newStats;
			}
		} catch (error) {
			const newMap = new Map(snapshotsMap);
			newMap.set(key, []);
			snapshotsMap = newMap;
			toast.error('Failed to load snapshots');
		} finally {
			const newLoading = new Set(loadingSnapshots);
			newLoading.delete(key);
			loadingSnapshots = newLoading;
		}
	}

	function toggleExpand(config: BackupConfig) {
		const newSet = new Set(expandedKeys);
		if (newSet.has(config.key)) {
			newSet.delete(config.key);
		} else {
			newSet.add(config.key);
			if (!snapshotsMap.has(config.key)) {
				loadSnapshots(config);
			}
		}
		expandedKeys = newSet;
	}

	function handleExpandChange(key: unknown, expanded: boolean) {
		const config = configs.find(c => c.key === key);
		if (config && expanded && !snapshotsMap.has(config.key)) {
			loadSnapshots(config);
		}
	}

	async function runBackupNow(config: BackupConfig) {
		runningBackup = config.id;
		lastError = null;
		logModalTitle = `Backup: ${config.targetName}`;
		logModalConfigId = config.id;
		logModalStatus = 'running';
		logModalLogs = [];
		logModalError = '';
		logModalProgress = 0;
		logModalPastCancel = false;
		logModalOpen = true;
		try {
			const res = await fetch(`/api/backup/configs/${config.id}/run`, { method: 'POST' });
			const data = await res.json();
			if (data.jobId) {
				const result = await watchJob(data.jobId, (line) => {
					const d = line.data as any;
					if (line.event === 'progress' && d?.message) {
						logModalLogs = [...logModalLogs, tagLogLine(d.message)];
						// Once restic is done and only repo-only phases remain, cancel can no
						// longer stop the backup — the snapshot already exists. Disable Cancel.
						if (d.status === 'verifying' || d.status === 'pruning' || d.status === 'restarted') {
							logModalPastCancel = true;
						}
						// (audit #15) Prefer the structured restic percent from detail;
						// fall back to the free-form "XX% done" message regex.
						if (d.status === 'progress' && typeof d.detail?.percent_done === 'number') {
							logModalProgress = Math.round(d.detail.percent_done * 100);
						} else {
							const pctMatch = d.message.match(/^(\d+)% done$/);
							if (pctMatch) logModalProgress = parseInt(pctMatch[1]);
						}
					}
				}) as any;
				const { outcome, message } = classifyJobResult(result);
				if (outcome === 'error') {
					logModalStatus = 'error';
					logModalError = message || 'Backup failed';
					lastError = { configId: config.id, message: message || 'Backup failed' };
				} else if (outcome === 'skipped') {
					// Rejected (already running, or retention would wipe) — not a success.
					logModalStatus = 'error';
					logModalError = message || 'Backup skipped';
					toast.info(message || 'Backup skipped');
				} else {
					logModalStatus = 'success';
					if (outcome === 'warning') toast.warning(message || `Backup completed with warnings for ${config.targetName}`);
					else toast.success(`Backup completed for ${config.targetName}`);
				}
				loadSnapshots(config);
				fetchData();
			} else if (data.error) {
				logModalStatus = 'error';
				logModalError = data.error;
				lastError = { configId: config.id, message: data.error };
			}
		} catch (err: any) {
			logModalStatus = 'error';
			logModalError = err.message || 'Failed to start backup';
			lastError = { configId: config.id, message: err.message || 'Failed to start backup' };
		} finally {
			runningBackup = null;
		}
	}

	// The Create-backup wizard hands off a freshly-saved config here to run through the
	// shared BackupLogModal (same as Run-now), instead of an embedded log.
	async function runBackupNowById({ configId }: { configId: number; targetName: string }) {
		await fetchData();
		const config = configs.find((c) => c.id === configId);
		if (config) runBackupNow(config);
	}

	// Delete a backup CONFIG (its schedule too — the server unregisters it). The
	// snapshots already in the repo are NOT touched; the target then shows as an
	// Pause/resume a scheduled backup. A minimal PUT with only `enabled` is a
	// partial update (the endpoint skips undefined fields) and re-registers or
	// unregisters the croner job accordingly.
	async function togglePause(config: BackupConfig) {
		togglingConfig = config.id;
		try {
			const res = await fetch(`/api/backup/configs/${config.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: !config.enabled })
			});
			if (res.ok) {
				toast.success(config.enabled ? 'Schedule paused' : 'Schedule resumed');
				fetchData();
			} else {
				toast.error('Failed to update schedule');
			}
		} catch { toast.error('Failed to update schedule'); }
		togglingConfig = null;
	}

	// orphan if any snapshots remain.
	async function deleteConfig(config: BackupConfig) {
		deletingConfig = config.id;
		try {
			const res = await fetch(`/api/backup/configs/${config.id}`, { method: 'DELETE' });
			if (res.ok) {
				toast.success(`Backup config removed for ${config.targetName}`);
				fetchData();
			} else {
				const data = await res.json().catch(() => ({}));
				toast.error(data.error || 'Failed to delete backup config');
			}
		} catch (err: any) {
			toast.error(err?.message || 'Failed to delete backup config');
		} finally {
			deletingConfig = null;
			confirmDeleteConfig = null;
		}
	}

	async function deleteSnapshot(config: BackupConfig, snapshot: any) {
		deletingSnapshot = snapshot.id;
		const destId = snapshot._destinationId || config.destinationId;
		try {
			const res = await fetch(`/api/backup/snapshots/${snapshot.id}?destinationId=${destId}`, {
				method: 'DELETE'
			});
			if (res.ok) {
				toast.success('Snapshot deleted');
				await loadSnapshots(config);
				// Update the async snapshot count (keyed per config, matching the column)
				const loaded = snapshotsMap.get(config.key);
				if (loaded !== undefined) {
					snapshotCounts = new Map(snapshotCounts).set(config.key, loaded.length);
				}
			} else {
				const data = await res.json();
				toast.error(data.error || 'Failed to delete snapshot');
			}
		} catch {
			toast.error('Failed to delete snapshot');
		} finally {
			deletingSnapshot = null;
			confirmDeleteSnapshot = null;
		}
	}

	function openBrowser(config: BackupConfig, snapshot: any) {
		browserDestId = snapshot._destinationId || config.destinationId;
		browserSnapshotId = snapshot.id;
		browserTargetName = config.targetName;
		browserTargetType = config.type as 'container' | 'stack';
		showBrowser = true;
	}

	function openRestore(config: BackupConfig, snapshot: any) {
		restoreDestId = snapshot._destinationId || config.destinationId;
		restoreSnapshotId = snapshot.id;
		restoreContainerName = config.targetName;
		restoreEnvId = config.environmentId ?? undefined;
		restoreDestName = snapshot._destinationName ?? config.destinationName ?? '';
		restoreDestRepo = snapshot._destinationRepository ?? config.destinationRepository ?? '';
		showRestore = true;
	}

	function cleanErrorMessage(msg: string): string {
		// Try full JSON parse first
		try { const p = JSON.parse(msg); if (p.message) return p.message; } catch {}
		// Try extracting embedded JSON with "message" field
		const jsonStart = msg.indexOf('{');
		const jsonEnd = msg.lastIndexOf('}');
		if (jsonStart >= 0 && jsonEnd > jsonStart) {
			try {
				const parsed = JSON.parse(msg.slice(jsonStart, jsonEnd + 1));
				if (parsed.message) {
					const prefix = msg.slice(0, jsonStart).trim();
					return prefix ? `${prefix} ${parsed.message}` : parsed.message;
				}
			} catch {}
		}
		return msg;
	}



	onMount(() => { fetchData(); });
</script>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<PageHeader title="Backups" icon={Archive} count={filteredConfigs.length}>
			{#if loading}
				<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Loader2 class="w-3.5 h-3.5 animate-spin" />
					Loading…
				</span>
			{:else if snapshotCountsLoading}
				<SnapshotLoadProgress done={snapshotCountsDone} total={snapshotCountsTotal} />
			{/if}
		</PageHeader>
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative">
				<Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				<Input bind:value={searchQuery} placeholder="Filter backups..." class="pl-8 h-8 w-48 text-sm" />
			</div>
			<Select.Root type="single" value={filterType} onValueChange={(v) => { filterType = v === 'all' ? '' : v; }}>
				<Select.Trigger class="h-8 w-32 text-xs">
					{#if filterType === 'container'}<Box class="w-3 h-3 mr-1 text-muted-foreground" />Containers
					{:else if filterType === 'stack'}<Layers class="w-3 h-3 mr-1 text-muted-foreground" />Stacks
					{:else}All types{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="all">All types</Select.Item>
					<Select.Item value="container"><Box class="w-3 h-3 mr-1.5 inline text-muted-foreground" />Containers</Select.Item>
					<Select.Item value="stack"><Layers class="w-3 h-3 mr-1.5 inline text-muted-foreground" />Stacks</Select.Item>
				</Select.Content>
			</Select.Root>
			<Select.Root type="single" value={filterEnvId} onValueChange={(v) => { filterEnvId = v === 'all' ? '' : v; }}>
				<Select.Trigger class="h-8 w-36 text-xs">
					{@const env = environments.find(e => String(e.id) === filterEnvId)}
					{#if env}
						<EnvironmentIcon icon={env.icon || 'globe'} envId={env.id} class="w-3 h-3 mr-1 text-muted-foreground" />{env.name}
					{:else}All envs{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="all">All environments</Select.Item>
					{#each environments as env}
						<Select.Item value={String(env.id)}>
							<EnvironmentIcon icon={env.icon || 'globe'} envId={env.id} class="w-3 h-3 mr-1.5 inline text-muted-foreground" />{env.name}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<Select.Root type="single" value={filterDestId} onValueChange={(v) => { filterDestId = v === 'all' ? '' : v; }}>
				<Select.Trigger class="h-8 w-36 text-xs">
					{@const dest = destinations.find(d => String(d.id) === filterDestId)}
					{#if dest}{dest.name}{:else}All repos{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="all">All repositories</Select.Item>
					{#each destinations as dest}
						<Select.Item value={String(dest.id)}>{dest.name}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<Select.Root type="single" value={filterStatus} onValueChange={(v) => { filterStatus = v === 'all' ? '' : v; }}>
				<Select.Trigger class="h-8 w-32 text-xs">
					{#if filterStatus === 'success'}<CheckCircle class="w-3 h-3 mr-1 text-green-500" />Success
					{:else if filterStatus === 'failed'}<XCircle class="w-3 h-3 mr-1 text-destructive" />Failed
					{:else if filterStatus === 'orphan'}<AlertCircle class="w-3 h-3 mr-1 text-amber-500" />No schedule
					{:else if filterStatus === 'scheduled'}<Clock class="w-3 h-3 mr-1 text-muted-foreground" />Scheduled
					{:else}All status{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="all">All status</Select.Item>
					<Select.Item value="success"><CheckCircle class="w-3 h-3 mr-1 inline text-green-500" />Success</Select.Item>
					<Select.Item value="failed"><XCircle class="w-3 h-3 mr-1 inline text-destructive" />Failed</Select.Item>
					<Select.Item value="orphan"><AlertCircle class="w-3 h-3 mr-1 inline text-amber-500" />No schedule</Select.Item>
					<Select.Item value="scheduled"><Clock class="w-3 h-3 mr-1 inline text-muted-foreground" />Scheduled</Select.Item>
				</Select.Content>
			</Select.Root>
			<Button size="sm" variant="outline" onclick={fetchData} disabled={loading}>
				<RefreshCw class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
			</Button>
			<Button size="sm" onclick={() => showCreateModal = true}>
				<Package class="w-3.5 h-3.5 mr-1" />Backup
			</Button>
		</div>
	</div>

	{#if !loading && configs.length > 0}
		<div class="shrink-0 flex flex-wrap items-center gap-3 text-xs text-muted-foreground px-1 pb-1">
			{#if healthStats.healthy > 0}
				<span class="flex items-center gap-1"><CheckCircle class="w-3 h-3 text-green-500" />{healthStats.healthy} healthy</span>
			{/if}
			{#if healthStats.failed > 0}
				<span class="flex items-center gap-1"><XCircle class="w-3 h-3 text-destructive" />{healthStats.failed} failed</span>
			{/if}
			{#if healthStats.stale > 0}
				<span class="flex items-center gap-1"><AlertCircle class="w-3 h-3 text-amber-500" />{healthStats.stale} stale</span>
			{/if}
			{#if healthStats.neverRun > 0}
				<span class="flex items-center gap-1"><Clock class="w-3 h-3" />{healthStats.neverRun} never run</span>
			{/if}
			{#if healthStats.orphans > 0}
				<span class="flex items-center gap-1"><AlertCircle class="w-3 h-3 text-amber-500" />{healthStats.orphans} orphan{healthStats.orphans !== 1 ? 's' : ''}</span>
			{/if}
			<span class="text-muted-foreground/50">·</span>
			<span>{healthStats.scheduled} scheduled</span>
		</div>
	{/if}

	<div class="flex-1 min-h-0 flex flex-col">
	{#if configs.length === 0 && orphanTargets.length === 0 && !loading && !snapshotCountsLoading}
		<div class="flex flex-col items-center justify-center py-16 text-center">
			<Archive class="w-12 h-12 text-muted-foreground/30 mb-4" />
			<h3 class="text-lg font-medium mb-1">No backups configured</h3>
			<p class="text-sm text-muted-foreground">Configure backups on individual containers or stacks via their edit modal.</p>
		</div>
	{:else}
		<!-- virtualScroll is OFF here on purpose: it assumes a fixed rowHeight, but an
		     expanded config renders a variable-height snapshot list, so the fixed-height
		     spacers mis-size the scroll area (flicker + endless scroll). Backup configs
		     number in the dozens, so plain rendering - the browser measures real heights -
		     is correct and fast. -->
		<DataGrid
			data={filteredConfigs}
			keyField="key"
			gridId="backups"
			loading={loading}
			virtualScroll={false}
			sortState={{ field: sortField, direction: sortDirection }}
			onSortChange={(state) => { sortField = state.field; sortDirection = state.direction; }}
			bind:expandedKeys={expandedKeys}
			onExpandChange={handleExpandChange}
			onRowClick={(config) => toggleExpand(config)}
			class="border-none"
			wrapperClass="border rounded-lg"
		>
			{#snippet cell(column, config, rowState)}
				{#if column.id === 'expand'}
					<button
						type="button"
						class="p-0.5 hover:bg-muted rounded transition-colors"
						onclick={(e) => { e.stopPropagation(); toggleExpand(config); }}
					>
						{#if rowState.isExpanded}
							<ChevronDown class="w-3 h-3" />
						{:else}
							<ChevronRight class="w-3 h-3" />
						{/if}
					</button>
				{:else if column.id === 'name'}
					<div class="flex items-center gap-1.5 min-w-0">
						<ContainerIcon image="" name={config.targetName} class="w-3.5 h-3.5" fallbackIcon={config.type === 'stack' ? Layers : Box} showFallbackWhenOff />
						<span class="text-xs font-medium truncate">{config.targetName}</span>
					</div>
				{:else if column.id === 'type'}
					<div class="flex justify-center">
						{#if config.type === 'container'}
							<Tooltip.Root><Tooltip.Trigger><Box class="w-3 h-3 text-muted-foreground" /></Tooltip.Trigger><Tooltip.Content>Container backup</Tooltip.Content></Tooltip.Root>
						{:else}
							<Tooltip.Root><Tooltip.Trigger><Layers class="w-3 h-3 text-muted-foreground" /></Tooltip.Trigger><Tooltip.Content>Stack backup</Tooltip.Content></Tooltip.Root>
						{/if}
					</div>
				{:else if column.id === 'environment'}
					{#if config.environmentName}
						<div class="flex items-center gap-1.5 text-xs truncate">
							<EnvironmentIcon icon={config.environmentIcon || 'globe'} envId={config.environmentId || 0} class="w-3 h-3 text-muted-foreground shrink-0" />
							<span class="truncate">{config.environmentName}</span>
						</div>
					{:else}
						<span class="text-xs text-muted-foreground">—</span>
					{/if}
				{:else if column.id === 'repository'}
					{#if config.destinationName && config.destinationRepository}
						{@const DestIcon = getDestIcon(config.destinationRepository)}
						<Tooltip.Root>
							<Tooltip.Trigger>
								<div class="flex items-center gap-1.5 text-xs truncate">
									<DestIcon class="w-3 h-3 text-muted-foreground shrink-0" />
									<span class="truncate">{config.destinationName}</span>
								</div>
							</Tooltip.Trigger>
							<Tooltip.Content><span class="font-mono text-xs">{config.destinationRepository}</span></Tooltip.Content>
						</Tooltip.Root>
					{:else}
						<span class="text-xs text-muted-foreground">—</span>
					{/if}
				{:else if column.id === 'snapshots'}
					{@const asyncCount = snapshotCounts.get(config.key)}
					<div class="flex justify-center">
						{#if asyncCount !== undefined}
							<span class="text-xs">{asyncCount}</span>
						{:else if snapshotCountsLoading}
							<Loader2 class="w-3 h-3 animate-spin text-muted-foreground" />
						{:else}
							<span class="text-xs text-muted-foreground">0</span>
						{/if}
					</div>
				{:else if column.id === 'lastBackup'}
					{#if config.lastBackupAt}
						<span class="text-xs">{formatDateTime(config.lastBackupAt)} <span class="text-muted-foreground opacity-60">({formatRelativeTime(config.lastBackupAt)})</span></span>
					{:else}
						<span class="text-xs text-muted-foreground">Never</span>
					{/if}
				{:else if column.id === 'retention'}
					{@const summary = retentionSummary(config.retention)}
					{#if summary}
						<span class="text-xs text-muted-foreground">{summary}</span>
					{:else}
						<span class="text-xs text-muted-foreground">—</span>
					{/if}
				{:else if column.id === 'schedule'}
					{#if config.isOrphan}
						<span class="text-xs text-amber-500">no schedule</span>
					{:else if config.schedule}
						<span class="text-xs text-muted-foreground" title={config.schedule}>{formatCron(config.schedule)}</span>
					{:else}
						<span class="text-xs text-muted-foreground">—</span>
					{/if}
				{:else if column.id === 'status'}
					<div class="flex items-center justify-center">
						{#if config.isOrphan}
							<Tooltip.Root><Tooltip.Trigger><AlertCircle class="w-3 h-3 text-amber-500" /></Tooltip.Trigger><Tooltip.Content>No schedule — snapshots found in repository</Tooltip.Content></Tooltip.Root>
						{:else if runningBackup === config.id}
							<Tooltip.Root><Tooltip.Trigger><Loader2 class="w-3 h-3 text-primary animate-spin" /></Tooltip.Trigger><Tooltip.Content>Backup in progress</Tooltip.Content></Tooltip.Root>
						{:else if config.lastBackupStatus === 'success'}
							<Tooltip.Root><Tooltip.Trigger><CheckCircle class="w-3 h-3 text-green-500" /></Tooltip.Trigger><Tooltip.Content>Last backup succeeded</Tooltip.Content></Tooltip.Root>
						{:else if config.lastBackupStatus === 'failed'}
							<Tooltip.Root><Tooltip.Trigger><XCircle class="w-3 h-3 text-destructive" /></Tooltip.Trigger><Tooltip.Content>Last backup failed</Tooltip.Content></Tooltip.Root>
						{:else}
							<Tooltip.Root><Tooltip.Trigger><AlertCircle class="w-3 h-3 text-muted-foreground" /></Tooltip.Trigger><Tooltip.Content>No backup run yet</Tooltip.Content></Tooltip.Root>
						{/if}
					</div>
				{:else if column.id === 'actions'}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="flex items-center justify-end gap-1" onclick={(e) => e.stopPropagation()}>
						{#if !config.isOrphan}
							{#if config.schedule}
								<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => togglePause(config)} disabled={togglingConfig === config.id} title={config.enabled ? 'Pause schedule' : 'Resume schedule'}>
									{#if togglingConfig === config.id}<RefreshCw class="w-3 h-3 text-muted-foreground animate-spin" />{:else if config.enabled}<Pause class="w-3 h-3 text-muted-foreground" />{:else}<RotateCwFadingClock class="w-3 h-3 text-muted-foreground" />{/if}
								</button>
							{/if}
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => { editConfig = config; editModalOpen = true; }} title="Edit backup">
								<Pencil class="w-3 h-3 text-muted-foreground" />
							</button>
							<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100" onclick={() => runBackupNow(config)} disabled={runningBackup === config.id} title="Run backup now">
								{#if runningBackup === config.id}<RefreshCw class="w-3 h-3 text-muted-foreground animate-spin" />{:else}<Play class="w-3 h-3 text-muted-foreground" />{/if}
							</button>
							<ConfirmPopover
								open={confirmDeleteConfig === config.id}
								action="Delete"
								itemType="backup config"
								itemName={config.targetName}
								title="Existing snapshots are kept."
								position="left"
								onConfirm={() => deleteConfig(config)}
								onOpenChange={(open) => confirmDeleteConfig = open ? config.id : null}
							>
								{#snippet children({ open })}
									{#if deletingConfig === config.id}
										<Loader2 class="w-3 h-3 animate-spin" />
									{:else}
										<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
									{/if}
								{/snippet}
							</ConfirmPopover>
						{/if}
					</div>
				{/if}
			{/snippet}

			{#snippet expandedRow(config, rowState)}
				{@const key = config.key}
				{@const snapshots = snapshotsMap.get(key) || []}
				{@const isLoading = loadingSnapshots.has(key)}
				<div class="p-4 pl-12 shadow-inner bg-muted/50 isolate sticky left-0 max-w-[calc(100vw-18rem)]">
					{#if lastError?.configId === config.id}
						<div class="flex items-start gap-2 mb-3 p-2 rounded bg-destructive/10 border border-destructive/20 text-xs">
							<XCircle class="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
							<span class="text-destructive flex-1">{cleanErrorMessage(lastError.message)}</span>
							<button type="button" class="text-destructive/50 hover:text-destructive shrink-0" onclick={() => lastError = null}>
								<X class="w-3 h-3" />
							</button>
						</div>
					{/if}
					<div class="flex items-center gap-1.5 mb-2">
						<h4 class="text-xs font-medium text-muted-foreground">Snapshots</h4>
						<!-- Hide the count while refreshing — the number is stale until the reload
						     finishes; the table rows below stay visible in the meantime. Fades
						     out on refresh, back in once the fresh count lands. -->
						{#if !isLoading && snapshots.length > 0}<span class="rounded-full bg-primary/15 px-1.5 text-xs text-primary" transition:fade={{ duration: 200 }}>{snapshots.length}</span>{/if}
						<button type="button" class="p-0.5 rounded hover:bg-muted transition-colors" onclick={() => loadSnapshots(config)} disabled={isLoading}>
							<RefreshCw class="w-2.5 h-2.5 text-muted-foreground {isLoading ? 'animate-spin' : ''}" />
						</button>
					</div>
					{#if isLoading && snapshots.length === 0}
						<!-- First load only: a quiet inline spinner, no skeleton. On a refresh
						     where rows already exist we fall through and keep the real table
						     visible (the header refresh icon already spins to signal progress). -->
						<div class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
							<Loader2 class="w-3.5 h-3.5 animate-spin" />
							Loading snapshots…
						</div>
					{:else if snapshots.length === 0}
						<p class="text-xs text-muted-foreground py-4">No snapshots yet. Run a backup to create one.</p>
					{:else}
							<div class="max-h-80 overflow-auto rounded border bg-background ml-4 w-fit max-w-full">
							<table>
								<thead class="sticky top-0 bg-background z-10">
									<tr class="text-xs text-muted-foreground border-b">
										<th class="text-left py-1.5 w-24" style="padding-left:8px">ID</th>
										<th class="text-left py-1.5 w-40" style="padding-left:8px">Created</th>
										<th class="text-left py-1.5 w-64" style="padding-left:8px">Stats</th>
										<th class="text-left py-1.5 w-32" style="padding-left:8px">Repo</th>
										<th class="text-right px-3 py-1.5 w-28">Actions</th>
									</tr>
								</thead>
								<tbody>
									{#each snapshots.slice(0, snapshotLimits.get(key) || SNAPSHOT_PAGE_SIZE) as snapshot}
										{@const stats = snapshotStats.get(snapshot.id)}
										{@const isDiffPending = diffPending?.snapshot.id === snapshot.id}
										<tr class="border-b last:border-0 hover:bg-muted/30 text-xs {isDiffPending ? 'bg-primary/10' : ''}">
											<td class="py-1.5 font-mono text-muted-foreground" style="padding-left:8px">{snapshot.shortId}</td>
											<td class="py-1.5" style="padding-left:8px">{formatDateTime(snapshot.time)} <span class="text-muted-foreground opacity-60">({formatRelativeTime(snapshot.time)})</span></td>
											<td class="py-1.5 text-muted-foreground" style="padding-left:8px">
												{#if stats}
													{stats.filesNew} new, {stats.filesChanged} changed · {formatBytes(stats.dataAdded)}
												{:else}
													—
												{/if}
											</td>
											<td class="py-1.5 text-muted-foreground text-xs" style="padding-left:8px">
												{#if snapshot._destinationName}
													<span class="inline-flex items-center gap-1.5">
														<svelte:component this={getDestIcon(snapshot._destinationRepository || '')} class="w-3.5 h-3.5 shrink-0" />
														{snapshot._destinationName}
													</span>
												{/if}
											</td>
											<td class="px-3 py-1.5 text-right">
												<div class="flex items-center justify-end gap-0.5">
													{#if snapshots.length >= 2}
														<button type="button" class="p-1 rounded transition-colors {isDiffPending ? 'bg-primary/20 text-primary' : 'hover:bg-muted'}" onclick={() => toggleDiffSnapshot(snapshot, config.destinationId)} title={isDiffPending ? 'Cancel compare' : diffPending ? 'Compare with selected' : 'Compare'}>
															<ArrowLeftRight class="w-3 h-3 {isDiffPending ? 'text-primary' : 'text-muted-foreground'}" />
														</button>
													{/if}
													<button type="button" class="p-1 rounded hover:bg-muted transition-colors" onclick={() => openBrowser(config, snapshot)} title="Browse files">
														<FolderOpen class="w-3 h-3 text-muted-foreground" />
													</button>
													<button type="button" class="p-1 rounded hover:bg-muted transition-colors" onclick={() => openRestore(config, snapshot)} title="Restore">
														<RotateCcw class="w-3 h-3 text-muted-foreground" />
													</button>
													<ConfirmPopover
														open={confirmDeleteSnapshot === snapshot.id}
														action="Delete"
														itemType="snapshot"
														itemName={snapshot.shortId}
														title="Delete snapshot"
														position="left"
														onConfirm={() => deleteSnapshot(config, snapshot)}
														onOpenChange={(open) => confirmDeleteSnapshot = open ? snapshot.id : null}
													>
														{#snippet children({ open })}
															{#if deletingSnapshot === snapshot.id}
																<Loader2 class="w-3 h-3 animate-spin" />
															{:else}
																<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
															{/if}
														{/snippet}
													</ConfirmPopover>
												</div>
											</td>
										</tr>
									{/each}
									{#if snapshots.length > (snapshotLimits.get(key) || SNAPSHOT_PAGE_SIZE)}
										<tr>
											<td colspan="5" class="py-1.5 text-center">
												<button type="button" class="text-xs text-primary hover:underline" onclick={() => { snapshotLimits = new Map(snapshotLimits).set(key, (snapshotLimits.get(key) || SNAPSHOT_PAGE_SIZE) + SNAPSHOT_PAGE_SIZE); }}>
													Show more ({snapshots.length - (snapshotLimits.get(key) || SNAPSHOT_PAGE_SIZE)} remaining)
												</button>
											</td>
										</tr>
									{/if}
								</tbody>
							</table>
						</div>
					{/if}
				</div>
			{/snippet}
		</DataGrid>
	{/if}
	</div>
</div>

<SnapshotBrowser
	bind:open={showBrowser}
	destinationId={browserDestId}
	snapshotId={browserSnapshotId}
	targetName={browserTargetName}
	targetType={browserTargetType}
/>

<!-- Restore is fully self-contained: form → log → result in ONE modal (never
     delegates to BackupLogModal). onDone reloads snapshots — fetchData already
     re-fetches the expanded configs' snapshot lists, so a restored snapshot list
     refreshes in place. -->
<RestoreModal
	bind:open={showRestore}
	destinationId={restoreDestId}
	snapshotId={restoreSnapshotId}
	containerName={restoreContainerName}
	destinationName={restoreDestName}
	destinationRepository={restoreDestRepo}
	environmentId={restoreEnvId}
	onDone={fetchData}
/>

<!-- Backup Play on a config has no form modal, so its progress log needs its own
     window. Restore uses RestoreModal's inline log instead. -->
<BackupLogModal
	bind:open={logModalOpen}
	title={logModalTitle}
	status={logModalStatus}
	progress={logModalProgress}
	logs={logModalLogs}
	error={logModalError}
	onStop={canCancelBackup ? stopBackup : undefined}
/>

<SnapshotDiffModal
	bind:open={showDiff}
	destinationId={diffDestId}
	snapshotA={diffSnapA}
	snapshotB={diffSnapB}
/>

<CreateBackupModal
	bind:open={showCreateModal}
	onCreated={fetchData}
	onRun={runBackupNowById}
/>

<EditBackupConfigModal
	bind:open={editModalOpen}
	config={editConfig}
	onSaved={() => { editModalOpen = false; fetchData(); }}
/>
