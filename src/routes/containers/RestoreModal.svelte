<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { RotateCcw, AlertTriangle, Loader2, HardDrive, Folder, Clock, Play, CheckCircle2, XCircle, Server, PackagePlus, Ban, Rocket, Box, Layers, HelpCircle, Info, KeyRound, FileX } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { toast } from 'svelte-sonner';
	import { watchJob, readJobResponse } from '$lib/utils/sse-fetch';
	import { environments } from '$lib/stores/environment';
	import { formatDateTime } from '$lib/stores/settings';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import SnapshotHeader from '$lib/components/backup/SnapshotHeader.svelte';
	import LogConsole from '$lib/components/LogConsole.svelte';
	import { tagLogLine, classifyJobResult, getRepoTypeIcon } from '$lib/utils/backup';

	interface Props {
		open: boolean;
		destinationId: number;
		snapshotId: string;
		containerName: string;
		environmentId?: number;
		/** Source repository (name + repo URL) this snapshot is being restored FROM.
		 *  Shown in the header as "from <icon> <name>" so it's clear which destination
		 *  the restore reads. Optional: the header just omits it when not supplied. */
		destinationName?: string;
		destinationRepository?: string;
		/** Refresh callback fired once the restore succeeds — the caller reloads its
		 *  snapshot list. This modal is ALWAYS self-contained (form → log → result in
		 *  one dialog); it never delegates its progress UI to a parent. */
		onDone?: () => void;
	}
	let { open = $bindable(), destinationId, snapshotId, containerName, environmentId, destinationName, destinationRepository, onDone }: Props = $props();

	// The two restore modes, framed by DESTINATION intent (not safe-vs-destructive):
	//  - 'new-location' ("Restore to environment"): pick a target env and, per
	//    volume, a DESTINATION. A destination pointing at a named volume / host path
	//    the container mounts + a start action = a working CLONE; a plain extract
	//    path = today's safe inspect-to-a-folder. Cross-env.
	//  - 'in-place' ("Overwrite live"): overwrite the live volumes on the SOURCE env.
	type RestoreMode = 'new-location' | 'in-place';

	let loading = $state(false);
	let restoring = $state(false);
	let error = $state('');
	let restoreStatus = $state<'idle' | 'running' | 'success' | 'warning' | 'error'>('idle');
	let restoreLogs = $state<string[]>([]);
	// Non-fatal caveat shown on the 'warning' result (e.g. data restored but the
	// post-restore recreate/redeploy failed — the operator finishes manually).
	let restoreWarning = $state('');

	// After the restore, what to do with the target.
	type PostRestore = 'start' | 'recreate' | 'redeploy' | 'none';

	// One row per volume. `dest`/`destKind` are the editable clone destination on
	// the target env (pre-filled 1:1 from the snapshot's original location). `type`
	// is the ORIGINAL kind (for the badge). `conflict` is set when a named-volume
	// destination already exists on the target env (fail-closed — must be resolved).
	interface VolRow {
		name: string;
		selected: boolean;
		type: 'volume' | 'bind';
		dest: string;
		destKind: 'volume' | 'path';
		/** The snapshot's ORIGINAL destination + kind (the 1:1 pre-fill), kept so we
		 * can detect when the user redirects a volume to a new name/type — which the
		 * recreate/redeploy won't follow (it uses the stored config). */
		origDest: string;
		origDestKind: 'volume' | 'path';
		conflict: boolean;
		/** A host-path destination that isn't a valid absolute path (empty, no
		 * leading '/', or contains '..') — mirrors the server-side validation so the
		 * restore is blocked before submit with an inline hint. */
		pathInvalid: boolean;
	}

	let mode = $state<RestoreMode>('new-location');
	let volumes = $state<VolRow[]>([]);
	let hasMetadata = $state(false);
	let hasStackFiles = $state(false);
	let backupTime = $state<string | null>(null);
	let targetPath = $state('/restore');
	let confirmOverwrite = $state(false);
	let postRestore = $state<PostRestore>('recreate');
	// Set once the user picks a post-restore action by hand, so the auto "→ none on
	// remap" doesn't override a deliberate choice (they may know their config matches).
	let postRestoreUserPicked = $state(false);
	let targetEnvId = $state<number | undefined>(undefined);
	// The snapshot's SOURCE env for in-place. Seeded from the environmentId prop, but
	// the prop can be empty (a config with no env, or an orphan snapshot restored from
	// the list) — in that case we recover it from the snapshot metadata on preview, so
	// in-place still knows which env holds the live target (otherwise the button stays
	// disabled and the header shows "on " with no name).
	let sourceEnvId = $state<number | undefined>(undefined);
	// Names (never values) of the secrets carried IN this snapshot. The values are
	// stored encrypted under this instance's key; restoring writes them back into the
	// target env's DB so the stack comes up complete. Default ON — a restore is meant to
	// reproduce a working stack. Off = bring it up without secrets (re-enter by hand).
	let sourceSecretKeys = $state<string[]>([]);
	let restoreSecrets = $state(true);
	// New-location STACK restore option. skipStackFiles: restore only the volume DATA, not the
	// captured compose/.env (the operator already has the compose). When NOT set, the stack files
	// are restored AND materialised into Dockhand's managed stack dir so it can edit/redeploy.
	let skipStackFiles = $state(false);
	// Volume names that already exist on the chosen target env (for conflict marks).
	let existingTargetVolumes = $state<string[]>([]);
	// Target-NAME collision: a container/stack of the restore's name already exists
	// on the chosen target env. Mirrors the server's fail-closed check so the user
	// sees it before submitting. Only blocks when a bring-up action is selected.
	let nameExistsOnTarget = $state(false);

	const envList = $derived($environments ?? []);
	const effectiveEnvId = $derived(mode === 'in-place' ? sourceEnvId : targetEnvId);
	const targetIsStack = $derived(hasStackFiles);

	// After-restore action options. For a clone, 'start' is not offered (there's no
	// live container to start — the target is created); 'recreate'/'redeploy' build it.
	const postRestoreOptions = $derived([
		...(mode === 'in-place' ? [{ value: 'start', label: targetIsStack ? 'Start stack' : 'Start container', icon: Play }] : []),
		{ value: 'recreate', label: targetIsStack ? 'Recreate if missing' : 'Recreate container', icon: PackagePlus },
		...(targetIsStack ? [{ value: 'redeploy', label: 'Redeploy stack', icon: Rocket }] : []),
		{ value: 'none', label: 'Do nothing', icon: Ban }
	]);
	const targetEnv = $derived(envList.find((e) => e.id === effectiveEnvId));
	const targetEnvName = $derived(targetEnv?.name ?? '');
	// The snapshot's source env (for the "from <env>" phrasing in the summary).
	const sourceEnv = $derived(envList.find((e) => e.id === sourceEnvId));
	const sourceEnvName = $derived(sourceEnv?.name ?? '');
	// Offer the "restore secrets from this backup" toggle whenever this is a stack
	// snapshot that actually carries secrets — same UI for in-place and cross-env.
	const showSecretRestore = $derived(targetIsStack && sourceSecretKeys.length > 0);
	const postRestoreLabel = $derived(postRestoreOptions.find((o) => o.value === postRestore)?.label ?? '');
	// Step-rail styling: always neutral (primary). Only the What-will-happen box
	// turns red on the destructive (in-place) path — the rail/numbers stay calm.
	// z-10 + solid dialog bg so the connector line is capped AT the circle edge and
	// never shows through its (previously translucent) center.
	const stepRingClass = 'relative z-10 border-primary/40 bg-background text-primary';
	const stepLineClass = 'bg-primary/25';

	// --- Exact target-path preview + host-data probe -----------------------------------------
	// The EXACT on-disk targets the restore will write, resolved server-side by the SAME function
	// the real restore uses (never client-side path math), plus whether each already holds data on
	// the target host. Re-fetched (debounced) whenever the destination or target env changes.
	type ProbeKind = 'has-data' | 'empty' | 'missing' | 'helper-failed';
	interface TargetPreview {
		volumes: Array<{ key: string; type: 'bind' | 'volume'; target: string; origin: string; hasData: ProbeKind }>;
		stackFiles: { targetDir: string; willWrite: boolean; hasData: ProbeKind } | null;
		unresolved: Array<{ key: string; reason: string }>;
		helperOk: boolean;
		helperError?: string;
	}
	let targetPreview = $state<TargetPreview | null>(null);
	let targetPreviewLoading = $state(false);
	// Set when the preview request itself fails (non-ok / thrown) so we surface a visible
	// error instead of a silent empty section - a failed probe used to render as nothing.
	let targetPreviewError = $state('');
	// The user's acknowledgement that existing data at the resolved targets will be overwritten.
	let overwriteAck = $state(false);
	// Monotonic request id so a slow response for an old form state can't overwrite a newer one.
	let targetPreviewSeq = 0;
	let targetPreviewTimer: ReturnType<typeof setTimeout> | null = null;

	// A resolved target already holds data on the host (in-place is always destructive to it;
	// a clone path/volume may be pre-populated). Drives the overwrite acknowledgement gate.
	const targetsWithData = $derived(
		(targetPreview?.volumes ?? []).filter((v) => v.hasData === 'has-data').length +
		(targetPreview?.stackFiles?.hasData === 'has-data' ? 1 : 0)
	);
	const helperError = $derived(targetPreview && targetPreview.helperOk === false ? (targetPreview.helperError || 'the backup helper container could not run on the target environment') : '');
	// Probe result per volume key (has-data / empty / missing), for the per-row badges in the
	// "What will happen" recap. Null while the probe hasn't returned for that row yet -> the row
	// shows its own spinner.
	const probeByKey = $derived(new Map((targetPreview?.volumes ?? []).map((v) => [v.key, v.hasData])));

	const selectedRows = $derived(volumes.filter((v) => v.selected));
	// A selected volume redirected to a NEW name or type (vs the snapshot's original).
	// The recreate/redeploy uses the STORED config/compose, which still references the
	// original mounts — so it won't pick up the redirected data. We warn + default the
	// post-restore action to 'none' so the target isn't started with the wrong data.
	const remappedRows = $derived(selectedRows.filter(
		(v) => v.dest.trim() !== v.origDest || v.destKind !== v.origDestKind
	));
	const hasRemap = $derived(mode === 'new-location' && remappedRows.length > 0);
	// The clone will bring the target up (recreate a container / redeploy a stack).
	const willBringUp = $derived(postRestore === 'recreate' || postRestore === 'redeploy');
	// Target-name collision blocks only when we'd bring the target up — a name clash
	// is harmless for a pure extract (postRestore 'none').
	const nameConflict = $derived(mode === 'new-location' && willBringUp && nameExistsOnTarget);
	// A blocking issue: a volume collision, an invalid host path, or a target-name clash.
	const hasBlockingIssue = $derived(mode === 'new-location' && (nameConflict || selectedRows.some((v) => v.conflict || v.pathInvalid)));
	const canRun = $derived(
		// A target environment MUST be chosen.
		effectiveEnvId != null &&
		// Don't let a restore fire while the target-path probe is still running: it may come back
		// with "has data" (an overwrite the user must acknowledge first), so running now would
		// bypass that gate. Wait for the preview to resolve.
		!targetPreviewLoading &&
		!targetPreviewError &&
		// The probe helper must be able to run on the target - if it can't, neither the probe
		// nor the restore can, so block up front rather than fail mid-restore.
		!helperError &&
		(mode === 'in-place'
			// In-place: confirmOverwrite IS the overwrite acknowledgement (its copy says
			// "replaces the live volume data"). The new-location-only overwriteAck checkbox
			// is never rendered here, so DON'T gate on it — that deadlocked the button whenever
			// the live target already held data (targetsWithData > 0), i.e. every real in-place.
			? confirmOverwrite
			: (
				// New-location: when any resolved target already holds data, the user must
				// tick the separate overwrite acknowledgement.
				(targetsWithData === 0 || overwriteAck) &&
				// Every selected volume needs a non-empty destination; none may have a
				// blocking issue (collision / invalid host path).
				selectedRows.every((v) => v.dest.trim().length > 0) &&
				!hasBlockingIssue &&
				// Not a no-op: either something to restore, or a start action for a
				// config-only snapshot (recreate/redeploy from stored config).
				(selectedRows.length > 0 || postRestore !== 'none')
			))
	);

	$effect(() => {
		if (open && snapshotId) {
			mode = 'new-location';
			confirmOverwrite = false;
			postRestore = 'recreate';
			postRestoreUserPicked = false;
			// Clone: NO env preselected — the user must consciously pick where it goes
			// (the header shows no "to <env>" until they do). sourceEnvId is still seeded
			// for in-place (which overwrites the live target on its own source env).
			targetEnvId = undefined;
			sourceEnvId = environmentId;
			targetPath = `/restore/${containerName}`;
			existingTargetVolumes = [];
			// Reset stack-ness so a stale value from the previous open can't flash the
			// wrong type icon while the new snapshot is still being read.
			hasStackFiles = false;
			skipStackFiles = false;
			restoreStatus = 'idle';
			restoreLogs = [];
			restoreWarning = '';
			error = '';
			targetPreview = null;
			overwriteAck = false;
			if (envList.length === 0) environments.refresh();
			void loadPreview();
		}
	});

	// Re-check volume-name AND target-name conflicts whenever the target env changes
	// (fail-closed: a named-volume destination OR the container/stack name already on
	// the target blocks the clone).
	$effect(() => {
		const envId = effectiveEnvId;
		// Track targetIsStack so the name check re-runs once the preview resolves the type.
		const isStack = targetIsStack;
		if (!open || mode !== 'new-location' || envId == null) { existingTargetVolumes = []; nameExistsOnTarget = false; return; }
		void refreshTargetVolumes(envId);
		void refreshTargetName(envId, isStack);
	});

	async function refreshTargetVolumes(envId: number) {
		try {
			const res = await fetch(`/api/volumes?env=${envId}`);
			if (!res.ok) { existingTargetVolumes = []; return; }
			const list = await res.json();
			existingTargetVolumes = (Array.isArray(list) ? list : []).map((v: any) => v.Name ?? v.name).filter(Boolean);
		} catch {
			existingTargetVolumes = [];
		}
	}

	// Does a container/stack named `containerName` already exist on the target env?
	async function refreshTargetName(envId: number, isStack: boolean) {
		try {
			const path = isStack ? `/api/stacks?env=${envId}` : `/api/containers?env=${envId}`;
			const res = await fetch(path);
			if (!res.ok) { nameExistsOnTarget = false; return; }
			const list = await res.json();
			const names = (Array.isArray(list) ? list : []).map((x: any) => x.name ?? (Array.isArray(x.Names) ? x.Names[0]?.replace(/^\//, '') : undefined)).filter(Boolean);
			nameExistsOnTarget = names.includes(containerName);
		} catch {
			nameExistsOnTarget = false;
		}
	}

	// Switching a row between "Volume" (a named-volume) and "Host path" (a bind) —
	// convert `dest` so a stale value from the other kind can't be submitted. A host
	// path like `/docker/data/postgres18` is NOT a valid named-volume name (the server
	// rejects it: validate.ts requires `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`), and vice-versa.
	// path→volume: derive a name from the path's last segment; volume→path: prefix `/`.
	// Empty when we can't convert cleanly, so the placeholder guides the user.
	function onDestKindChange(vol: VolRow, next: 'volume' | 'path') {
		if (vol.destKind === next) return;
		const cur = vol.dest.trim();
		if (next === 'volume') {
			// From a host path → suggest the last path segment as a volume name, sanitised.
			const base = cur.replace(/\/+$/, '').split('/').pop() ?? '';
			const nameLike = base.replace(/[^a-zA-Z0-9_.-]/g, '');
			vol.dest = /^[a-zA-Z0-9]/.test(nameLike) ? nameLike : '';
		} else {
			// From a volume name → an absolute path is required; only keep an already-
			// absolute value, otherwise clear so the user types one.
			vol.dest = cur.startsWith('/') ? cur : '';
		}
		vol.destKind = next;
	}

	// Mark each row's conflict flag: a named-volume destination that already exists
	// on the target env. Bind (path) destinations are never a "conflict" (the user
	// owns the host path). Recomputed whenever destinations or target volumes change.
	$effect(() => {
		const existing = existingTargetVolumes;
		for (const v of volumes) {
			const dest = v.dest.trim();
			v.conflict = v.destKind === 'volume' && dest.length > 0 && existing.includes(dest);
			// Match validate.ts exactly so the UI blocks a bad target BEFORE submit
			// (previously only host paths were checked, so a volume kind with a path
			// value like `/docker/...` slipped through to a generic 400).
			v.pathInvalid = v.destKind === 'path'
				? (dest.length === 0 || !dest.startsWith('/') || dest.includes('..'))
				: !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(dest); // volume: must be a valid volume name
		}
	});

	// Keep postRestore valid for the current mode (the option set differs: 'start'
	// exists only in-place). On a mode switch, snap to the first allowed option.
	$effect(() => {
		if (!postRestoreOptions.some((o) => o.value === postRestore)) {
			postRestore = postRestoreOptions[0]?.value as PostRestore;
		}
	});

	// When the user redirects a volume to a new name/type, default the post-restore
	// action to 'none' — bringing the target up would start it on the ORIGINAL mount,
	// not the restored data. The user can still override (they may have already fixed
	// their config); postRestoreUserPicked guards against fighting that choice.
	$effect(() => {
		if (hasRemap && !postRestoreUserPicked && postRestore !== 'none') postRestore = 'none';
	});

	async function loadPreview() {
		loading = true;
		error = '';
		try {
			// Job-polling (server returns {jobId}; readJobResponse polls to the result) so a slow
			// restic verify/read behind a reverse proxy can't be aborted at ~15s.
			const res = await fetch('/api/backup/restore/preview', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
				body: JSON.stringify({ destinationId, snapshotId, environmentId })
			});
			const data = await readJobResponse(res);
			if (data?.error) {
				error = data.error || 'Failed to read the snapshot';
				return;
			}
			const types: Record<string, 'volume' | 'bind'> = data.volumeTypes || {};
			const sources: Record<string, string> = data.volumeSources || {};
			// Pre-fill each destination 1:1 from the snapshot's original location: a
			// named volume → its name (destKind 'volume'); a bind → its absolute host
			// path (destKind 'path'). The user edits these to redirect the clone.
			volumes = (data.volumes || []).map((name: string) => {
				const type = types[name] ?? 'volume';
				// destKind is 'volume' | 'path' — a bind source defaults to a host PATH,
				// a named volume to a volume. (type is 'volume' | 'bind', not a destKind.)
				const destKind: 'volume' | 'path' = type === 'bind' ? 'path' : 'volume';
				const dest = sources[name] ?? name;
				return { name, selected: true, type, dest, destKind, origDest: dest, origDestKind: destKind, conflict: false, pathInvalid: false };
			});
			hasMetadata = !!data.hasMetadata;
			hasStackFiles = !!data.hasStackFiles;
			backupTime = data.backupTime ?? null;
			postRestore = data.hasStackFiles ? 'redeploy' : 'recreate';
			// Recover the source env from the snapshot when the caller didn't supply one
			// (empty prop) — needed for in-place (effectiveEnvId) and to default the
			// clone target env. Only if that env still exists on this instance.
			if (typeof data.sourceEnvironmentId === 'number' && envList.some((e) => e.id === data.sourceEnvironmentId)) {
				// Only recover the SOURCE env (for in-place). The clone target env stays
				// unselected on purpose — the user picks it.
				if (sourceEnvId == null) sourceEnvId = data.sourceEnvironmentId;
			}
			sourceSecretKeys = Array.isArray(data.sourceSecretKeys) ? data.sourceSecretKeys : [];
		} catch {
			error = 'Failed to read the snapshot';
		} finally {
			loading = false;
		}
	}

	async function loadTargetPreview() {
		const envId = effectiveEnvId;
		if (!open || !snapshotId || envId == null) { targetPreview = null; return; }
		const seq = ++targetPreviewSeq;
		targetPreviewLoading = true;
		try {
			const volumeDestinations = mode === 'new-location'
				? selectedRows.map((v) => ({ volume: v.name, kind: v.destKind, target: v.dest.trim() }))
				: undefined;
			// Job-polling: the target probe runs a helper container per volume on the target host
			// (slowest read path) - a sync request would abort at the proxy's ~15s.
			const res = await fetch('/api/backup/restore/preview', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
				body: JSON.stringify({
					destinationId, snapshotId, mode, environmentId: envId,
					targetType: targetIsStack ? 'stack' : 'container',
					targetName: containerName, targetPath,
					volumeDestinations, skipStackFiles,
					volumes: selectedRows.map((v) => v.name),
				})
			});
			const data = await readJobResponse(res);
			if (seq !== targetPreviewSeq) return; // a newer request superseded this one (checked AFTER the poll)
			if (data?.error) {
				targetPreview = null;
				targetPreviewError = data.error || 'Could not check the target paths on the environment.';
				return;
			}
			targetPreview = data.targets ?? null;
		} catch {
			if (seq === targetPreviewSeq) { targetPreview = null; targetPreviewError = 'Could not reach the server to check the target paths.'; }
		} finally {
			if (seq === targetPreviewSeq) targetPreviewLoading = false;
		}
	}

	// Debounced re-probe on any change that moves where the restore lands. Reading these makes the
	// effect track them; the 350ms debounce collapses a burst of keystrokes into one request.
	$effect(() => {
		// touch the reactive inputs so the effect re-runs when they change
		void [mode, effectiveEnvId, skipStackFiles, targetIsStack,
			selectedRows.map((v) => `${v.name}:${v.selected}:${v.destKind}:${v.dest}`).join('|')];
		if (!open || !snapshotId) return;
		// Clear the stale preview IMMEDIATELY (bump seq so any in-flight probe for the old target is
		// discarded on return) so a warning/path for the previous env can't linger while the new
		// probe runs - especially when the old env's helper was timing out (a slow pull).
		targetPreviewSeq++;
		targetPreview = null;
		targetPreviewError = '';
		if (targetPreviewTimer) clearTimeout(targetPreviewTimer);
		// No target env picked yet (new-location before you choose one) -> nothing to probe. Clear
		// the loading state and don't schedule a probe that has nowhere to mount.
		if (effectiveEnvId == null) { targetPreviewLoading = false; return; }
		targetPreviewLoading = true;
		targetPreviewTimer = setTimeout(() => { void loadTargetPreview(); }, 350);
	});

	async function executeRestore() {
		if (!canRun) return;
		restoring = true;
		error = '';
		restoreStatus = 'running';
		restoreLogs = [];

		try {
			// For a clone (new-location), every selected volume carries a destination.
			const volumeDestinations = mode === 'new-location'
				? selectedRows.map((v) => ({ volume: v.name, kind: v.destKind, target: v.dest.trim() }))
				: undefined;
			const res = await fetch('/api/backup/restore', {
				method: 'POST',
				// Ask for the job-polling/streaming path so the modal's log fills as the
				// restore runs (Accept: application/json would take the synchronous path
				// with no progress lines).
				headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
				body: JSON.stringify({
					destinationId,
					snapshotId,
					mode,
					targetType: hasStackFiles ? 'stack' : 'container',
					volumes: selectedRows.map((v) => v.name),
					environmentId: effectiveEnvId,
					targetName: containerName,
					// Restore the stack's secrets carried in the snapshot. Only send false
					// when the toggle is shown and the user turned it off; otherwise the
					// server default (restore them) applies.
					restoreSecrets: showSecretRestore ? restoreSecrets : undefined,
					confirmOverwrite: mode === 'in-place' ? confirmOverwrite : undefined,
					// postRestore is sent for BOTH modes now (clone brings the target up).
					postRestore,
					targetPath: mode === 'new-location' ? targetPath.trim() : undefined,
					// New-location STACK restore options (server ignores them otherwise).
					skipStackFiles: mode === 'new-location' && hasStackFiles ? skipStackFiles : undefined,
						volumeDestinations
				})
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				// Surface the specific validation reason(s), not just the generic
				// "Invalid restore request" — e.g. "volume destination for X is not a
				// valid volume name" tells the user exactly what to fix.
				const issues = Array.isArray(body.issues)
					? body.issues.map((i: { field?: string; message?: string }) => i.message).filter(Boolean)
					: [];
				error = issues.length
					? `${body.error || 'Restore failed'}: ${issues.join('; ')}`
					: (body.error || 'Restore failed');
				restoreStatus = 'error';
				restoring = false;
				return;
			}
			const data = await res.json();
			if (data.jobId) {
				const result = (await watchJob(data.jobId, (line: any) => {
					if (line.event === 'progress' && line.data?.message) {
						restoreLogs = [...restoreLogs, tagLogLine(line.data.message)];
					}
				})) as any;
				// Same discriminated-union handling as the backup path: a restore can come
				// back 'skipped' (a concurrent op holds the lock) or 'warning' (data was
				// restored but the post-restore recreate/redeploy failed) — neither is a
				// plain success, and reporting them as one hides a half-finished restore.
				const { outcome, message } = classifyJobResult(result);
				if (outcome === 'error' || outcome === 'skipped') {
					restoreStatus = 'error';
					error = message || 'Restore failed';
					restoreLogs = [...restoreLogs, tagLogLine(`[dockhand] Restore failed: ${error}`)];
				} else if (outcome === 'warning') {
					restoreStatus = 'warning';
					restoreWarning = message || 'Restore completed with warnings';
					restoreLogs = [...restoreLogs, tagLogLine(`[dockhand] Restore completed with warnings: ${restoreWarning}`)];
					onDone?.(); // the data DID land — refresh the snapshot list
				} else {
					restoreStatus = 'success';
					restoreLogs = [...restoreLogs, tagLogLine('[dockhand] Restore completed.')];
					onDone?.();
				}
			}
		} catch (e: any) {
			restoreStatus = 'error';
			error = e?.message || 'Restore failed';
			restoreLogs = [...restoreLogs, tagLogLine(`[dockhand] Restore failed: ${error}`)];
		} finally {
			restoring = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<!-- Anchored near the top (not vertically centered) so toggling a volume or
	     switching modes grows the dialog DOWNWARD instead of jumping the whole box.
	     max-h + scroll keeps it usable on short screens. -->
	<!-- Fixed height + internal scroll: the outer box never resizes, so switching
	     modes or checking/unchecking volumes changes only the scroll area, never the
	     dialog's top/bottom edges — no jumping. -->
	<!-- Tall fixed height only for the multi-step FORM; the progress/result views
	     (log, success, warning, error) size to their content up to a cap so the log
	     dialog isn't a giant near-empty box. The tall form is top-anchored (top-[4vh])
	     so growing it downward doesn't jump; the short result views drop that override
	     and use the dialog's DEFAULT centered position — otherwise a one-line result
	     box sits glued to the top of the screen. -->
	<Dialog.Content class="max-w-5xl flex flex-col overflow-hidden {restoreStatus === 'idle' ? 'top-[4vh] translate-y-0 h-[88vh]' : 'top-[6vh] translate-y-0 h-[85vh]'}">
		<Dialog.Header class="shrink-0">
			<Dialog.Title>
				<SnapshotHeader
					icon={RotateCcw}
					verb="Restore"
					name={containerName}
					nameType={targetIsStack ? 'stack' : 'container'}
					{destinationName}
					{destinationRepository}
					{sourceEnv}
					{sourceEnvName}
					{snapshotId}
					snapshotTime={backupTime}
				>
					{#snippet trailing()}
						{#if targetEnv}
							<span class="text-muted-foreground">{mode === 'in-place' ? 'on' : 'to'}</span>
							<span class="flex items-center gap-1 font-medium text-foreground"><EnvironmentIcon icon={targetEnv.icon || 'globe'} envId={targetEnv.id} class="h-4 w-4" />{targetEnvName}</span>
						{/if}
					{/snippet}
				</SnapshotHeader>
			</Dialog.Title>
			<Dialog.Description class="sr-only">Restore snapshot {snapshotId.slice(0, 8)} for {containerName}.</Dialog.Description>
		</Dialog.Header>

		<!-- The single scroll region. flex-1 fills the fixed-height dialog between the
		     pinned header and footer; content growth scrolls here, not the outer box. -->
		<div class="flex flex-1 flex-col overflow-y-auto -mx-6 px-6">
		{#if loading}
			<div class="flex flex-1 items-center justify-center text-muted-foreground">
				<Loader2 class="h-5 w-5 animate-spin" /> <span class="ml-2">Reading snapshot…</span>
			</div>
		{:else if restoreStatus !== 'idle'}
			<!-- Running AND finished states keep the LIVE LOG visible (no separate result
			     screen that hides what happened) — the outcome is appended as a final log
			     line and summarised in the status strip below, matching the backup dialog. -->
			<!-- flex-1 + fixed dialog height: the log fills the space and SCROLLS
			     internally, so the dialog never grows/jumps as lines stream in. -->
			<div class="flex min-h-0 flex-1 flex-col py-2">
				<LogConsole lines={restoreLogs} class="flex-1 min-h-0" />
				<div class="mt-2 flex shrink-0 items-center gap-1.5 text-sm">
					{#if restoreStatus === 'running'}
						<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" /><span class="text-muted-foreground">Restoring…</span>
					{:else if restoreStatus === 'success'}
						<CheckCircle2 class="h-4 w-4 text-green-500" />
						<span class="text-green-500">Restore completed</span>
						<span class="text-muted-foreground">— {mode === 'new-location'
							? `restored to ${targetEnvName}${postRestore !== 'none' ? (targetIsStack ? ', stack redeployed' : ', container recreated') : ''}`
							: `live volume replaced — restart ${containerName}${hasStackFiles ? ' / redeploy the stack' : ''} to use it`}.</span>
					{:else if restoreStatus === 'warning'}
						<AlertTriangle class="h-4 w-4 text-amber-500" /><span class="text-amber-600 dark:text-amber-400">Restore completed with warnings — {restoreWarning}</span>
					{:else}
						<XCircle class="h-4 w-4 text-destructive" /><span class="text-destructive">{error || 'Restore failed'}</span>
					{/if}
				</div>
			</div>
		{:else}
			<div class="flex-1 py-2">
				{#if error}
					<p class="mb-3 rounded bg-destructive/10 p-2 text-sm text-destructive">{error}</p>
				{/if}

				<!-- STEP 1 — Where does it go? (mode + target env) -->
				<div class="grid grid-cols-[26px_1fr] gap-x-3">
					<div class="flex flex-col items-center">
						<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold {stepRingClass}">1</span>
						<span class="-mb-3 w-0.5 flex-1 rounded {stepLineClass}"></span>
					</div>
					<div class="space-y-2 pb-3">
						<div class="text-sm font-semibold">Where does it go? <span class="font-normal text-xs text-muted-foreground">— pick where, and how</span></div>
						<div class="grid grid-cols-2 gap-2">
							<button
								type="button"
								class="rounded border p-3 text-left text-sm {mode === 'new-location' ? 'border-primary bg-primary/5' : ''}"
								onclick={() => (mode = 'new-location')}
							>
								<div class="flex items-center gap-1.5 font-medium"><Server class="h-3.5 w-3.5" /> To an environment</div>
								<div class="mt-1 text-xs text-muted-foreground">Clone it onto a chosen environment.</div>
							</button>
							<button
								type="button"
								class="rounded border p-3 text-left text-sm {mode === 'in-place' ? 'border-primary bg-primary/5' : ''}"
								onclick={() => (mode = 'in-place')}
							>
								<div class="flex items-center gap-1.5 font-medium"><AlertTriangle class="h-3.5 w-3.5 text-destructive" /> Overwrite live</div>
								<div class="mt-1 text-xs text-muted-foreground">Replace the live data in place. Destructive.</div>
							</button>
						</div>
						{#if mode === 'new-location'}
							<div class="space-y-1.5">
								<Label class="flex items-center gap-1.5"><Server class="h-3.5 w-3.5" /> Target environment</Label>
								<Select.Root type="single" value={effectiveEnvId != null ? String(effectiveEnvId) : ''} onValueChange={(v) => (targetEnvId = v ? parseInt(v) : undefined)}>
									<Select.Trigger class="h-9 w-full">
										{#if targetEnv}
											<span class="flex items-center gap-2"><EnvironmentIcon icon={targetEnv.icon || 'globe'} envId={targetEnv.id} class="h-4 w-4 text-muted-foreground" />{targetEnv.name}</span>
										{:else}
											<span class="text-muted-foreground">Select an environment…</span>
										{/if}
									</Select.Trigger>
									<Select.Content>
										{#each envList as env}
											<Select.Item value={String(env.id)}>
												<span class="flex items-center gap-2"><EnvironmentIcon icon={env.icon || 'globe'} envId={env.id} class="h-4 w-4 text-muted-foreground" />{env.name}</span>
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
						{/if}
					</div>
				</div>

				<!-- STEP 2 — What gets restored? (volumes + destinations) -->
				<div class="grid grid-cols-[26px_1fr] gap-x-3">
					<div class="flex flex-col items-center">
						<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold {stepRingClass}">2</span>
						<span class="-mb-3 w-0.5 flex-1 rounded {stepLineClass}"></span>
					</div>
					<div class="space-y-2 pb-3">
						<div class="flex items-center gap-1.5 text-sm font-semibold">
							{mode === 'in-place' ? 'What gets overwritten?' : 'What gets restored?'}
							<span class="font-normal text-xs text-muted-foreground">— {selectedRows.length} of {volumes.length} {volumes.length === 1 ? 'volume' : 'volumes'}</span>
							{#if mode === 'new-location'}
								<Tooltip.Root>
									<Tooltip.Trigger class="ml-0.5"><HelpCircle class="h-3.5 w-3.5 text-muted-foreground opacity-70" /></Tooltip.Trigger>
									<Tooltip.Content class="w-[22rem] max-w-[90vw]">
										<p class="text-xs leading-relaxed">Each destination is resolved by <b>{targetEnvName || 'the target'}</b>'s Docker daemon: a <b>host path</b> must exist on that host (not on Dockhand's), while a <b>named volume</b> is created there. Prefer named volumes for portability. The post-restore step brings the {targetIsStack ? 'stack' : 'container'} up; if it fails, the data is still restored and you finish manually.</p>
									</Tooltip.Content>
								</Tooltip.Root>
							{/if}
						</div>
					{#if volumes.length === 0}
						<p class="text-sm text-muted-foreground">This snapshot has no volumes — restore recreates the {targetIsStack ? 'stack' : 'container'} from its saved config.</p>
						{#if showSecretRestore || (mode === 'new-location' && targetIsStack && hasStackFiles)}
							<div class="rounded border p-2">{@render secretRestoreBlock()}{@render stackRestoreOptions()}</div>
						{/if}
					{:else if mode === 'new-location'}
						<!-- Clone mode: each selected volume maps to an editable DESTINATION on
						     the target env. Default is the original location (1:1 clone). -->
						<div class="space-y-2 rounded border p-2">
							{#each volumes as vol}
								<div class="space-y-1">
									<label class="flex cursor-pointer items-center gap-2 text-sm">
										<Checkbox bind:checked={vol.selected} />
										{#if vol.type === 'bind'}
											<Folder class="h-3.5 w-3.5 shrink-0 text-amber-500" />
											<span class="w-11 shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">bind</span>
										{:else}
											<HardDrive class="h-3.5 w-3.5 shrink-0 text-sky-500" />
											<span class="w-11 shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">vol</span>
										{/if}
										<span class="truncate font-mono">{vol.name}</span>
									</label>
									{#if vol.selected}
										<div class="flex items-center gap-1.5 pl-6">
											<span class="text-xs text-muted-foreground">→</span>
											<Select.Root type="single" value={vol.destKind} onValueChange={(v) => onDestKindChange(vol, v as 'volume' | 'path')}>
												<Select.Trigger class="h-8 w-32 shrink-0 text-xs">
													{#if vol.destKind === 'path'}
														<span class="flex items-center gap-1.5"><Folder class="h-3.5 w-3.5 text-amber-500" /> Host path</span>
													{:else}
														<span class="flex items-center gap-1.5"><HardDrive class="h-3.5 w-3.5 text-sky-500" /> Volume</span>
													{/if}
												</Select.Trigger>
												<Select.Content>
													<Select.Item value="volume"><span class="flex items-center gap-1.5"><HardDrive class="h-3.5 w-3.5 text-sky-500" /> Volume</span></Select.Item>
													<Select.Item value="path"><span class="flex items-center gap-1.5"><Folder class="h-3.5 w-3.5 text-amber-500" /> Host path</span></Select.Item>
												</Select.Content>
											</Select.Root>
											<Input bind:value={vol.dest} class="h-8 flex-1 font-mono text-xs {(vol.conflict || vol.pathInvalid) ? 'border-destructive' : ''}" placeholder={vol.destKind === 'path' ? '/absolute/path' : 'volume-name'} />
										</div>
										{#if vol.conflict}
											<p class="pl-6 text-xs text-destructive">Volume <span class="font-mono">{vol.dest}</span> already exists on {targetEnvName}. Remove it or choose another destination.</p>
										{:else if vol.pathInvalid}
											<p class="pl-6 text-xs text-destructive">A host path must be absolute — start it with <span class="font-mono">/</span> (e.g. <span class="font-mono">/srv/{vol.name}</span>).</p>
										{/if}
									{/if}
								</div>
							{/each}
							{@render secretRestoreBlock()}
							{@render stackRestoreOptions()}
						</div>
					{:else}
						<div class="space-y-1.5 rounded border p-2">
							{#each volumes as vol}
								<label class="flex cursor-pointer items-start gap-2 text-sm">
									<Checkbox bind:checked={vol.selected} class="mt-0.5" />
									{#if vol.type === 'bind'}
										<Folder class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
										<span class="mt-0.5 w-11 shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">bind</span>
									{:else}
										<HardDrive class="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-500" />
										<span class="mt-0.5 w-11 shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">vol</span>
									{/if}
									<span class="min-w-0">
										<span class="block truncate font-mono">{vol.name}</span>
										{#if vol.type === 'bind' && vol.origDest && vol.origDest !== vol.name}
											<!-- The real host path that gets overwritten in place. -->
											<span class="block break-all font-mono text-xs text-muted-foreground">{vol.origDest}</span>
										{/if}
									</span>
								</label>
							{/each}
							{@render secretRestoreBlock()}
							{@render stackRestoreOptions()}
						</div>
					{/if}

					{@render hostTargetsBlock()}
					</div>
				</div>

				<!-- STEP 3 — Then what? (after-restore action) -->
				<div class="grid grid-cols-[26px_1fr] gap-x-3">
					<div class="flex flex-col items-center">
						<span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold {stepRingClass}">3</span>
					</div>
					<div class="space-y-2 pb-1">
						<div class="text-sm font-semibold">Then what? <span class="font-normal text-xs text-muted-foreground">— {mode === 'in-place' ? 'bring it back up' : 'bring it up on the target'}</span></div>
				{#if mode === 'new-location'}
					<!-- After restore: bring the target up on the chosen env. -->
					<div class="space-y-1.5">
						<Label class="sr-only">After restore</Label>
						<Select.Root type="single" value={postRestore} onValueChange={(v) => { postRestore = v as PostRestore; postRestoreUserPicked = true; }}>
							<Select.Trigger class="h-9">
								{#each postRestoreOptions as opt}
									{#if opt.value === postRestore}
										{@const OptIcon = opt.icon}
										<span class="flex items-center gap-2"><OptIcon class="h-3.5 w-3.5 text-muted-foreground" />{opt.label}</span>
									{/if}
								{/each}
							</Select.Trigger>
							<Select.Content>
								{#each postRestoreOptions as opt}
									{@const OptIcon = opt.icon}
									<Select.Item value={opt.value}>
										<span class="flex items-center gap-2"><OptIcon class="h-3.5 w-3.5 text-muted-foreground" />{opt.label}</span>
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						{#if nameConflict}
							<p class="text-xs text-destructive">A {targetIsStack ? 'stack' : 'container'} named <span class="font-mono">{containerName}</span> already exists on {targetEnvName}. Remove it or choose "Do nothing" — the restore won't overwrite it.</p>
						{/if}
					</div>
				{:else}
						<div class="space-y-1.5">
							<Label>After restore</Label>
							<Select.Root type="single" value={postRestore} onValueChange={(v) => { postRestore = v as PostRestore; postRestoreUserPicked = true; }}>
							<Select.Trigger class="h-9">
								{#each postRestoreOptions as opt}
									{#if opt.value === postRestore}
										{@const OptIcon = opt.icon}
										<span class="flex items-center gap-2"><OptIcon class="h-3.5 w-3.5 text-muted-foreground" />{opt.label}</span>
									{/if}
								{/each}
							</Select.Trigger>
							<Select.Content>
								{#each postRestoreOptions as opt}
									{@const OptIcon = opt.icon}
									<Select.Item value={opt.value}>
										<span class="flex items-center gap-2"><OptIcon class="h-3.5 w-3.5 text-muted-foreground" />{opt.label}</span>
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				{/if}
					</div>
				</div>

				<!-- What will happen: a live prose recap driven by the form. Env names use
				     the foreground colour (amber is reserved for warnings/destructive here),
				     each prefixed by the env's icon (same as the modal header). -->
				<!-- The EXACT host targets the restore writes to, resolved server-side by the same
				     function the restore uses, plus whether each already holds data. Gives the user
				     certainty about what lands where before committing. -->
				{#snippet hostDataBadge(kind: ProbeKind)}
					{#if kind === 'has-data'}
						<span class="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400"><AlertTriangle class="h-3 w-3" />has data</span>
					{:else if kind === 'empty'}
						<span class="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">empty</span>
					{:else if kind === 'missing'}
						<span class="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">new</span>
					{/if}
				{/snippet}
				<!-- VOL / BIND kind pill + icon, used on BOTH sides of "<source> -> <target>" so a
				     volume-to-volume (or path-to-path) restore reads consistently, not "VOL -> named volume". -->
				{#snippet kindBadge(kind: 'volume' | 'bind')}
					{#if kind === 'bind'}
						<Folder class="h-3 w-3 shrink-0 text-amber-500" />
						<span class="w-9 shrink-0 rounded-full bg-amber-500/15 px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">bind</span>
					{:else}
						<HardDrive class="h-3 w-3 shrink-0 text-sky-500" />
						<span class="w-9 shrink-0 rounded-full bg-sky-500/15 px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">vol</span>
					{/if}
				{/snippet}
				<!-- Only the FAILURE states live here now (they block the restore and must be seen even
				     when the "What will happen" recap can't render). The per-target paths + has-data
				     badges + overwrite ack moved INTO the recap so there's one place, not two. -->
				{#snippet hostTargetsBlock()}
					{#if helperError}
						<div class="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2.5 text-xs">
							<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
							<div class="min-w-0">
								<div class="font-medium text-destructive">The backup helper can't run on {targetEnvName || 'this environment'}</div>
								<div class="mt-0.5 break-all text-muted-foreground">{helperError}</div>
								<div class="mt-1 text-muted-foreground">A restore can't run until this is fixed - the same helper writes the restored data.</div>
							</div>
						</div>
					{:else if targetPreviewError && !targetPreviewLoading}
						<div class="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2.5 text-xs">
							<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
							<div class="min-w-0">
								<div class="font-medium text-destructive">Couldn't check the target paths</div>
								<div class="mt-0.5 break-all text-muted-foreground">{targetPreviewError}</div>
							</div>
						</div>
					{:else if targetPreview && targetPreview.unresolved.length > 0}
						<div class="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-2.5 text-xs">
							{#each targetPreview.unresolved as u}
								<div class="flex items-start gap-2 text-destructive">
									<Ban class="mt-0.5 h-3.5 w-3.5 shrink-0" />
									<span class="min-w-0"><span class="font-mono">{u.key}</span> - {u.reason}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/snippet}
				{#snippet envChip(env: { id: number; icon?: string | null } | undefined, name: string)}
					<span class="inline-flex -translate-y-[0.12em] items-center gap-1 align-middle font-medium text-foreground">{#if env}<EnvironmentIcon icon={env.icon || 'globe'} envId={env.id} class="h-3 w-3" />{/if}{name || '…'}</span>
				{/snippet}
				<!-- Secrets restored from the snapshot — rendered INSIDE the "what gets
				     restored" volume box so it reads as one coherent list. Ciphertext is
				     encrypted under this instance's key; restoring writes it to the target. -->
				{#snippet secretRestoreBlock()}
					{#if showSecretRestore}
						<div class="space-y-2 border-t pt-2 {volumes.length > 0 ? 'mt-1.5' : ''}">
							<label class="flex cursor-pointer items-start gap-2 text-sm">
								<Checkbox bind:checked={restoreSecrets} class="mt-0.5" />
								<KeyRound class="h-4 w-4 shrink-0 translate-y-0.5 text-amber-500" />
								<span>
									Restore {sourceSecretKeys.length} secret{sourceSecretKeys.length === 1 ? '' : 's'} from this backup.
									<span class="block text-xs text-muted-foreground">
										Turn off to bring the stack up without secrets and set them by hand.
									</span>
								</span>
							</label>
							<div class="flex flex-wrap gap-1 pl-6">
								{#each sourceSecretKeys as key}
									<code class="rounded bg-muted px-1.5 py-0.5 text-xs">{key}</code>
								{/each}
							</div>
							{#if restoreSecrets}
								<div class="flex items-start gap-1.5 pl-6 text-xs text-amber-600 dark:text-amber-500">
									<AlertTriangle class="h-3.5 w-3.5 shrink-0 translate-y-0.5" />
									<span>
										Secrets are encrypted with this Dockhand instance's key. Restoring on a
										different instance requires the same encryption key
										(<code class="rounded bg-muted px-1 py-0.5">.encryption_key</code> /
										<code class="rounded bg-muted px-1 py-0.5">ENCRYPTION_KEY</code>), or they
										stay unreadable.
									</span>
								</div>
							{/if}
						</div>
					{/if}
				{/snippet}
				<!-- New-location STACK restore options: skip the captured compose/.env (data
				     only), and/or adopt the restored stack into Dockhand afterwards. Stack +
				     new-location only. -->
				{#snippet stackRestoreOptions()}
					{#if mode === 'new-location' && targetIsStack && hasStackFiles}
						<!-- Top border/padding only when something (the secret block) sits above it;
						     otherwise this is the first content in the box and needs no divider. -->
						<div class="space-y-2 {showSecretRestore ? 'border-t pt-2 mt-1.5' : ''}">
							<label class="flex cursor-pointer items-start gap-2 text-sm">
								<Checkbox bind:checked={skipStackFiles} class="mt-0.5" />
								<FileX class="h-4 w-4 shrink-0 translate-y-0.5 text-muted-foreground" />
								<span>
									Restore volume data only (skip stack files)
									<span class="block text-xs text-muted-foreground">
										Leave out the captured compose and config - restore just the volume data. Otherwise the stack files are restored and registered in Dockhand so you can edit and redeploy the stack.
									</span>
								</span>
							</label>
						</div>
					{/if}
				{/snippet}
				<div class="mt-3 rounded-md border border-l-[3px] p-3 text-sm {mode === 'in-place' ? 'border-l-destructive bg-destructive/5' : 'border-l-primary bg-primary/5'}">
					<div class="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						{#if mode === 'in-place'}<AlertTriangle class="h-3.5 w-3.5 text-destructive" />{:else}<Info class="h-3.5 w-3.5 text-primary" />{/if}
						What will happen
					</div>
					{#if mode === 'in-place'}
						<p class="leading-relaxed">
							The snapshot{#if backupTime}&nbsp;taken <span class="font-mono">{formatDateTime(backupTime)}</span>{/if}{#if sourceEnvName}&nbsp;from {@render envChip(sourceEnv, sourceEnvName)}{/if} will <b class="text-destructive">overwrite the live data</b>{#if targetEnvName}&nbsp;on {@render envChip(targetEnv, targetEnvName)}{/if}{#if selectedRows.length > 0}:{:else}.{/if}
						</p>
						{#if selectedRows.length > 0}
							<ul class="mt-1.5 space-y-1">
								{#each selectedRows as v}
									{@const t = targetPreview?.volumes.find((x) => x.key === v.name)}
									<li class="flex items-center gap-2 text-xs">
										{#if v.type === 'bind'}<Folder class="h-3 w-3 shrink-0 text-amber-500" />{:else}<HardDrive class="h-3 w-3 shrink-0 text-sky-500" />{/if}
										{#if v.type === 'bind'}<span class="w-9 shrink-0 rounded-full bg-amber-500/15 px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">bind</span>{:else}<span class="w-9 shrink-0 rounded-full bg-sky-500/15 px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">vol</span>{/if}
										<span class="font-mono">{v.name}</span>
										{#if v.type === 'bind' && (t?.target ?? v.origDest)}
											<span class="text-muted-foreground">&rarr; host path</span>
											<span class="min-w-0 break-all font-mono text-muted-foreground">{t?.target ?? v.origDest}</span>
										{:else}
											<span class="text-muted-foreground">wiped &amp; replaced</span>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
						<p class="mt-1.5 leading-relaxed">The {targetIsStack ? 'stack' : 'container'} is <b>stopped before the restore</b> (expect downtime); the volumes are swapped (staged then committed), then <b>{postRestoreLabel.toLowerCase()}</b>.</p>
						<label class="mt-2.5 flex cursor-pointer items-center gap-2 border-t border-destructive/20 pt-2.5 text-sm">
							<Checkbox bind:checked={confirmOverwrite} />
							I understand this replaces the live volume data.
						</label>
					{:else}
						<p class="leading-relaxed">
							The snapshot{#if backupTime}&nbsp;taken <span class="font-mono">{formatDateTime(backupTime)}</span>{/if}{#if sourceEnvName}&nbsp;from {@render envChip(sourceEnv, sourceEnvName)}{/if} will be restored to {@render envChip(targetEnv, targetEnvName)}{#if selectedRows.length > 0}:{:else}.{/if}
						</p>
						{#if selectedRows.length > 0}
							<ul class="mt-1.5 space-y-1">
								{#each selectedRows as v}
									{@const probe = probeByKey.get(v.name)}
									<li class="flex items-center gap-2 text-xs">
										{@render kindBadge(v.type)}
										<span class="font-mono">{v.name}</span>
										<span class="shrink-0 text-muted-foreground">&rarr;</span>
										{@render kindBadge(v.destKind === 'path' ? 'bind' : 'volume')}
										<span class="font-mono {(v.conflict || v.pathInvalid) ? 'text-destructive' : ''}">{v.dest.trim() || '…'}</span>
										<!-- Per-row data probe: a small spinner pill while checking, then a badge. -->
										{#if v.dest.trim()}
											{#if probe}{@render hostDataBadge(probe)}
											{:else if targetPreviewLoading}<span class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"><Loader2 class="h-2.5 w-2.5 animate-spin" />checking on{#if targetEnv}<EnvironmentIcon icon={targetEnv.icon || 'globe'} envId={targetEnv.id} class="h-3 w-3" />{/if}{targetEnvName || 'host'}</span>{/if}
										{/if}
									</li>
								{/each}
							</ul>
							{#if targetsWithData > 0}
								<label class="mt-2 flex cursor-pointer items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
									<Checkbox bind:checked={overwriteAck} class="mt-0.5" />
									<span>I understand existing data at {targetsWithData === 1 ? 'this location' : `these ${targetsWithData} locations`} will be overwritten.</span>
								</label>
							{/if}
						{/if}
						{#if postRestore !== 'none'}
							<p class="mt-1.5 leading-relaxed">Then Dockhand will <b>{postRestoreLabel.toLowerCase()}</b> on {@render envChip(targetEnv, targetEnvName)}{#if sourceEnvName && sourceEnvName !== targetEnvName}. Nothing on {@render envChip(sourceEnv, sourceEnvName)} is touched{/if}.</p>
						{:else}
							<p class="mt-1.5 leading-relaxed">The {targetIsStack ? 'stack' : 'container'} is <b>not started</b> — the data lands on {@render envChip(targetEnv, targetEnvName)} and you bring it up yourself.</p>
						{/if}
						{#if showSecretRestore}
							<p class="mt-1.5 leading-relaxed">
								{#if restoreSecrets}
									Its <b>{sourceSecretKeys.length} secret{sourceSecretKeys.length === 1 ? '' : 's'}</b> will be restored from the backup.
								{:else}
									Its <b>{sourceSecretKeys.length} secret{sourceSecretKeys.length === 1 ? '' : 's'}</b> will <b>not</b> be restored — set {sourceSecretKeys.length === 1 ? 'it' : 'them'} by hand afterwards.
								{/if}
							</p>
						{/if}
						{#if hasRemap}
							<!-- The recreate/redeploy uses the snapshot's STORED config/compose, which
							     still references the ORIGINAL mounts — it won't follow a redirected
							     name/type, so the target would come up on the wrong (empty) volume. -->
							<div class="mt-2.5 rounded-md border border-l-[3px] border-amber-500/30 border-l-amber-500 bg-amber-500/10 p-2.5">
								<div class="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
									<AlertTriangle class="h-3.5 w-3.5" /> You have changed a volume's name or type
								</div>
								<p class="text-xs leading-relaxed text-amber-700 dark:text-amber-300/90">Your data goes to the new volumes. But the {targetIsStack ? 'stack redeploys from the stored compose file, which still names' : 'recreated container mounts'} the <b>original</b> ones — so it {targetIsStack ? 'starts with empty volumes' : "won't see the restored data"}.</p>
								<p class="mt-1 text-xs leading-relaxed text-amber-700 dark:text-amber-300/90"><b>After restoring:</b> {targetIsStack ? 'update the compose file to the new volume names, then redeploy.' : 'edit the container and point the mount at the new volume.'}</p>
								{#if postRestore === 'none'}<p class="mt-1 text-[11px] leading-relaxed text-amber-600/70 dark:text-amber-300/60">Next step set to <b>Do nothing</b> so it can't start with the wrong data.</p>{/if}
							</div>
						{/if}
					{/if}
				</div>
			</div>
			{/if}
			</div>

		<Dialog.Footer class="shrink-0">
			{#if restoreStatus === 'success' || restoreStatus === 'warning' || restoreStatus === 'error'}
				<Button variant="outline" onclick={() => (open = false)}>OK</Button>
			{:else if restoreStatus !== 'running'}
				<Button variant="outline" onclick={() => (open = false)} disabled={restoring}>Cancel</Button>
				<!-- Hide the restore action until the snapshot is read — until then we
				     don't know its volumes/target, so there's nothing to restore yet. -->
				{#if !loading}
					<Button
						onclick={executeRestore}
						disabled={!canRun || restoring}
						variant={mode === 'in-place' ? 'destructive' : 'default'}
					>
						{#if restoring}<Loader2 class="mr-1.5 h-4 w-4 animate-spin" />{:else if targetPreviewLoading}<Loader2 class="mr-1.5 h-4 w-4 animate-spin" />{:else}<Play class="mr-1.5 h-4 w-4" />{/if}
						{#if targetPreviewLoading && !restoring}
							Checking target&hellip;
						{:else}
							{mode === 'in-place' ? 'Overwrite & restore' : (postRestore !== 'none' ? 'Restore & start' : 'Restore')}
						{/if}
					</Button>
				{/if}
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
