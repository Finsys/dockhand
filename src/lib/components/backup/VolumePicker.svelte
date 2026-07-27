<script lang="ts">
	/**
	 * Shared "all volumes / pick a subset" UI used by BackupPanel and
	 * CreateBackupModal. Both surfaces previously open-coded this — they
	 * drifted slightly (different toggle labels, different icon for bind
	 * mounts) and one of them silently omitted the bind-mount warning.
	 *
	 * mountType is optional per volume: when present, bind mounts get an
	 * amber warning callout and a per-row Folder icon; when absent, all
	 * rows render as named volumes with the neutral icon.
	 */
	import { Label } from '$lib/components/ui/label';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { AlertTriangle } from 'lucide-svelte';
	import MountTypeBadge from '$lib/components/MountTypeBadge.svelte';

	interface VolumeInfo {
		name: string;
		mountPoint: string;
		mountType?: 'volume' | 'bind';
		source?: string;
	}

	interface Props {
		volumes: VolumeInfo[];
		allVolumes: boolean;
		selectedVolumes: string[];
		/** Empty-state label, e.g. "No volumes detected on this container". */
		emptyLabel?: string;
		/** When true, surface the bind-mount-portability warning when binds are present. */
		showBindWarning?: boolean;
	}

	let {
		volumes,
		allVolumes = $bindable(),
		selectedVolumes = $bindable(),
		emptyLabel = 'No volumes detected',
		showBindWarning = true
	}: Props = $props();

	const bindMounts = $derived(volumes.filter((v) => v.mountType === 'bind'));

	function toggleVolume(name: string) {
		if (selectedVolumes.includes(name)) {
			selectedVolumes = selectedVolumes.filter((v) => v !== name);
		} else {
			selectedVolumes = [...selectedVolumes, name];
		}
	}
</script>

{#if volumes.length > 0}
	<!-- One bordered section: the "all volumes" toggle heads the list it controls,
	     so the switch clearly belongs to the volumes below it. -->
	<div class="border rounded-md overflow-hidden">
		<div class="flex items-center justify-between gap-4 px-3 py-2 bg-muted/30 border-b">
			<Label class="text-xs">Backup all volumes ({volumes.length})</Label>
			<TogglePill bind:checked={allVolumes} onLabel="Yes" offLabel="No" />
		</div>

		{#if showBindWarning && bindMounts.length > 0}
			<div class="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/5 p-2 text-xs">
				<AlertTriangle class="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
				<div class="space-y-1">
					<p class="font-medium text-amber-600 dark:text-amber-400">{bindMounts.length} bind mount{bindMounts.length !== 1 ? 's' : ''} detected</p>
					<p class="text-muted-foreground">Contents are captured in the snapshot, but bind sources are host paths. Restoring to a different environment requires those exact paths on the target host — otherwise services start with empty mounts.</p>
				</div>
			</div>
		{/if}

		<!-- List always shown: informational when "all" is on, selectable when off. -->
		<div class="divide-y max-h-40 overflow-y-auto">
			{#each volumes as vol}
				<label class="flex items-center gap-2 px-3 py-1.5 text-xs" class:cursor-pointer={!allVolumes}>
					<Checkbox
						checked={allVolumes || selectedVolumes.includes(vol.name)}
						disabled={allVolumes}
						onCheckedChange={() => toggleVolume(vol.name)}
						class="h-3.5 w-3.5"
					/>
					<MountTypeBadge type={vol.mountType} size="sm" />
						<span class="font-mono truncate">{vol.name}</span>
						{#if vol.source && vol.source !== vol.name}
							<span class="text-muted-foreground font-mono truncate">from {vol.source}</span>
						{/if}
						{#if vol.mountPoint}
							<span class="text-muted-foreground ml-auto truncate">{vol.mountPoint}</span>
						{/if}
					</label>
				{/each}
			</div>
	</div>
{:else}
	<p class="text-xs text-muted-foreground">{emptyLabel}</p>
{/if}
