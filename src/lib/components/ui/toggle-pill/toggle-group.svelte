<script lang="ts">
	/**
	 * ToggleGroup - A pill-style toggle for switching between multiple values (2+).
	 * Extends ToggleSwitch to support any number of options.
	 * Perfect for settings like scanner selection: "None / Trivy / Grype / Both"
	 *
	 * Keyboard navigation:
	 * - Tab: Focus the selected option (or first if none selected)
	 * - Arrow Left/Right: Navigate between options
	 * - Space/Enter: Select the focused option
	 */
	import type { IconComponent } from '$lib/types';

	interface Option {
		value: string;
		label?: string;
		icon?: IconComponent;
	}

	interface Props {
		value: string;
		options: Option[];
		disabled?: boolean;
		onchange?: (value: string) => void;
	}

	let {
		value = $bindable(),
		options,
		disabled = false,
		onchange
	}: Props = $props();

	let buttons = $state<HTMLButtonElement[]>([]);

	function select(optionValue: string) {
		if (disabled || value === optionValue) return;
		value = optionValue;
		onchange?.(value);
	}

	function handleKeydown(e: KeyboardEvent, index: number) {
		if (disabled) return;

		let nextIndex = index;

		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			e.preventDefault();
			nextIndex = (index + 1) % options.length;
		} else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			e.preventDefault();
			nextIndex = (index - 1 + options.length) % options.length;
		} else if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault();
			select(options[index].value);
			return;
		} else {
			return;
		}

		// Move focus and select the new option
		buttons[nextIndex]?.focus();
		select(options[nextIndex].value);
	}
</script>

<div
	class="inline-flex items-center rounded-md bg-muted p-0.5 text-xs font-medium {disabled ? 'opacity-50 cursor-not-allowed' : ''}"
	role="radiogroup"
>
	{#each options as option, i}
		{@const isSelected = value === option.value}
		{@const displayLabel = option.label ?? option.value}
		<button
			bind:this={buttons[i]}
			type="button"
			role="radio"
			aria-checked={isSelected}
			tabindex={isSelected ? 0 : -1}
			class="px-2 py-1 rounded transition-colors flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 {isSelected
				? 'bg-slate-300 text-slate-900 shadow-sm dark:bg-amber-900/50 dark:text-amber-100'
				: 'text-muted-foreground hover:text-foreground'} {disabled ? 'cursor-not-allowed' : ''}"
			onclick={() => select(option.value)}
			onkeydown={(e) => handleKeydown(e, i)}
			{disabled}
		>
			{#if option.icon}
				<svelte:component this={option.icon} class="w-3 h-3" />
			{/if}
			{displayLabel}
		</button>
	{/each}
</div>
