<script lang="ts">
	import { Search, X } from 'lucide-svelte';
	import { Input } from '$lib/components/ui/input';
	import { cn } from '$lib/utils.js';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { m } from '$lib/paraglide/messages.js';

	// A search field with a leading magnifier and a trailing clear (X) button that shows
	// once there is text. Escape also clears. Drop-in for the hand-rolled
	// `<div class="relative"><Search/><Input/></div>` pattern repeated across the pages.
	type Props = Omit<HTMLInputAttributes, 'type' | 'value' | 'files'> & {
		value?: string;
		/** Extra classes for the <Input> (width/height/etc.), e.g. "h-8 w-64 text-sm". */
		class?: string;
		/** Extra classes for the wrapping div. */
		containerClass?: string;
	};

	let {
		value = $bindable(''),
		class: className,
		containerClass,
		placeholder = undefined,
		onkeydown,
		...rest
	}: Props = $props();
</script>

<div class={cn('relative', containerClass)}>
	<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
	<Input
		type="text"
		placeholder={placeholder ?? m.layout_search()}
		bind:value
		onkeydown={(e) => {
			if (e.key === 'Escape' && value) {
				e.preventDefault();
				value = '';
			}
			onkeydown?.(e);
		}}
		class={cn('pl-8', value ? 'pr-8' : '', className)}
		{...rest}
	/>
	{#if value}
		<button
			type="button"
			tabindex={-1}
			aria-label={m.ui_clear_search()}
			onclick={() => (value = '')}
			class="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			<X class="w-3.5 h-3.5" />
		</button>
	{/if}
</div>
