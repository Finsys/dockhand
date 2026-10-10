<script lang="ts">
	import { Tag as TagIcon, X } from 'lucide-svelte';
	import TagLucideIcon from '$lib/components/TagLucideIcon.svelte';
	import { tagHex } from '$lib/utils/tags-core';
	import type { Tag } from '$lib/utils/tags-core';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		tags: Tag[];
		class?: string;
		/** When set, each chip shows an X to unassign the tag. */
		onRemove?: (tag: Tag) => void;
	}
	let { tags, class: className = '', onRemove }: Props = $props();
</script>

{#if tags.length}
	<div class="flex flex-wrap items-center gap-1 {className}">
		{#each tags as tag (tag.id)}
			{@const hex = tagHex(tag.color)}
			<span class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-xs font-normal"
				style="color: {hex}; background-color: {hex}1a; border-color: {hex}33;">
				{#if tag.icon}
					<TagLucideIcon name={tag.icon} class="h-3 w-3 shrink-0" />
				{:else}
					<TagIcon class="h-3 w-3 shrink-0" />
				{/if}
				{tag.name}
				{#if onRemove}
					<button type="button" title={m.tags_remove()} class="-mr-0.5 ml-0.5 rounded-full hover:bg-current/20"
						onclick={(e) => { e.stopPropagation(); onRemove?.(tag); }}>
						<X class="h-2.5 w-2.5" />
					</button>
				{/if}
			</span>
		{/each}
	</div>
{/if}
