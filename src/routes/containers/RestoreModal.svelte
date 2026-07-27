<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { RotateCcw, AlertTriangle, Loader2, HardDrive, Folder, Clock, Play, CheckCircle2, XCircle, Server, PackagePlus, Ban, Rocket, Box, Layers, HelpCircle, Info } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { toast } from 'svelte-sonner';
	import { watchJob } from '$lib/utils/sse-fetch';
	import { environments } from '$lib/stores/environment';
	import { formatDateTime } from '$lib/stores/settings';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import LogConsole from '$lib/components/LogConsole.svelte';
	import { tagLogLine, classifyJobResult } from '$lib/utils/backup';

	interface Props {
		open: boolean;
		destinationId: number;
		snapshotId: string;
		containerName: string;
		environmentId?: number;
		/** Refresh callback fired once the restore succeeds — the caller reloads its
		 *  snapshot list. This modal is ALWAYS self-contained (form → log → result in
		 *  one dialog); it never delegates its progress UI to a parent. */
		onDone?: () => void;
	}
	let { open = $bindable(), destinationId, snapshotId, containerName, environmentId, onDone }: Props = $props();

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
	const postRestoreLabel = $derived(postRestoreOptions.find((o) => o.value === postRestore)?.label ?? '');
	// Step-rail styling: always neutral (primary). Only the What-will-happen box
	// turns red on the destructive (in-place) path — the rail/numbers stay calm.
	// z-10 + solid dialog bg so the connector line is capped AT the circle edge and
	// never shows through its (previously translucent) center.
	const stepRingClass = 'relative z-10 border-primary/40 bg-background text-primary';
	const stepLineClass = 'bg-primary/25';

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
		(mode === 'in-place'
			? confirmOverwrite
			: (
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
			restoreStatus = 'idle';
			restoreLogs = [];
			restoreWarning = '';
			error = '';
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
			const res = await fetch('/api/backup/restore/preview', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ destinationId, snapshotId, environmentId })
			});
			if (!res.ok) {
				error = (await res.json()).error || 'Failed to read the snapshot';
				return;
			}
			const data = await res.json();
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
		} catch {
			error = 'Failed to read the snapshot';
		} finally {
			loading = false;
		}
	}

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
					confirmOverwrite: mode === 'in-place' ? confirmOverwrite : undefined,
					// postRestore is sent for BOTH modes now (clone brings the target up).
					postRestore,
					targetPath: mode === 'new-location' ? targetPath.trim() : undefined,
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
			<Dialog.Title class="flex flex-wrap items-center gap-x-2 gap-y-1">
				<RotateCcw class="h-4 w-4" /> Restore
				{#if !loading}{#if targetIsStack}<Layers class="h-4 w-4 text-muted-foreground" />{:else}<Box class="h-4 w-4 text-muted-foreground" />{/if}{/if}
				<span>{containerName}</span>
				{#if targetEnv}
					<span class="text-muted-foreground">{mode === 'in-place' ? 'on' : 'to'}</span>
					<span class="flex items-center gap-1 font-medium text-amber-500"><EnvironmentIcon icon={targetEnv.icon || 'globe'} envId={targetEnv.id} class="h-3.5 w-3.5" />{targetEnvName}</span>
				{/if}
				<Badge variant="outline" class="font-mono text-[10px]">{snapshotId.slice(0, 8)}</Badge>
				{#if backupTime}<span class="flex items-center gap-1 text-xs font-normal text-muted-foreground"><Clock class="h-3 w-3" />{formatDateTime(backupTime)}</span>{/if}
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
						</div>
					{:else}
						<div class="space-y-1.5 rounded border p-2">
							{#each volumes as vol}
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
							{/each}
						</div>
					{/if}
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

				<!-- What will happen: a live prose recap driven by the form. Env names amber,
				     each prefixed by the env's icon (same as the modal header). -->
				{#snippet envChip(env: { id: number; icon?: string | null } | undefined, name: string)}
					<span class="inline-flex items-center gap-1 align-middle font-medium text-amber-500">{#if env}<EnvironmentIcon icon={env.icon || 'globe'} envId={env.id} class="h-3.5 w-3.5" />{/if}{name || '…'}</span>
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
									<li class="flex items-center gap-2 text-xs">
										{#if v.type === 'bind'}<Folder class="h-3 w-3 shrink-0 text-amber-500" />{:else}<HardDrive class="h-3 w-3 shrink-0 text-sky-500" />{/if}
										{#if v.type === 'bind'}<span class="w-9 shrink-0 rounded-full bg-amber-500/15 px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">bind</span>{:else}<span class="w-9 shrink-0 rounded-full bg-sky-500/15 px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">vol</span>{/if}
										<span class="font-mono">{v.name}</span>
										<span class="text-muted-foreground">wiped &amp; replaced</span>
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
									<li class="flex items-center gap-2 text-xs">
										{#if v.type === 'bind'}<Folder class="h-3 w-3 shrink-0 text-amber-500" />{:else}<HardDrive class="h-3 w-3 shrink-0 text-sky-500" />{/if}
										{#if v.type === 'bind'}<span class="w-9 shrink-0 rounded-full bg-amber-500/15 px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">bind</span>{:else}<span class="w-9 shrink-0 rounded-full bg-sky-500/15 px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">vol</span>{/if}
										<span class="font-mono">{v.name}</span>
										<span class="text-muted-foreground">→ {v.destKind === 'path' ? 'host path' : 'named volume'}</span>
										<span class="font-mono {(v.conflict || v.pathInvalid) ? 'text-destructive' : ''}">{v.dest.trim() || '…'}</span>
									</li>
								{/each}
							</ul>
						{/if}
						{#if postRestore !== 'none'}
							<p class="mt-1.5 leading-relaxed">Then Dockhand will <b>{postRestoreLabel.toLowerCase()}</b> on {@render envChip(targetEnv, targetEnvName)}{#if sourceEnvName && sourceEnvName !== targetEnvName}. Nothing on {@render envChip(sourceEnv, sourceEnvName)} is touched{/if}.</p>
						{:else}
							<p class="mt-1.5 leading-relaxed">The {targetIsStack ? 'stack' : 'container'} is <b>not started</b> — the data lands on {@render envChip(targetEnv, targetEnvName)} and you bring it up yourself.</p>
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
						{#if restoring}<Loader2 class="mr-1.5 h-4 w-4 animate-spin" />{:else}<Play class="mr-1.5 h-4 w-4" />{/if}
						{mode === 'in-place' ? 'Overwrite & restore' : (postRestore !== 'none' ? 'Restore & start' : 'Restore')}
					</Button>
				{/if}
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
