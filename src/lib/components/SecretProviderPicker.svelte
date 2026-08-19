<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { getProviderIcon } from '$lib/components/provider-icons';
	import { BULK_SELECTOR_FIELDS } from '../../routes/settings/secrets/ProviderModal.svelte';
	import { SELECTOR_VARS, BULK_SELECTOR_VAR } from '$lib/utils/bulk-selector';
	import type { EnvVar } from '$lib/components/StackEnvVarsEditor.svelte';

	type ProviderOption = { id: number; name: string; type: string };

	interface Props {
		secretProviderId: number | null;
		/** ALL env vars - the bulk-selector field is a live view of the
		 *  DOCKHAND_SECRET_SELECTOR row within this list. */
		envVars: EnvVar[];
		providers: ProviderOption[];
		/** Suffix for element ids so two pickers on one page don't collide. */
		idSuffix?: string;
		onchange?: () => void;
	}

	let {
		secretProviderId = $bindable(null),
		envVars = $bindable([]),
		providers,
		idSuffix = '',
		onchange
	}: Props = $props();

	const selectedType = $derived(providers.find((p) => p.id === secretProviderId)?.type ?? null);
	const bulkSelectorField = $derived(selectedType ? BULK_SELECTOR_FIELDS[selectedType] ?? null : null);

	// Live view of the DOCKHAND_SECRET_SELECTOR (or legacy OP_ENVIRONMENT_ID) row.
	const bulkSelectorValue = $derived.by(() => {
		for (const name of SELECTOR_VARS) {
			const hit = envVars.find((v) => v.key.trim() === name);
			if (hit) return hit.value;
		}
		return '';
	});
	function writeSelector(value: string) {
		const others = envVars.filter((v) => !SELECTOR_VARS.includes(v.key.trim()));
		envVars = value.trim()
			? [...others, { key: BULK_SELECTOR_VAR, value, isSecret: false }]
			: others;
		onchange?.();
	}
</script>

{#if providers.length > 0 || secretProviderId !== null}
	<div class="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-100/60 dark:bg-zinc-800/60 flex flex-col gap-1.5 text-xs">
		<div class="flex items-center gap-2">
			<Label for="secret-provider-select{idSuffix}" class="text-xs text-muted-foreground shrink-0">Secret provider</Label>
			<Select.Root
				type="single"
				value={secretProviderId !== null ? String(secretProviderId) : ''}
				onValueChange={(v) => { secretProviderId = v ? parseInt(v) : null; onchange?.(); }}
			>
				<Select.Trigger id="secret-provider-select{idSuffix}" class="h-7 text-xs flex-1 min-w-0 max-w-xs overflow-hidden">
					{#if secretProviderId !== null}
						{@const sel = providers.find((p) => p.id === secretProviderId)}
						{@const SelIcon = sel ? getProviderIcon(sel.type) : null}
						<span class="flex items-center gap-2 min-w-0">
							{#if SelIcon}<SelIcon class="h-4 w-4 shrink-0 text-muted-foreground" />{/if}
							<span class="truncate min-w-0">{sel?.name ?? 'Unknown provider'}</span>
						</span>
					{:else}
						<span class="text-muted-foreground truncate">None — disabled</span>
					{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="" label="None">
						<span class="text-muted-foreground">None — disabled</span>
					</Select.Item>
					{#each providers as provider (provider.id)}
						{@const ProviderIcon = getProviderIcon(provider.type)}
						<Select.Item value={String(provider.id)} label={provider.name}>
							<span class="flex items-center gap-2 min-w-0">
								{#if ProviderIcon}<ProviderIcon class="h-4 w-4 shrink-0 text-muted-foreground" />{/if}
								<span class="truncate">{provider.name}</span>
							</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			{#if bulkSelectorField}
				<Label for="bulk-selector-input{idSuffix}" class="text-xs text-muted-foreground shrink-0 ml-1">
					{bulkSelectorField.label}
				</Label>
				<Input
					id="bulk-selector-input{idSuffix}"
					class="h-7 text-xs font-mono flex-1 min-w-0 max-w-xs"
					placeholder={bulkSelectorField.placeholder ?? ''}
					value={bulkSelectorValue}
					oninput={(e) => writeSelector(e.currentTarget.value)}
				/>
			{/if}
		</div>
		{#if bulkSelectorField?.hint}
			<p class="text-2xs text-muted-foreground/70 pl-0.5">{bulkSelectorField.hint}</p>
		{/if}
	</div>
{/if}
