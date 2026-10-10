<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import { Tag as TagIcon, Check, ChevronDown, ChevronRight, Rows3, Paintbrush, Pencil, Settings2, GripVertical, RotateCcw, ArrowUpDown, Layers } from 'lucide-svelte';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import TagLucideIcon from '$lib/components/TagLucideIcon.svelte';
	import { tagHex } from '$lib/utils/tags-core';
	import { tagOrder } from '$lib/stores/tag-order';
	import { applyOrder } from '$lib/utils/apply-order';
	import { dndzone, type DndEvent } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { ToggleSwitch } from '$lib/components/ui/toggle-pill';
	import type { Tag, TagFilterMode } from '$lib/utils/tags-core';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		tags: Tag[];              // catalog to choose from
		selected: number[];       // selected tag ids (bindable)
		mode: TagFilterMode;      // 'all' | 'any' (bindable)
		groupBy?: boolean;        // 'group rows by tag' toggle (bindable); omit to hide it
		showTags?: boolean;       // 'show tag chips on rows' toggle (bindable); omit to hide it
		showBands?: boolean;      // 'coloured group bands' toggle (bindable); shown only while groupBy is on
		inlineEditing?: boolean;  // 'show a tag button on each row' toggle (bindable); omit to hide it
		inheritStackTags?: boolean; // 'show a container its stack's tags' toggle (bindable); omit to hide it
		settingsExpanded?: boolean; // collapsed state of the settings section (bindable)
		width?: string;
	}
	let { tags, selected = $bindable([]), mode = $bindable('all'), groupBy = $bindable(undefined), showTags = $bindable(undefined), showBands = $bindable(undefined), inlineEditing = $bindable(undefined), inheritStackTags = $bindable(undefined), settingsExpanded = $bindable(true), width = 'w-44' }: Props = $props();

	// Whether any of the settings toggles are present, so the section only renders when it has content.
	const hasSettings = $derived(groupBy !== undefined || showTags !== undefined || inlineEditing !== undefined || inheritStackTags !== undefined);

	let open = $state(false);

	// --- Reorder ---
	// dndzone owns the gesture; we own the order. The catalogue is shared, but the
	// arrangement is this user's, and it drives grid grouping as well as this list.
	let reorderMode = $state(false);
	let dragList = $state<Tag[] | null>(null);

	const orderedTags = $derived(dragList ?? applyOrder(tags, $tagOrder, (t) => t.id));

	function handleConsider(e: CustomEvent<DndEvent<Tag>>) {
		dragList = e.detail.items;
	}

	function handleFinalize(e: CustomEvent<DndEvent<Tag>>) {
		const items = e.detail.items;
		dragList = null;
		// A tag created or deleted mid-gesture would make this a partial list.
		if (items.length !== tags.length) return;
		tagOrder.save(items.map((t) => t.id));
	}

	// Leaving the popover ends reorder mode, so reopening does not swallow the
	// click meant to select a tag.
	$effect(() => {
		if (!open && reorderMode) {
			reorderMode = false;
			dragList = null;
		}
	});

	function toggle(id: number) {
		selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
	}
	const label = $derived(
		selected.length === 0 ? m.tags_filter_all() : selected.length === 1 ? (tags.find((t) => t.id === selected[0])?.name ?? m.tags_filter_count({ count: 1 })) : m.tags_filter_count({ count: selected.length })
	);
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" class="{width} justify-between font-normal">
				<span class="flex items-center gap-1.5 truncate">
					<TagIcon class="h-3.5 w-3.5 text-muted-foreground" />
					<span class="truncate {selected.length === 0 ? 'text-muted-foreground' : ''}">{label}</span>
				</span>
				<ChevronDown class="h-3.5 w-3.5 text-muted-foreground shrink-0" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-64 p-1" align="start">
		{#if hasSettings}
			<!-- Collapsible settings section, open by default. The header toggles it; the
			     state is persisted by the parent page (localStorage). -->
			<button
				type="button"
				class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-muted-foreground hover:bg-muted"
				onclick={() => (settingsExpanded = !settingsExpanded)}
			>
				<Settings2 class="h-3.5 w-3.5 shrink-0" />
				<span class="text-xs flex-1 text-left">{m.tags_settings()}</span>
				{#if settingsExpanded}
					<ChevronDown class="h-3.5 w-3.5 shrink-0" />
				{:else}
					<ChevronRight class="h-3.5 w-3.5 shrink-0" />
				{/if}
			</button>
			{#if settingsExpanded}
				{#if groupBy !== undefined}
					<div class="flex items-center gap-2 px-2 py-1.5">
						<Rows3 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span class="text-xs min-w-0 flex-1 truncate text-left">{m.tags_group_by_tag()}</span>
						<TogglePill bind:checked={groupBy} />
					</div>
					{#if showBands !== undefined && groupBy}
						<!-- Only meaningful while grouping is on. Same padding as the other rows so
						     the icon column lines up on the left and the toggle on the right. -->
						<div class="flex items-center gap-2 px-2 py-1.5">
							<Paintbrush class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							<span class="text-xs min-w-0 flex-1 truncate text-left">{m.tags_color_group_bands()}</span>
							<TogglePill bind:checked={showBands} />
						</div>
					{/if}
				{/if}
				{#if showTags !== undefined}
					<div class="flex items-center gap-2 px-2 py-1.5">
						<TagIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span class="text-xs min-w-0 flex-1 truncate text-left">{m.tags_show_tags()}</span>
						<TogglePill bind:checked={showTags} />
					</div>
				{/if}
				{#if inlineEditing !== undefined}
					<div class="flex items-center gap-2 px-2 py-1.5">
						<Pencil class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span class="text-xs min-w-0 flex-1 truncate text-left">{m.tags_inline_editing()}</span>
						<TogglePill bind:checked={inlineEditing} />
					</div>
				{/if}
				{#if inheritStackTags !== undefined}
					<div class="flex items-center gap-2 px-2 py-1.5">
						<Layers class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span class="text-xs min-w-0 flex-1 truncate text-left">{m.tags_show_stack_tags()}</span>
						<TogglePill bind:checked={inheritStackTags} />
					</div>
				{/if}
			{/if}
			<div class="my-1 h-px bg-border"></div>
		{/if}
		{#if tags.length === 0}
			<div class="px-2 py-3 text-center text-xs text-muted-foreground">{m.tags_none_yet()}</div>
		{:else}
			<!-- ANY / ALL match mode (same pill as the dashboard env label filter) -->
			<div class="flex items-center gap-2 px-1 pb-1">
				<span class="text-2xs text-muted-foreground mr-auto">{m.tags_match()}</span>
				<ToggleSwitch value={mode} leftValue="any" rightValue="all" leftLabel={m.tags_match_any()} rightLabel={m.tags_match_all()} onchange={(m) => (mode = m as TagFilterMode)} />
			</div>
			<div
				class="max-h-64 overflow-y-auto pr-1"
				use:dndzone={{
					items: orderedTags,
					dragDisabled: !reorderMode,
					flipDurationMs: 180,
					dropTargetStyle: {}
				}}
				onconsider={handleConsider}
				onfinalize={handleFinalize}
			>
				{#each orderedTags as tag (tag.id)}
					{@const isSel = selected.includes(tag.id)}
					<button
						type="button"
						animate:flip={{ duration: 180, easing: cubicOut }}
						class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted {reorderMode
							? 'cursor-grab active:cursor-grabbing'
							: ''}"
						onclick={() => { if (!reorderMode) toggle(tag.id); }}
					>
						{#if reorderMode}
							<GripVertical class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
						{/if}
						{#if tag.icon}
							<TagLucideIcon name={tag.icon} class="h-3.5 w-3.5 shrink-0" style="color: {tagHex(tag.color)};" />
						{:else}
							<TagIcon class="h-3.5 w-3.5 shrink-0" style="color: {tagHex(tag.color)};" />
						{/if}
						<span class="min-w-0 flex-1 truncate text-left" title={tag.name}>{tag.name}</span>
						{#if isSel}<Check class="ml-auto h-3.5 w-3.5 text-primary shrink-0" />{/if}
					</button>
				{/each}
			</div>
			{#if selected.length > 0 && !reorderMode}
				<button type="button" class="mt-1 w-full rounded px-2 py-1 text-2xs text-muted-foreground hover:bg-muted" onclick={() => (selected = [])}>
					{m.tags_clear()}
				</button>
			{/if}
			{#if tags.length > 1}
				<div class="mt-1 flex items-center gap-3 border-t px-2 pt-1.5 text-2xs leading-none">
					{#if reorderMode}
						<button
							type="button"
							class="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
							title={m.tags_reset_order_title()}
							onclick={() => {
								tagOrder.reset();
								dragList = null;
								reorderMode = false;
							}}
						>
							<RotateCcw class="h-3 w-3 shrink-0 text-red-400" />
							{m.tags_reset()}
						</button>
						<button
							type="button"
							class="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
							onclick={() => (reorderMode = false)}
						>
							<Check class="h-3 w-3 shrink-0 text-emerald-500" />
							{m.tags_apply()}
						</button>
					{:else}
						<button
							type="button"
							class="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
							title={m.tags_reorder_title()}
							onclick={() => (reorderMode = true)}
						>
							<ArrowUpDown class="h-3 w-3 shrink-0" />
							{m.tags_reorder()}
						</button>
					{/if}
				</div>
			{/if}
		{/if}
	</Popover.Content>
</Popover.Root>
