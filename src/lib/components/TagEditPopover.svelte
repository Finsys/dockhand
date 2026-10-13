<script lang="ts">
	import { tick } from 'svelte';
	import * as Popover from '$lib/components/ui/popover';
	import { Input } from '$lib/components/ui/input';
	import { Check, Tag as TagIcon } from 'lucide-svelte';
	import TagLucideIcon from '$lib/components/TagLucideIcon.svelte';
	import { iconMap } from '$lib/utils/icons';
	import { TAG_COLORS, tagHex, normalizeTag, type Tag, type TagColor } from '$lib/utils/tags-core';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open?: boolean;
		catalog: Tag[];        // all tags in the env
		selected: number[];    // currently-assigned tag ids
		/** Tag ids this item shows because its STACK carries them. Listed but not
		 *  toggleable: they belong to the stack, not to this item. */
		inherited?: number[];
		/** Create a catalog tag; resolves to the created/existing Tag. */
		onCreate: (name: string, color: TagColor, icon: string | null) => Promise<Tag | null>;
		/** Persist the new assignment set. */
		onApply: (tagIds: number[]) => void;
		/** Whether the current user may create catalog tags (admin only). Assigning existing tags is always allowed. */
		allowCreate?: boolean;
	}
	let { open = $bindable(false), catalog, selected, inherited = [], onCreate, onApply, allowCreate = false }: Props = $props();

	// The heavy Popover.Root (bits-ui floating-ui context + portal) is only mounted once
	// the user actually opens this row's editor. Before that each row renders a plain
	// button, so toggling "inline tag editing" across a big grid mounts N cheap buttons
	// instead of N popovers - the difference between instant and multi-second. Once
	// mounted the Root stays (only this row's, not all N), so re-opens are normal.
	let activated = $state(open);
	// Mount the Root first, THEN open on the next microtask: bits-ui positions the content
	// against a trigger that is already in the DOM, so opening after mount is reliable.
	async function activate() {
		activated = true;
		await tick();
		open = true;
	}
	// A parent that drives `open` (rare) still forces the Root to mount.
	$effect(() => { if (open) activated = true; });

	let query = $state('');
	let newColor = $state<TagColor>('blue');
	let newIcon = $state<string | null>(null);
	let iconSearch = $state('');
	let creating = $state(false);

	// Gated on activated so an un-opened row (the common case on a big grid) does no work.
	const allIconNames = $derived(activated ? Object.keys(iconMap) : []);
	const iconResults = $derived(
		iconSearch.trim()
			? allIconNames.filter((n) => n.toLowerCase().includes(iconSearch.trim().toLowerCase()))
			: allIconNames
	);

	const filtered = $derived(
		query.trim()
			? catalog.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()))
			: catalog
	);
	const canCreate = $derived.by(() => {
		if (!allowCreate) return false;
		const n = normalizeTag(query);
		return !!n && !catalog.some((t) => t.name.toLowerCase() === n.toLowerCase());
	});

	function toggle(id: number) {
		onApply(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
	}

	async function create() {
		const name = normalizeTag(query);
		if (!name || creating) return;
		creating = true;
		try {
			const tag = await onCreate(name, newColor, newIcon);
			if (tag) {
				query = '';
				newColor = 'blue';
				newIcon = null;
				iconSearch = '';
				if (!selected.includes(tag.id)) onApply([...selected, tag.id]);
			}
		} finally {
			creating = false;
		}
	}
</script>

{#if !activated}
	<!-- Cheap placeholder: no Popover.Root until the user opens this row's editor. -->
	<button type="button" title={m.tags_edit()} onclick={activate}
		class="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground">
		<TagIcon class="h-3 w-3" />
	</button>
{:else}
<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button {...props} type="button" title={m.tags_edit()}
				class="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground">
				<TagIcon class="h-3 w-3" />
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-64 p-2" align="start">
		<Input bind:value={query} placeholder={allowCreate ? m.tags_search_or_create_placeholder() : m.tags_search_placeholder()} class="h-8 text-sm"
			onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' && canCreate) create(); }} />

		{#if canCreate}
			{@const hex = tagHex(newColor)}
			<div class="mt-2 rounded-md border p-2">
				<div class="text-2xs text-muted-foreground">{m.tags_create_new()}</div>
				<!-- Live preview of the pill. -->
				<div class="my-1.5">
					<span class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-2xs font-medium"
						style="color: {hex}; background-color: {hex}1a; border-color: {hex}33;">
						{#if newIcon}<TagLucideIcon name={newIcon} class="h-2.5 w-2.5 shrink-0" />{:else}<TagIcon class="h-2.5 w-2.5 shrink-0" />{/if}
						{normalizeTag(query)}
					</span>
				</div>
				<div class="grid grid-cols-8 gap-1">
					{#each TAG_COLORS as c}
						<button type="button" title={c} onclick={() => (newColor = c)}
							class="h-3.5 w-3.5 rounded-full ring-offset-1 ring-offset-background {newColor === c ? 'ring-2 ring-foreground' : ''}"
							style="background-color: {tagHex(c)};"></button>
					{/each}
				</div>
				<!-- Icon picker: default tag icon, or a lucide icon. -->
				<div class="mt-2">
					<Input bind:value={iconSearch} placeholder={m.tags_icon_placeholder()} class="h-7 text-2xs" />
					<div class="mt-1 grid grid-cols-8 gap-0.5 max-h-24 overflow-y-auto p-0.5">
						<button type="button" title={m.tags_default_icon()} onclick={() => (newIcon = null)}
							class="flex aspect-square items-center justify-center rounded hover:bg-muted {newIcon === null ? 'bg-primary/15 ring-1 ring-inset ring-primary' : ''}">
							<TagIcon class="h-3.5 w-3.5" style="color: {hex};" />
						</button>
						{#each iconResults as ic (ic)}
							<button type="button" title={ic} onclick={() => (newIcon = ic)}
								class="flex aspect-square items-center justify-center rounded hover:bg-muted {newIcon === ic ? 'bg-primary/15 ring-1 ring-inset ring-primary' : ''}">
								<TagLucideIcon name={ic} class="h-3.5 w-3.5" style="color: {hex};" />
							</button>
						{/each}
					</div>
				</div>
				<button type="button" onclick={create} disabled={creating}
					class="mt-2 w-full rounded bg-primary px-2 py-1 text-2xs font-medium text-primary-foreground disabled:opacity-50">{m.tags_create()}</button>
			</div>
		{/if}

		<div class="mt-2 max-h-56 overflow-y-auto">
			{#if filtered.length === 0 && !canCreate}
				<div class="px-2 py-3 text-center text-xs text-muted-foreground">{m.tags_none()}</div>
			{/if}
			{#each filtered as tag (tag.id)}
				{@const isSel = selected.includes(tag.id)}
				{@const fromStack = !isSel && inherited.includes(tag.id)}
				<button type="button" onclick={() => !fromStack && toggle(tag.id)}
					disabled={fromStack}
					title={fromStack ? m.tags_inherited_from_stack_title() : undefined}
					class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm {fromStack ? 'cursor-default opacity-60' : 'hover:bg-muted'}">
					{#if tag.icon}
						<TagLucideIcon name={tag.icon} class="h-3.5 w-3.5 shrink-0" style="color: {tagHex(tag.color)};" />
					{:else}
						<span class="h-2 w-2 shrink-0 rounded-full" style="background-color: {tagHex(tag.color)};"></span>
					{/if}
					<span class="truncate">{tag.name}</span>
					{#if isSel}
						<Check class="ml-auto h-3.5 w-3.5 text-primary shrink-0" />
					{:else if fromStack}
						<span class="ml-auto text-2xs text-muted-foreground shrink-0">{m.tags_from_stack()}</span>
					{/if}
				</button>
			{/each}
		</div>
	</Popover.Content>
</Popover.Root>
{/if}
