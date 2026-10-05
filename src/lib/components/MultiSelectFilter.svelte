<script lang="ts">
	import * as Select from '$lib/components/ui/select';
	import type { Component } from 'svelte';

	interface FilterOption {
		value: string;
		label: string;
		icon?: Component;
		color?: string;
		/** Colour the label too, not just the icon - for an entry that needs to stand out. */
		colorLabel?: boolean;
	}

	interface Props {
		value: string[];
		options: FilterOption[];
		placeholder: string;
		pluralLabel?: string;
		width?: string;
		defaultIcon?: Component;
	}

	let {
		value = $bindable([]),
		options,
		placeholder,
		pluralLabel,
		width = 'w-36',
		defaultIcon
	}: Props = $props();

	// Control dropdown open state
	let open = $state(false);

	// Check if any options have icons
	const hasIcons = $derived(options.some(o => o.icon));

	// Get the icon for single selection
	const singleOption = $derived(() => {
		if (value.length === 1) {
			return options.find(o => o.value === value[0]);
		}
		return null;
	});

	const displayLabel = $derived(() => {
		if (value.length === 0) {
			return placeholder;
		} else if (value.length === 1) {
			const opt = options.find(o => o.value === value[0]);
			return opt?.label || value[0];
		} else {
			return `${value.length} ${pluralLabel || placeholder.toLowerCase()}`;
		}
	});

	function clearAndClose() {
		value = [];
		open = false;
	}
</script>

<Select.Root type="multiple" bind:value bind:open>
	<Select.Trigger size="sm" class="{width} max-w-full text-sm overflow-hidden">
		{#if hasIcons || defaultIcon}
			{@const opt = singleOption()}
			{@const IconComponent = opt?.icon || defaultIcon}
			{#if IconComponent}
				<svelte:component this={IconComponent} class="w-3.5 h-3.5 mr-1.5 {opt?.color || 'text-muted-foreground'} shrink-0" />
			{/if}
		{/if}
		<span class="truncate {value.length === 0 ? 'text-muted-foreground' : ''}" title={value.length === 1 ? displayLabel() : ''}>
			{displayLabel()}
		</span>
	</Select.Trigger>
	<Select.Content align="start">
		{#if value.length > 0}
			<button
				type="button"
				class="w-full px-2 py-1 text-xs text-left text-muted-foreground/60 hover:text-muted-foreground"
				onclick={clearAndClose}
			>
				Clear
			</button>
		{/if}
		{#each options as option}
			<Select.Item value={option.value}>
				{#if option.icon}
					<svelte:component this={option.icon} class="w-4 h-4 mr-2 {option.color || ''}" />
				{:else if option.color}
					<span class="w-2 h-2 mr-2 rounded-full shrink-0 {option.color.replace('text-', 'bg-')}"></span>
				{/if}
				<span class={option.color && (!option.icon || option.colorLabel) ? option.color : ''}>{option.label}</span>
			</Select.Item>
		{/each}
	</Select.Content>
</Select.Root>
