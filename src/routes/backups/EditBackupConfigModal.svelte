<script lang="ts">
	/**
	 * Edit a backup config from the Backups page by reusing the container/stack
	 * Backups tab (BackupPanel) in a modal. BackupPanel needs the target's volume
	 * list, which this page fetches like CreateBackupModal does.
	 */
	import * as Dialog from '$lib/components/ui/dialog';
	import { Loader2, Archive } from 'lucide-svelte';
	import BackupPanel from '../containers/BackupPanel.svelte';
	import { normalizeMounts, volumesForStack, type VolumeInfo } from '$lib/utils/mounts';

	interface EditTarget {
		id: number;
		type: 'container' | 'stack';
		targetName: string;
		environmentId: number | null;
	}

	let { open = $bindable(), config, onSaved }: {
		open: boolean;
		config: EditTarget | null;
		onSaved?: () => void;
	} = $props();

	let volumes = $state<VolumeInfo[]>([]);
	let loading = $state(false);
	let loadedFor = $state<number | null>(null); // config.id we loaded volumes for

	async function loadVolumes(cfg: EditTarget) {
		loading = true;
		volumes = [];
		try {
			const envId = cfg.environmentId;
			const contRes = await fetch(`/api/containers?env=${envId}`);
			const contData = await contRes.json();
			if (cfg.type === 'stack') {
				volumes = Array.isArray(contData) ? volumesForStack(contData, cfg.targetName) : [];
			} else {
				const c = Array.isArray(contData)
					? contData.find((x: any) => (x.name || x.Names?.[0]?.replace(/^\//, '')) === cfg.targetName)
					: null;
				volumes = c ? normalizeMounts(c.mounts || c.Mounts) : [];
			}
		} catch {
			volumes = [];
		}
		loadedFor = cfg.id;
		loading = false;
	}

	// Fetch volumes once per opened config.
	$effect(() => {
		if (open && config && loadedFor !== config.id) {
			loadVolumes(config);
		}
		if (!open) loadedFor = null;
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-3xl h-[70vh] flex flex-col">
		<Dialog.Header class="pb-0">
			<Dialog.Title class="flex items-center gap-2 text-base">
				<Archive class="w-4 h-4" />
				Edit backup — {config?.targetName ?? ''}
			</Dialog.Title>
		</Dialog.Header>

		<div class="flex-1 min-h-0 overflow-y-auto">
			{#if config}
				{#if loading}
					<div class="flex items-center gap-2 p-4 text-sm text-muted-foreground">
						<Loader2 class="w-4 h-4 animate-spin" /> Loading volumes…
					</div>
				{:else}
					<BackupPanel
						containerName={config.targetName}
						type={config.type}
						environmentId={config.environmentId ?? undefined}
						{volumes}
						onConfigSaved={() => onSaved?.()}
					/>
				{/if}
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
