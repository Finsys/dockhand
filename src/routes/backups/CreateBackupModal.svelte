<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { SearchInput } from '$lib/components/ui/search-input';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import { Package, Box, Layers, Loader2, CheckCircle2, ArrowBigRight, Settings, Clock, Play } from 'lucide-svelte';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import { getRepoTypeIcon, formatCron, runBackupAction, type BackupFormState } from '$lib/utils/backup';
	import { toast } from 'svelte-sonner';
	import VolumePicker from '$lib/components/backup/VolumePicker.svelte';
	import StackFilesPicker from '$lib/components/backup/StackFilesPicker.svelte';
	import DestinationPicker from '$lib/components/backup/DestinationPicker.svelte';
	import { normalizeMounts, volumesForStack, fileBindKeys, type VolumeInfo } from '$lib/utils/mounts';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		onCreated?: () => void;
		/** Called after the config is saved with intent to RUN — the parent opens the
		 *  shared BackupLogModal for it (same log UI as Run-now). */
		onRun?: (r: { configId: number; targetName: string }) => void;
	}

	let { open = $bindable(), onCreated, onRun }: Props = $props();

	interface Environment { id: number; name: string; icon?: string; connectionType?: string; host?: string | null; }
	interface Destination { id: number; name: string; repository: string; hostPath?: string | null; }
	interface ContainerItem { name: string; type: 'container' | 'stack'; envId: number; envName: string; envIcon?: string; volumes: VolumeInfo[]; }

	let step = $state<1 | 2 | 3>(1);

	// Step 1: Select source
	let environments = $state<Environment[]>([]);
	let selectedEnvId = $state<number | undefined>(undefined);
	let containers = $state<ContainerItem[]>([]);
	let loadingContainers = $state(false);
	let searchQuery = $state('');
	let selectedItem = $state<ContainerItem | null>(null);

	// Step 2: Configure
	let destinations = $state<Destination[]>([]);
	let selectedDestId = $state(0);
	let stopBeforeBackup = $state(false);
	let allVolumes = $state(true);
	let selectedVolumes = $state<string[]>([]);

	// Stack files on the host (probe listing) — stack targets only.
	type StackListing =
		| { kind: 'listed'; hostPath: string; entries: { name: string; type: 'dir' | 'file'; size: number; capturedAs?: 'bind' | 'volume' }[] }
		| { kind: 'helper-failed'; reason: string }
		| { kind: 'unknown'; reason: string }
		| null;
	let stackListing = $state<StackListing>(null);
	// The probe helper couldn't run on the target - a backup can't run either, so block Save.
	const stackHelperFailed = $derived(stackListing?.kind === 'helper-failed');
	let loadingStackListing = $state(false);
	let excludedStackFiles = $state<string[]>([]);
	// The user-set "Remote stack path (for backup)" for direct/hawser envs, shown in the picker
	// tooltip so the user sees THEIR configured path (empty when not set / socket env).
	let stackRemoteDir = $state<string>('');

	async function fetchStackListing(item: ContainerItem) {
		if (item.type !== 'stack') { stackListing = null; return; }
		loadingStackListing = true;
		stackListing = null;
		excludedStackFiles = [];
		stackRemoteDir = '';
		if (item.envId != null) {
			fetch(`/api/environments/${item.envId}/remote-stacks-dir`)
				.then((r) => (r.ok ? r.json() : null))
				.then((d) => { stackRemoteDir = d?.remoteStacksDir ?? ''; })
				.catch(() => { /* non-fatal - tooltip just omits the configured path */ });
		}
		try {
			const envQ = item.envId != null ? `&env=${item.envId}` : '';
			const res = await fetch(`/api/backup/stack-dir-listing?target=${encodeURIComponent(item.name)}${envQ}`);
			stackListing = await res.json();
		} catch (e) {
			stackListing = { kind: 'unknown', reason: e instanceof Error ? e.message : m.containers_backup_probe_failed() };
		} finally {
			loadingStackListing = false;
		}
	}

	// Step 3: Schedule & Run
	let saveSchedule = $state(false);
	let schedule = $state('0 2 * * *');
	let scheduleInvalid = $state(false);
	let saving = $state(false);

	$effect(() => {
		if (open) {
			step = 1;
			selectedItem = null;
			searchQuery = '';
			selectedEnvId = undefined;
			selectedDestId = 0;
			stopBeforeBackup = false;
			allVolumes = true;
			selectedVolumes = [];
			saveSchedule = false;
			schedule = '0 2 * * *';
			saving = false;
			fetchEnvironments();
			fetchDestinations();
		}
	});

	async function fetchEnvironments() {
		try {
			const res = await fetch('/api/environments');
			environments = await res.json();
			if (environments.length === 1) {
				selectedEnvId = environments[0].id;
				fetchContainers(environments[0].id);
			}
		} catch {}
	}

	async function fetchDestinations() {
		try {
			const res = await fetch('/api/backup/destinations');
			destinations = await res.json();
			if (destinations.length === 1) selectedDestId = destinations[0].id;
		} catch {}
	}

	async function fetchContainers(envId: number) {
		loadingContainers = true;
		containers = [];
		try {
			const [contRes, stackRes] = await Promise.all([
				fetch(`/api/containers?env=${envId}`),
				fetch(`/api/stacks?env=${envId}`)
			]);
			const contData = await contRes.json();
			const stackData = await stackRes.json();
			const env = environments.find(e => e.id === envId);
			const items: ContainerItem[] = [];

			if (Array.isArray(contData)) {
				for (const c of contData) {
					items.push({ name: c.name || c.Names?.[0]?.replace(/^\//, ''), type: 'container', envId, envName: env?.name || '', envIcon: env?.icon, volumes: normalizeMounts(c.mounts || c.Mounts) });
				}
			}
			if (Array.isArray(stackData)) {
				for (const s of stackData) {
					// Only internal/git stacks are backup-able — Dockhand knows their compose
					// file location. External/untracked stacks (unknown compose path) would
					// produce an incomplete artifact, and the backend refuses them
					// (assertStackBackupable), so don't offer them as targets here.
					if (s.sourceType !== 'internal' && s.sourceType !== 'git') continue;
					items.push({ name: s.name, type: 'stack', envId, envName: env?.name || '', envIcon: env?.icon, volumes: volumesForStack(contData, s.name) });
				}
			}
			containers = items.sort((a, b) => a.name.localeCompare(b.name));
		} catch {}
		loadingContainers = false;
	}

	function selectSource(item: ContainerItem) {
		selectedItem = item;
		step = 2;
		fetchStackListing(item);
	}

	// Save the config, then (when run=true) hand it off to the parent's shared
	// BackupLogModal — same log UI as Run-now everywhere else. run=false saves the
	// recurring schedule without running now (it fires on cron).
	async function saveAndMaybeRun(run: boolean) {
		if (!selectedItem || !selectedDestId) return;
		saving = true;
		const form: BackupFormState = {
			targetName: selectedItem.name,
			type: selectedItem.type,
			environmentId: selectedItem.envId,
			destinationId: selectedDestId,
			stopBeforeBackup,
			allVolumes,
			selectedVolumes,
			options: excludedStackFiles.length > 0 ? { excludedStackFiles } : undefined
		};
		try {
			const result = await runBackupAction({
				form,
				action: 'save', // persist only; the run is delegated to the parent modal
				schedule: saveSchedule ? schedule : '',
				enabled: saveSchedule
			});
			if (!result.ok || !result.configId) {
				toast.error(result.error || m.backups_create_save_failed());
				return;
			}
			onCreated?.();
			if (run) {
				onRun?.({ configId: result.configId, targetName: selectedItem.name });
			} else {
				toast.success(m.backups_create_schedule_saved());
			}
			open = false;
		} catch (err: any) {
			toast.error(err?.message || m.backups_create_save_failed());
		} finally {
			saving = false;
		}
	}

	const filteredContainers = $derived(
		searchQuery.trim()
			? containers.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
			: containers
	);

	const getDestIcon = getRepoTypeIcon;
	const selectedDest = $derived(destinations.find(d => d.id === selectedDestId));
	// Passed to DestinationPicker so it can hint that a local-path repo needs the
	// env's daemon co-located with Dockhand (advisory only, not a block).
	const selectedEnv = $derived(environments.find((e) => e.id === selectedItem?.envId));
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen && saving) return; open = isOpen; }}>
	<Dialog.Content class="max-w-5xl h-[85vh] flex flex-col">
		<Dialog.Header class="pb-0">
			<Dialog.Title class="flex items-center gap-2 text-base">
				<Package class="w-4 h-4" />{m.backups_create_title()}
			</Dialog.Title>
			{#if selectedItem}
				<Dialog.Description class="flex items-center gap-2 text-sm flex-wrap">
					{#if selectedItem.type === 'container'}<Box class="w-4 h-4 text-blue-500" />{:else}<Layers class="w-4 h-4 text-purple-500" />{/if}
					{selectedItem.name}
					<span class="text-muted-foreground">{m.modalheader_on_env()}</span>
					<EnvironmentIcon icon={selectedItem.envIcon || 'globe'} envId={selectedItem.envId} class="w-4 h-4 text-muted-foreground" />
					<span class="text-muted-foreground">{selectedItem.envName}</span>
					{#if selectedDest}
						<span class="text-muted-foreground">→</span>
						<svelte:component this={getDestIcon(selectedDest.repository)} class="w-4 h-4" />
						<span class="text-muted-foreground">{selectedDest.name}</span>
					{/if}
				</Dialog.Description>
			{/if}
		</Dialog.Header>

		<!-- Stepper tabs -->
		<div class="flex items-center border-b shrink-0 px-1 bg-muted/10">
			<button
				class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-2 {step === 1 ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => step = 1}
			>
				<Box class="w-4 h-4" />
				{m.backups_create_step_source()}
				{#if selectedItem}
					<CheckCircle2 class="w-3.5 h-3.5 text-green-500" />
				{/if}
			</button>
			<ArrowBigRight class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
			<button
				class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 {step === 2 ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'} {selectedItem ? 'cursor-pointer hover:text-foreground' : 'cursor-not-allowed'}"
				disabled={!selectedItem}
				onclick={() => { if (selectedItem) step = 2; }}
			>
				<Settings class="w-4 h-4" />
				{m.backups_create_step_configure()}
				{#if selectedDestId}
					<CheckCircle2 class="w-3.5 h-3.5 text-green-500" />
				{/if}
			</button>
			<ArrowBigRight class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
			<button
				class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 {step === 3 ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'} {selectedItem && selectedDestId ? 'cursor-pointer hover:text-foreground' : 'cursor-not-allowed'}"
				disabled={!selectedItem || !selectedDestId}
				onclick={() => { if (selectedItem && selectedDestId) step = 3; }}
			>
				<Clock class="w-4 h-4" />
				{m.backups_create_step_schedule()}
			</button>
		</div>

		<!-- Step content -->
		{#if step === 1}
			<!-- Sticky env selector + search -->
			<div class="shrink-0 flex gap-2 px-3 pt-3 pb-2">
				<Select.Root type="single" value={selectedEnvId ? String(selectedEnvId) : undefined} onValueChange={(v) => { selectedEnvId = Number(v); selectedItem = null; fetchContainers(Number(v)); }}>
					<Select.Trigger class="h-8 w-48 text-xs">
						{@const env = environments.find(e => e.id === selectedEnvId)}
						{#if env}
							<EnvironmentIcon icon={env.icon || 'globe'} envId={env.id} class="w-3 h-3 mr-1 text-muted-foreground" />{env.name}
						{:else}{m.backups_create_select_environment()}{/if}
					</Select.Trigger>
					<Select.Content>
						{#each environments as env}
							<Select.Item value={String(env.id)}>
								<EnvironmentIcon icon={env.icon || 'globe'} envId={env.id} class="w-3 h-3 mr-1.5 inline text-muted-foreground" />{env.name}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				{#if selectedEnvId}
					<SearchInput bind:value={searchQuery} placeholder={m.backups_create_search_placeholder()} class="h-8 text-xs" containerClass="flex-1" />
				{/if}
			</div>
		{/if}
		<div class="flex-1 min-h-0 flex flex-col overflow-y-auto px-3 pb-3">
			{#if step === 1}
				<!-- Step 1: Select source -->
				<div class="space-y-3">

					{#if loadingContainers}
						<div class="flex items-center justify-center py-8"><Loader2 class="w-5 h-5 animate-spin text-muted-foreground" /></div>
					{:else if selectedEnvId && filteredContainers.length > 0}
						<div class="flex-1 overflow-y-auto border rounded">
							{#each filteredContainers as item}
								<button
									type="button"
									class="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors text-left border-b last:border-0 {selectedItem?.name === item.name && selectedItem?.envId === item.envId ? 'bg-primary/10' : ''}"
									onclick={() => selectSource(item)}
								>
									{#if item.type === 'container'}<Box class="w-3.5 h-3.5 text-muted-foreground shrink-0" />{:else}<Layers class="w-3.5 h-3.5 text-muted-foreground shrink-0" />{/if}
									<span class="font-medium truncate">{item.name}</span>
									<Badge variant="outline" class="text-xs ml-auto shrink-0">{item.type === 'stack' ? m.stacks_item_stack() : m.containers_item_container()}</Badge>
									{#if item.volumes.length > 0}
										<span class="text-xs text-muted-foreground shrink-0">{m.backups_create_volume_count_short({ count: item.volumes.length })}</span>
									{/if}
								</button>
							{/each}
						</div>
					{:else if selectedEnvId}
						<p class="text-xs text-muted-foreground py-4 text-center">{m.backups_create_no_sources()}</p>
					{:else}
						<p class="text-xs text-muted-foreground py-4 text-center">{m.backups_create_select_environment_hint()}</p>
					{/if}
				</div>

			{:else if step === 2}
				<!-- Step 2: Configure -->
				<div class="space-y-4">
					<div class="space-y-1">
						<Label class="text-xs">{m.backups_create_repository()}</Label>
						<DestinationPicker
							destinations={destinations}
							bind:value={selectedDestId}
							env={selectedEnv}
						/>
					</div>

					<div class="flex items-center gap-3">
						<TogglePill bind:checked={stopBeforeBackup} />
						<div>
							<Label class="text-xs">{selectedItem?.type === 'stack' ? m.containers_backup_stop_stack_during() : m.containers_backup_stop_container_during()}</Label>
							<p class="text-xs text-muted-foreground">{m.backups_create_stop_hint()}</p>
						</div>
					</div>

					{#if selectedItem?.type === 'stack'}
						<StackFilesPicker
							listing={stackListing}
							loading={loadingStackListing}
							connectionType={selectedEnv?.connectionType}
							envName={selectedEnv?.name}
							envIcon={selectedEnv?.icon}
							envId={selectedEnv?.id}
							configuredStackPath={stackRemoteDir}
							bind:excludedStackFiles
						/>
					{/if}

					{#if selectedItem}
						<VolumePicker
							volumes={selectedItem.volumes}
							bind:allVolumes
							bind:selectedVolumes
							emptyLabel={selectedItem.type === 'stack' ? m.containers_backup_no_volumes_stack() : m.containers_backup_no_volumes_container()}
							showBindWarning={true}
							fileKeys={fileBindKeys(selectedItem.volumes, stackListing?.kind === 'listed' ? stackListing : null)}
						/>
					{/if}

					<div class="flex justify-end pt-2">
						<Button size="sm" onclick={() => step = 3} disabled={!selectedDestId}>
							{m.backups_create_next()} <ArrowBigRight class="w-3.5 h-3.5 ml-1" />
						</Button>
					</div>
				</div>

			{:else if step === 3}
				<!-- Step 3: Schedule & Run -->
				<div class="flex flex-col gap-4 h-full">
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground pb-2 border-b">
						{#if allVolumes}
							<span>{m.backups_create_all_volumes()}</span>
						{:else}
							<span>{m.backups_create_volumes_count({ count: selectedVolumes.length })}</span>
						{/if}
						{#if stopBeforeBackup}
							<span class="text-muted-foreground">·</span>
							<span>{m.backups_create_summary_stop()}</span>
						{/if}
					</div>

					<div class="flex items-center gap-2">
						<Checkbox checked={saveSchedule} onCheckedChange={() => { saveSchedule = !saveSchedule; }} />
						<span class="text-xs">{m.backups_create_save_recurring()}</span>
					</div>

					{#if saveSchedule}
						<div class="pl-6">
							<CronEditor bind:value={schedule} bind:invalid={scheduleInvalid} />
						</div>
					{:else}
						<p class="pl-6 text-[11px] text-muted-foreground">
							{m.backups_create_run_once_hint()}
						</p>
					{/if}

					<div class="flex items-center gap-2 pt-2">
						<Button variant="outline" size="sm" onclick={() => step = 2} disabled={saving}>{m.backups_create_back()}</Button>
						<div class="flex-1"></div>
						{#if saveSchedule}
							<Button variant="outline" size="sm" onclick={() => saveAndMaybeRun(false)} disabled={saving || scheduleInvalid || stackHelperFailed}>
								{#if saving}<Loader2 class="w-3.5 h-3.5 mr-1.5 animate-spin" />{:else}<CheckCircle2 class="w-3.5 h-3.5 mr-1.5" />{/if}
								{m.backups_create_save_schedule_only()}
							</Button>
						{/if}
						<Button size="sm" onclick={() => saveAndMaybeRun(true)} disabled={saving || (saveSchedule && scheduleInvalid) || stackHelperFailed}>
							{#if saving}<Loader2 class="w-3.5 h-3.5 mr-1.5 animate-spin" />{:else}<Play class="w-3.5 h-3.5 mr-1.5" />{/if}
							{saveSchedule ? m.backups_create_run_and_save() : m.backups_run_backup_now()}
						</Button>
					</div>
				</div>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
