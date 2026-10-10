<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Input } from '$lib/components/ui/input';
	import { Tag as TagIcon } from 'lucide-svelte';
	import TagLucideIcon from '$lib/components/TagLucideIcon.svelte';
	import { iconMap } from '$lib/utils/icons';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		/** Currently-selected lucide icon name, or null for the default tag icon. */
		icon: string | null;
		/** Hex colour the icons/trigger render in. */
		hex: string;
		/** Trigger button size classes (default: 36px square, matching the colour swatch). */
		triggerClass?: string;
		onSelect: (icon: string | null) => void;
	}
	let { icon, hex, triggerClass = 'h-9 w-9', onSelect }: Props = $props();

	let open = $state(false);
	let search = $state('');
	const allIconNames = Object.keys(iconMap);
	const results = $derived(
		search.trim()
			? allIconNames.filter((n) => n.toLowerCase().includes(search.trim().toLowerCase()))
			: allIconNames
	);

	function pick(name: string | null) {
		onSelect(name);
		open = false;
		search = '';
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button {...props} type="button" title={m.iconpicker_pick_icon()}
				class="{triggerClass} shrink-0 rounded-md border flex items-center justify-center text-muted-foreground hover:text-foreground">
				{#if icon}
					<TagLucideIcon name={icon} class="h-4 w-4" style="color: {hex};" />
				{:else}
					<TagIcon class="h-4 w-4" style="color: {hex};" />
				{/if}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-56 p-2" align="start">
		<Input bind:value={search} placeholder={m.stacks_icon_search_icons()} class="h-7 text-2xs" />
		<div class="mt-1 grid grid-cols-8 gap-0.5 max-h-40 overflow-y-auto p-0.5">
			<button type="button" title={m.tags_default_icon()} onclick={() => pick(null)}
				class="flex aspect-square items-center justify-center rounded hover:bg-muted {icon === null ? 'bg-primary/15 ring-1 ring-inset ring-primary' : ''}">
				<TagIcon class="h-3.5 w-3.5" style="color: {hex};" />
			</button>
			{#each results as ic (ic)}
				<button type="button" title={ic} onclick={() => pick(ic)}
					class="flex aspect-square items-center justify-center rounded hover:bg-muted {icon === ic ? 'bg-primary/15 ring-1 ring-inset ring-primary' : ''}">
					<TagLucideIcon name={ic} class="h-3.5 w-3.5" style="color: {hex};" />
				</button>
			{/each}
		</div>
	</Popover.Content>
</Popover.Root>
