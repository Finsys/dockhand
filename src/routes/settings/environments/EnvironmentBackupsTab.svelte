<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Select from '$lib/components/ui/select';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import { Box, Layers, Loader2, Plus, ChevronDown, ChevronRight, ArrowRight, Zap, GitBranch, HelpCircle } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { formatCron, getRepoTypeIcon } from '$lib/utils/backup';
	import { cronstrueLocale } from '$lib/i18n/cron';
	import { standaloneContainers, volumesForStack, batchSkipDecision, type BackupItem } from '$lib/utils/mounts';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import BackupPanel from '../../containers/BackupPanel.svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		environmentId: number;
		environmentName: string;
		connectionType?: string;
		host?: string | null;
	}

	let { environmentId, environmentName, connectionType, host }: Props = $props();

	interface BackupConfig { id: number; targetName: string; type: string; destinationId: number; schedule: string | null; destinationName?: string; }

	// `external` = an untracked stack (unknown compose path). Not backup-able — shown
	// disabled, excluded from configure / batch, per assertStackBackupable.
	// `git` = a git-deployed stack (marked with a small "git" pill).
	type BackupListItem = BackupItem & { external?: boolean; git?: boolean };
	let items = $state<BackupListItem[]>([]);
	let configs = $state<BackupConfig[]>([]);
	let destinations = $state<Map<number, { name: string; repository: string }>>(new Map());
	let destList = $state<{ id: number; name: string; repository: string }[]>([]);
	let loading = $state(true);
	let expandedItem = $state<string | null>(null);

	// Batch setup
	let showBatch = $state(false);
	let batchDestId = $state<number>(0);
	let batchSchedule = $state('0 2 * * *');
	let batchSaving = $state(false);
	// One-time: created schedules prefer named volumes and skip host bind mounts.
	// batchSkipDecision decides per item - a down stack (volumes unknown) keeps all, a
	// bind-only container is skipped. A snapshot of the current mounts; edit later to change.
	let batchSkipBinds = $state(false);
	// All destinations are selectable; a local repo on a non-co-located env fails
	// loud at run time (helper localRepoGuard), not hidden here.
	const usableDestinations = $derived(destList);
	// External stacks can't be backed up — exclude them from the unconfigured count
	// and from "Schedule all" so the number reflects only backup-able targets. The
	// list mixes stacks and standalone containers, and "Schedule all" configs BOTH,
	// so split the count by type to make clear what the batch will create.
	const unconfiguredItems = $derived(items.filter(i => !i.external && !configs.some(c => c.targetName === i.name)));
	const unconfiguredStacks = $derived(unconfiguredItems.filter(i => i.type === 'stack').length);
	const unconfiguredContainers = $derived(unconfiguredItems.filter(i => i.type === 'container').length);
	const unconfiguredCount = $derived(unconfiguredItems.length);
	/** "3 stacks + 5 containers" / "3 stacks" / "5 containers" — only the non-zero parts. */
	const unconfiguredLabel = $derived([
		unconfiguredStacks > 0 ? m.settings_envs_stack_count({ count: unconfiguredStacks }) : '',
		unconfiguredContainers > 0 ? m.settings_envs_container_count({ count: unconfiguredContainers }) : '',
	].filter(Boolean).join(' + '));

	async function fetchAll() {
		loading = true;
		try {
			const [containerRes, stackRes, configRes, destRes] = await Promise.all([
				fetch(`/api/containers?env=${environmentId}`),
				fetch(`/api/stacks?env=${environmentId}`),
				fetch(`/api/backup/configs?env=${environmentId}`),
				fetch('/api/backup/destinations')
			]);

			// Stacks come from /api/stacks (knows sourceType, includes stopped stacks);
			// standalone containers from /api/containers. Reconstructing stacks from
			// container labels (the old path) couldn't see sourceType and dropped any
			// stopped stack. An external/untracked stack (unknown compose path) is
			// listed but flagged not backup-able.
			const containers = containerRes.ok ? await containerRes.json() : [];
			const stacks = stackRes.ok ? await stackRes.json() : [];
			const stackItems: BackupListItem[] = (Array.isArray(stacks) ? stacks : []).map((s: any): BackupListItem => ({
				name: s.name,
				type: 'stack',
				volumes: volumesForStack(containers, s.name),
				external: s.sourceType !== 'internal' && s.sourceType !== 'git',
				git: s.sourceType === 'git'
			}));
			items = [
				...stackItems.sort((a, b) => a.name.localeCompare(b.name)),
				...standaloneContainers(containers)
			];

			if (destRes.ok) {
				const dests = await destRes.json();
				destList = dests;
				destinations = new Map(dests.map((d: any) => [d.id, { name: d.name, repository: d.repository }]));
			}

			if (configRes.ok) {
				const raw = await configRes.json();
				configs = Array.isArray(raw) ? raw : [];
			}
		} catch {}
		loading = false;
	}

	function getItemConfigs(name: string): BackupConfig[] {
		return configs.filter(c => c.targetName === name);
	}

	async function refreshConfigs() {
		try {
			const res = await fetch(`/api/backup/configs?env=${environmentId}`);
			if (res.ok) {
				const raw = await res.json();
				configs = Array.isArray(raw) ? raw : [];
			}
		} catch {}
	}

	function toggleExpand(name: string) {
		expandedItem = expandedItem === name ? null : name;
	}

	async function batchApply() {
		if (!batchDestId) { toast.error(m.settings_envs_backup_select_repository_error()); return; }
		batchSaving = true;
		let created = 0;
		let skippedBindOnly = 0;
		for (const item of items) {
			if (item.external) continue; // external stacks aren't backup-able
			if (configs.some(c => c.targetName === item.name)) continue; // skip already configured

			// Base body: back up all volumes (current behaviour). With "skip bind mounts"
			// on, narrow the selection to this item's named volumes as it stands now.
			const body: Record<string, unknown> = {
				targetName: item.name,
				type: item.type,
				destinationId: batchDestId,
				environmentId,
				schedule: batchSchedule || null,
				retention: { keepLast: 7, keepDaily: 7 }
			};
			if (batchSkipBinds) {
				const decision = batchSkipDecision(item);
				if (decision.action === 'skip') { skippedBindOnly++; continue; }
				// 'all' leaves allVolumes at its default true (a down stack whose volumes we
				// can't yet see - capture everything once it comes up rather than freezing an
				// empty selection). 'named' narrows to the item's named volumes.
				if (decision.action === 'named') {
					body.allVolumes = false;
					body.selectedVolumes = decision.selectedVolumes;
				}
			}

			try {
				const res = await fetch('/api/backup/configs', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				});
				if (res.ok) created++;
			} catch {}
		}
		const parts = [m.settings_envs_backup_batch_created({ count: created })];
		if (skippedBindOnly > 0) parts.push(m.settings_envs_backup_batch_skipped({ count: skippedBindOnly }));
		toast.success(parts.join(', '));
		showBatch = false;
		batchSaving = false;
		await fetchAll();
	}

	onMount(fetchAll);
</script>

{#if loading}
	<div class="flex items-center justify-center py-12">
		<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
	</div>
{:else if items.length === 0}
	<p class="text-sm text-muted-foreground py-4 text-center">{m.settings_envs_backup_empty()}</p>
{:else}
	<!-- Batch setup -->
	{#if unconfiguredCount > 0}
		{#if !showBatch}
			<div class="mb-2">
				<Button variant="outline" size="sm" class="w-full" onclick={() => { showBatch = true; if (!batchDestId && usableDestinations.length > 0) batchDestId = usableDestinations[0].id; }}>
					<Zap class="w-3.5 h-3.5 mr-1.5" />{m.settings_envs_backup_schedule_all({ items: unconfiguredLabel })}
				</Button>
			</div>
		{:else}
			<div class="mb-2 border rounded-md p-2.5 bg-muted/20 space-y-2">
				<div class="flex items-center gap-2">
					<Select.Root type="single" value={batchDestId ? String(batchDestId) : ''} onValueChange={(v) => batchDestId = v ? parseInt(v) : 0}>
						<Select.Trigger class="h-9 text-xs w-[200px] flex-shrink-0">
							{#if batchDestId}
								{@const dest = destList.find(d => d.id === batchDestId)}
								{#if dest}
									{@const DIcon = getRepoTypeIcon(dest.repository)}
									<span class="flex items-center gap-1.5 truncate"><DIcon class="w-3.5 h-3.5 text-primary/60 flex-shrink-0" />{dest.name}</span>
								{/if}
							{:else}{m.settings_envs_backup_select_repository()}{/if}
						</Select.Trigger>
						<Select.Content>
							{#each usableDestinations as dest}
								{@const DIcon = getRepoTypeIcon(dest.repository)}
								<Select.Item value={String(dest.id)}>
									<span class="flex items-center gap-1.5"><DIcon class="w-3.5 h-3.5 text-muted-foreground" />{dest.name}</span>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<CronEditor value={batchSchedule} onchange={(v) => batchSchedule = v} />
				</div>
				<div class="flex items-center gap-2 text-xs">
					<TogglePill bind:checked={batchSkipBinds} onLabel={m.containers_backup_yes()} offLabel={m.containers_backup_no()} />
					<span class="whitespace-nowrap">{m.settings_envs_backup_skip_bind_mounts()}</span>
					<Tooltip.Root>
						<Tooltip.Trigger>
							<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<div class="w-64">
								<p class="text-xs">{m.settings_envs_backup_skip_bind_mounts_hint()}</p>
							</div>
						</Tooltip.Content>
					</Tooltip.Root>
				</div>
				<div class="flex items-center justify-end gap-2">
					<Button variant="ghost" size="sm" class="text-xs" onclick={() => showBatch = false}>{m.containers_backup_cancel()}</Button>
					<Button size="sm" disabled={!batchDestId || batchSaving} onclick={batchApply}>
						{#if batchSaving}<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />{/if}
						{m.settings_envs_backup_schedule_items({ items: unconfiguredLabel })}
					</Button>
				</div>
			</div>
		{/if}
	{/if}

	<div class="space-y-0 max-h-[440px] overflow-y-auto">
		{#each items as item}
			{@const itemConfigs = getItemConfigs(item.name)}
			{@const hasBackup = itemConfigs.length > 0}
			{@const isExpanded = expandedItem === item.name}

			<div class="border-b last:border-0">
				<!-- Row. External (untracked) stacks aren't backup-able: shown disabled,
				     no expand, a hint to adopt instead of a "configure" action. -->
				<svelte:element
					this={item.external ? 'div' : 'button'}
					role={item.external ? undefined : 'button'}
					class="flex items-center gap-2 w-full py-2 px-1 text-left rounded-sm {item.external ? 'opacity-60' : 'hover:bg-muted/30'}"
					onclick={item.external ? undefined : () => toggleExpand(item.name)}
				>
					{#if item.external}
						<span class="w-3.5 flex-shrink-0"></span>
					{:else if isExpanded}
						<ChevronDown class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
					{:else}
						<ChevronRight class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
					{/if}
					{#if item.type === 'stack'}
						<Layers class="w-3.5 h-3.5 text-purple-500 flex-shrink-0" />
					{:else}
						<Box class="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
					{/if}
					<span class="flex min-w-0 flex-1 items-center gap-1.5">
						<span class="truncate text-sm">{item.name}</span>
						{#if item.git}
							<span class="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400" title={m.settings_envs_backup_git_stack_title()}><GitBranch class="h-2.5 w-2.5" />git</span>
						{/if}
						{#if item.external}
							<span class="inline-flex flex-shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" title={m.settings_envs_backup_external_title()}>{m.settings_envs_backup_external()}</span>
						{/if}
					</span>

					{#if item.external}
						<span class="text-xs text-muted-foreground/60 flex-shrink-0" title={m.settings_envs_backup_adopt_first_title()}>{m.settings_envs_backup_adopt_first()}</span>
					{:else if hasBackup}
						<ArrowRight class="w-3 h-3 text-muted-foreground/40 flex-shrink-0" />
						{#if itemConfigs.length === 1}
							{@const cfg = itemConfigs[0]}
							{@const dest = destinations.get(cfg.destinationId)}
							<span class="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
								{#if dest}
									{@const DestIcon = getRepoTypeIcon(dest.repository)}
									<DestIcon class="w-3 h-3 text-primary/60" />
									{dest.name}
								{/if}
								{cfg.schedule ? formatCron(cfg.schedule, cronstrueLocale()) : m.settings_envs_backup_manual()}
							</span>
						{:else}
							<span class="text-xs text-muted-foreground flex-shrink-0">{m.settings_envs_backup_schedule_count({ count: itemConfigs.length })}</span>
						{/if}
					{:else}
						<span class="text-xs text-muted-foreground/50 flex items-center gap-1 flex-shrink-0">
							<Plus class="w-3 h-3" />{m.settings_envs_backup_configure()}
						</span>
					{/if}
				</svelte:element>

				<!-- Expanded: BackupPanel (never for external stacks — see the row above) -->
				{#if isExpanded && !item.external}
					<div class="ml-6 mr-1 mb-3 mt-1 p-3 border rounded-md bg-muted/20">
						<BackupPanel
							containerName={item.name}
							volumes={item.volumes}
							type={item.type}
							environmentId={environmentId}
							onConfigSaved={refreshConfigs}
						/>
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
