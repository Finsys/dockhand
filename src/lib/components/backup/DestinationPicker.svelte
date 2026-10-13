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
	import { getRepoTypeIcon, localRepoNeedsSameHost } from '$lib/utils/backup';
	import { m } from '$lib/paraglide/messages.js';

	interface Destination {
		id: number;
		name: string;
		repository: string;
		hostPath?: string | null;
	}

	interface Props {
		destinations: Destination[];
		/** Bound to the selected destination id. 0 = nothing selected. */
		value: number;
		/** The target environment. A local-path destination is disabled for a
		 *  remote env unless it declares a hostPath. Omit for a local/socket env. */
		env?: { connectionType?: string | null; host?: string | null } | null;
		/** CSS class for the trigger. Defaults to full width. */
		triggerClass?: string;
		placeholder?: string;
	}

	let {
		destinations,
		value = $bindable(),
		env,
		triggerClass = 'h-9 w-full',
		placeholder = m.backupui_select_repository()
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
			{@const localOnRemote = localRepoNeedsSameHost(dest, env)}
			<Select.Item value={String(dest.id)}>
				<span class="flex items-center gap-2">
					<DIcon class="w-4 h-4 text-muted-foreground" />
					{dest.name}
					{#if localOnRemote}
						<span class="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400" title={m.backupui_needs_same_host_title()}>{m.backupui_needs_same_host()}</span>
					{/if}
				</span>
			</Select.Item>
		{/each}
	</Select.Content>
</Select.Root>
