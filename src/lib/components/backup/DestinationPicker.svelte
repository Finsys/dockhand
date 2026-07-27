<script lang="ts">
	/**
	 * Shared backup-destination picker. Both BackupPanel and CreateBackupModal
	 * rendered the same Select.Root with the same icon-resolution logic; one
	 * also disabled local-path destinations when the target environment is
	 * remote (because the helper container on the remote host can't see
	 * Dockhand's local filesystem), the other didn't, which let users pick
	 * a doomed combination that the backend would reject later.
	 *
	 * This component centralizes the rendering and (optionally) the
	 * local-on-remote disabling.
	 */
	import * as Select from '$lib/components/ui/select';
	import { getRepoTypeIcon, isLocalRepo } from '$lib/utils/backup';

	interface Destination {
		id: number;
		name: string;
		repository: string;
	}

	interface Props {
		destinations: Destination[];
		/** Bound to the selected destination id. 0 = nothing selected. */
		value: number;
		/** Set to true on a remote environment to disable local-path destinations. */
		disableLocalForRemoteEnv?: boolean;
		/** CSS class for the trigger. Defaults to full width. */
		triggerClass?: string;
		placeholder?: string;
	}

	let {
		destinations,
		value = $bindable(),
		disableLocalForRemoteEnv = false,
		triggerClass = 'h-9 w-full',
		placeholder = 'Select repository...'
	}: Props = $props();

	const selected = $derived(destinations.find((d) => d.id === value));
</script>

<Select.Root
	type="single"
	value={value ? String(value) : undefined}
	onValueChange={(v) => { value = Number(v); }}
>
	<Select.Trigger class={triggerClass}>
		{#if selected}
			{@const SelIcon = getRepoTypeIcon(selected.repository)}
			<span class="flex items-center gap-2 truncate">
				<SelIcon class="w-4 h-4 text-primary/70 shrink-0" />
				{selected.name}
			</span>
		{:else}
			<span class="text-muted-foreground text-xs">{placeholder}</span>
		{/if}
	</Select.Trigger>
	<Select.Content>
		{#each destinations as dest}
			{@const DIcon = getRepoTypeIcon(dest.repository)}
			{@const localOnRemote = disableLocalForRemoteEnv && isLocalRepo(dest.repository)}
			{#if localOnRemote}
				<Select.Item value={String(dest.id)} disabled>
					<span class="flex items-center gap-2 opacity-50">
						<DIcon class="w-4 h-4 text-muted-foreground" />
						{dest.name}
						<span class="text-xs text-muted-foreground">— local</span>
					</span>
				</Select.Item>
			{:else}
				<Select.Item value={String(dest.id)}>
					<span class="flex items-center gap-2">
						<DIcon class="w-4 h-4 text-muted-foreground" />
						{dest.name}
					</span>
				</Select.Item>
			{/if}
		{/each}
	</Select.Content>
</Select.Root>
