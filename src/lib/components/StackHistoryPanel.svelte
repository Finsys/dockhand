<script lang="ts">
	/**
	 * Self-contained "History" widget for one stack + one version type (M001 S05).
	 *
	 * Mirrors RedeployPopover.svelte: a compact ghost trigger (lucide History icon)
	 * wrapped in a bits-ui Popover. Opening the popover fetches the S04
	 * GET /api/stacks/[name]/history?type=<type> (secret-free version list + the
	 * last_saved_at / last_deployed_at pointers) and renders a saved-vs-deployed
	 * indicator over a newest-first list with a per-row Revert (POST action:'revert').
	 *
	 * `type` is a fixed prop (the compose History button passes 'compose', the env
	 * History button passes 'env') - there is no internal type toggle. The API returns
	 * a secret-free list with NO content, so this is a list + revert surface, not a
	 * diff/content-preview surface. `readonly` disables Revert (viewing is always allowed).
	 */
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { History, RotateCcw, Loader2, Clock, Check, AlertCircle, Circle } from 'lucide-svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { formatRelativeTime, formatDateTime } from '$lib/stores/settings';
	import { historyStatus, type StackVersionRef, type HistoryStatus } from '$lib/utils/stack-history';

	interface Props {
		stackName: string;
		envId: number | null;
		type: 'compose' | 'env';
		readonly?: boolean;
		side?: 'top' | 'bottom';
		align?: 'start' | 'center' | 'end';
		/** Optional text rendered next to the History icon (defaults to icon-only). */
		label?: string;

		/** Match the muted icon tone of the path-bar action buttons (text-zinc-500 / dark:text-zinc-400). */
		muted?: boolean;

		/** Extra tone classes for the labeled trigger (e.g. match the Validate/Copy ghost buttons). */
		toneClass?: string;

		/**
		 * Whether the host editor for this type has UNSAVED changes. When true the
		 * editor no longer matches any recorded version, so the "current" row badge
		 * is hidden and an amber "unsaved changes" chip is shown in the pointers row.
		 * When false, the row whose timestamp matches last_saved_at gets a "current"
		 * badge - i.e. the version the editor currently displays (save advances the
		 * pointer, revert points it at the reverted version).
		 */
		dirty?: boolean;

		/** Called after a successful revert so the host can re-read the reverted content in place. */
		onreverted?: (type: 'compose' | 'env') => void;
	}
	let {
		stackName,
		envId,
		type,
		readonly = false,
		side = 'bottom',
		align = 'end',
		label = '',
		muted = false,
		toneClass = '',
		dirty = false,
		onreverted,
	}: Props = $props();

	let open = $state(false);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let versions = $state<StackVersionRef[]>([]);
	let lastSavedAt = $state<string | null>(null);
	let lastDeployedAt = $state<string | null>(null);
	let currentVersionId = $state<string | null>(null);
	let deployStartedAt = $state<string | null>(null);
	let revertingId = $state<string | null>(null);

	const status = $derived<HistoryStatus>(historyStatus(versions, lastSavedAt, lastDeployedAt, deployStartedAt));

	// Fetch fresh data each time the popover opens (a cheap single GET).
	$effect(() => {
		if (open) void load();
	});

	async function load() {
		loading = true;
		error = null;
		try {
			const target = appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/history?type=${type}`, envId);
			const res = await fetch(target);
			const data: { error?: string; versions?: StackVersionRef[]; lastSavedAt?: string | null; lastDeployedAt?: string | null; currentVersionId?: string | null; deployStartedAt?: string | null } =
				await res.json();
			if (!res.ok) {
				throw new Error(typeof data.error === 'string' ? data.error : `Failed to load ${type} history (HTTP ${res.status})`);
			}
			versions = data.versions ?? [];
			lastSavedAt = data.lastSavedAt ?? null;
			lastDeployedAt = data.lastDeployedAt ?? null;
			currentVersionId = data.currentVersionId ?? null;
			deployStartedAt = data.deployStartedAt ?? null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load history';
			console.error('Error loading stack history:', e);
		} finally {
			loading = false;
		}
	}

	async function revert(versionId: string) {
		revertingId = versionId;
		try {
			const target = appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/history`, envId);
			const res = await fetch(target, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'revert', type, versionId })
			});
			const data: { error?: string } = await res.json();
			if (!res.ok) {
				throw new Error(typeof data.error === 'string' ? data.error : `Revert failed (HTTP ${res.status})`);
			}
			// last_saved_at advanced on a successful revert -> refresh list + pointers.
			await load();
			onreverted?.(type);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Revert failed';
			console.error('Error reverting stack version:', e);
		} finally {
			revertingId = null;
		}
	}

	function isUndeployed(v: StackVersionRef): boolean {
		// Effective deploy reference: the pointer when set, else the runtime
		// external-deploy reference (oldest running container's creation time).
		const ref = lastDeployedAt ?? deployStartedAt;
		if (ref === null) return false;
		const d = new Date(ref).getTime();
		const t = new Date(v.timestamp).getTime();
		return !Number.isNaN(t) && !Number.isNaN(d) && t > d;
	}

	/**
	 * Whether a row is the version the editor currently displays. Primary source:
	 * `currentVersionId` from the history API - the newest version whose content
	 * equals the LIVE source for this type (a shared last_saved_at pointer cannot
	 * identify this per type: one column serves both compose and env). Fallback
	 * (server returned null, e.g. live source missing): the row the last_saved_at
	 * pointer references. Suppressed while the editor is dirty (content matches no
	 * version).
	 */
	function isCurrent(v: StackVersionRef): boolean {
		if (dirty) return false;
		if (currentVersionId !== null) return v.id === currentVersionId;
		return lastSavedAt !== null && (v.timestamp === lastSavedAt || v.id === lastSavedAt);
	}

	// Indicator presentation mapping: state -> { cls, icon, label }.
	function indicatorFor(status: HistoryStatus): { cls: string; icon: any; label: string } {
		switch (status.state) {
			case 'in-sync':
				return { cls: 'text-emerald-600 dark:text-emerald-400', icon: Check, label: 'In sync' };
			case 'undeployed':
				return {
					cls: 'text-amber-600 dark:text-amber-400',
					icon: AlertCircle,
					label: status.undeployedCount === 1 ? '1 unsaved change' : `${status.undeployedCount} unsaved changes`
				};
			case 'never-deployed':
				return { cls: 'text-zinc-500 dark:text-zinc-400', icon: Circle, label: 'Not yet deployed' };
			case 'running-unsaved':
				return {
					cls: 'text-amber-600 dark:text-amber-400',
					icon: AlertCircle,
					label: 'Running - deployed content never saved'
				};
			case 'empty':
				return { cls: 'text-zinc-400 dark:text-zinc-500', icon: Circle, label: 'No versions' };
			default:
				return { cls: 'text-zinc-400', icon: Circle, label: '' };
		}
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger asChild>
		{#snippet child({ props })}
			{#if label}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					{...props}
					class="h-6 px-2 text-xs {toneClass}"
					title={`${type === 'compose' ? 'Compose' : 'Env'} version history`}
					aria-label={`${type === 'compose' ? 'Compose' : 'Env'} version history`}
				>
					<History class="w-3.5 h-3.5" />
					{label}
				</Button>
				{:else}
				<button
					type="button"
					{...props}
					class="px-1.5 py-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors cursor-pointer inline-flex items-center gap-1 {muted ? 'text-zinc-500 dark:text-zinc-400' : ''}"
					title={`${type === 'compose' ? 'Compose' : 'Env'} version history`}
					aria-label={`${type === 'compose' ? 'Compose' : 'Env'} version history`}
				>
					<History class="w-3.5 h-3.5 shrink-0" />
				</button>
			{/if}
		{/snippet}
	</Popover.Trigger>

	<Popover.Content class="w-80 p-0 z-[200]" {side} {align} sideOffset={8}>
		<div class="space-y-3">
			<!-- Header + saved-vs-deployed indicator -->
			<div class="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-2">
				<span class="text-xs font-medium flex-1">{type === 'compose' ? 'Compose' : 'Env'} history</span>
				<!-- Indicator (only meaningful once a fetch has settled) -->
				{#if loading}
					<span class="text-[11px] text-zinc-400 dark:text-zinc-500">loading…</span>
				{:else if error === null}
					{@const indicator = indicatorFor(status)}
					{@const Icon = indicator.icon}
					<span class="inline-flex items-center gap-1 text-[11px] {indicator.cls}">
						<Icon class="w-3 h-3" />
						{indicator.label}
					</span>
				{/if}
			</div>

			<!-- Pointers (last saved / last deployed) + editor state -->
			{#if !loading && error === null && (lastSavedAt || lastDeployedAt || dirty)}
				<div class="px-3 flex items-center gap-3 text-[11px] text-zinc-500 dark:text-zinc-400">
					{#if dirty}
						<Badge variant="outline" class="border-amber-500/40 text-amber-600 dark:text-amber-400 text-[10px] px-1.5 py-0">unsaved changes</Badge>
				{/if}
					{#if lastSavedAt || lastDeployedAt || deployStartedAt}
						<span>
							Saved: {lastSavedAt ? formatRelativeTime(lastSavedAt) : 'never'}
						</span>
						{#if lastDeployedAt}
							<span>
								Deployed: {formatRelativeTime(lastDeployedAt)}
							</span>
						{:else if deployStartedAt}
							<span title="Deployed outside Dockhand (docker CLI / compose up) - detected from the running container, not a Dockhand deploy record.">
								Deployed: {formatRelativeTime(deployStartedAt)} (external)
							</span>
						{:else}
							<span>
								Deployed: never
							</span>
						{/if}
					{/if}
				</div>
			{/if}

			<!-- Body: loading / error / empty / list -->
			<div class="px-3 py-2">
				{#if loading}
					<div class="flex items-center justify-center gap-2 py-6 text-zinc-400 dark:text-zinc-500">
						<Loader2 class="w-4 h-4 animate-spin" />
						<span class="text-xs">Loading history…</span>
					</div>
				{:else if error !== null}
					<div class="flex flex-col items-center gap-2 py-6 text-center">
						<AlertCircle class="w-5 h-5 text-red-500" />
						<p class="text-xs text-red-600 dark:text-red-400 max-w-[16rem]">{error}</p>
						<Button variant="outline" size="sm" class="h-7 text-xs" onclick={() => void load()}>
							Retry
						</Button>
					</div>
				{:else if versions.length === 0}
					<div class="flex flex-col items-center gap-2 py-6 text-center">
						<Circle class="w-5 h-5 text-zinc-300 dark:text-zinc-600" />
						<p class="text-xs text-zinc-500 dark:text-zinc-400">No saved versions yet.</p>
					</div>
				{:else}
					<ul class="space-y-0.5 max-h-72 overflow-y-auto">
						{#each versions as v (v.id)}
							<li class="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800/40">
								<Clock class="w-3 h-3 text-zinc-400 dark:text-zinc-500 shrink-0" />
								<span class="text-xs flex-1 text-zinc-600 dark:text-zinc-300 truncate" title={formatDateTime(v.timestamp)}>
									{formatRelativeTime(v.timestamp)}
								</span>
								{#if v.id === status.deployedVersionId}
									<Badge variant="outline" class="border-emerald-500/40 text-emerald-600 dark:text-emerald-400 text-[10px] px-1.5 py-0">deployed</Badge>
								{:else if isUndeployed(v)}
									<Badge variant="outline" class="border-amber-500/40 text-amber-600 dark:text-amber-400 text-[10px] px-1.5 py-0">unsaved</Badge>
								{/if}
								{#if isCurrent(v)}
									<Badge variant="outline" class="border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[10px] px-1.5 py-0">current</Badge>
								{/if}
								<Button
									variant="ghost"
									size="sm"
									class="h-6 px-2 text-xs"
									disabled={readonly || revertingId !== null}
									onclick={() => void revert(v.id)}
								>
									{#if revertingId === v.id}
										<Loader2 class="w-3 h-3 animate-spin" />
									{:else}
										<RotateCcw class="w-3 h-3" />
									{/if}
									Revert
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</Popover.Content>
</Popover.Root>
