<script lang="ts">
	import { tick } from 'svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Popover from '$lib/components/ui/popover';
	import { Tags as TagsIcon, Plus, Trash2, Check, Pencil, GripVertical, RotateCcw, ArrowUpDown } from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import TagIconPicker from '$lib/components/TagIconPicker.svelte';
	import TagLucideIcon from '$lib/components/TagLucideIcon.svelte';
	import { toast } from 'svelte-sonner';
	import { isAdmin } from '$lib/stores/auth';
	import { tagOrder } from '$lib/stores/tag-order';
	import { applyOrder } from '$lib/utils/apply-order';
	import { dndzone, type DndEvent } from 'svelte-dnd-action';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { TAG_COLORS, tagHex, normalizeTag, type Tag, type TagColor } from '$lib/utils/tags-core';
	import { Tag as TagIcon } from 'lucide-svelte';

	let tags = $state<Tag[]>([]);
	let loading = $state(false);
	// The tag catalog is global and shared; only admins may create/rename/recolour/delete.
	const canEdit = $derived($isAdmin);

	// --- Reorder ---
	// Editing the shared catalogue is an admin's job, but the order it reads in is
	// each user's own, so anyone may rearrange their own view.
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

	// New-tag form
	let newName = $state('');
	let newColor = $state<TagColor>('blue');
	let newIcon = $state<string | null>(null);
	let creating = $state(false);

	// Inline edit state
	let editId = $state<number | null>(null);
	let editName = $state('');
	let editInput = $state<HTMLInputElement | null>(null);

	async function startRename(tag: { id: number; name: string }) {
		editId = tag.id;
		editName = tag.name;
		await tick();
		editInput?.focus();
		editInput?.select();
	}
	let colorPopoverId = $state<number | null>(null);

	async function load() {
		loading = true;
		try {
			const res = await fetch(`/api/tags`);
			tags = res.ok ? (await res.json()).tags : [];
		} catch { tags = []; } finally { loading = false; }
	}

	$effect(() => { load(); });

	async function create() {
		const name = normalizeTag(newName);
		if (!name || creating) return;
		creating = true;
		try {
			const res = await fetch(`/api/tags`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, color: newColor, icon: newIcon })
			});
			if (!res.ok) { toast.error('Failed to create tag'); return; }
			newName = ''; newColor = 'blue'; newIcon = null;
			await load();
		} finally { creating = false; }
	}

	async function saveEdit(tag: Tag) {
		const name = normalizeTag(editName);
		if (!name) { editId = null; return; }
		// Keep the editor open when the rename is rejected (e.g. duplicate name).
		if (await patch(tag.id, { name })) editId = null;
	}

	async function setColor(tag: Tag, color: TagColor) {
		colorPopoverId = null;
		await patch(tag.id, { color });
	}

	async function setIcon(tag: Tag, icon: string | null) {
		await patch(tag.id, { icon });
	}

	async function patch(id: number, body: Record<string, unknown>): Promise<boolean> {
		try {
			const res = await fetch(`/api/tags/${id}`, {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const msg = await res.json().then((d) => d?.error).catch(() => null);
				toast.error(msg || 'Failed to update tag');
				return false;
			}
			await load();
			return true;
		} catch { toast.error('Failed to update tag'); return false; }
	}

	async function remove(tag: Tag) {
		try {
			const res = await fetch(`/api/tags/${tag.id}`, { method: 'DELETE' });
			if (!res.ok) { toast.error('Failed to delete tag'); return; }
			toast.success(`Deleted "${tag.name}"`);
			await load();
		} catch { toast.error('Failed to delete tag'); }
	}
</script>

<Card.Root>
	<Card.Header>
		<div class="flex items-start justify-between gap-3">
			<div class="flex items-center gap-2">
				<TagsIcon class="w-4 h-4 text-muted-foreground" />
				<div>
					<Card.Title class="text-base">Tags</Card.Title>
					<Card.Description>
						Organize containers and stacks with your own tags. Tags are shared across all environments; which containers and stacks carry a tag is set per environment.
						{#if !canEdit} Only an administrator can create or edit tags.{/if}
					</Card.Description>
				</div>
			</div>
		</div>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if canEdit}
			<!-- Create -->
			<div class="flex items-center gap-2">
				<Input bind:value={newName} placeholder="New tag name" class="h-9 max-w-xs"
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') create(); }} />
				<Popover.Root>
					<Popover.Trigger>
						{#snippet child({ props })}
							<button {...props} type="button" title="Pick colour"
								class="h-9 w-9 shrink-0 rounded-md border flex items-center justify-center">
								<span class="h-4 w-4 rounded-full" style="background-color: {tagHex(newColor)};"></span>
							</button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content class="w-auto p-2">
						<div class="grid grid-cols-8 gap-1">
							{#each TAG_COLORS as c}
								<button type="button" title={c} onclick={() => (newColor = c)}
									class="h-5 w-5 rounded-full ring-offset-1 ring-offset-background {newColor === c ? 'ring-2 ring-foreground' : ''}"
									style="background-color: {tagHex(c)};"></button>
							{/each}
						</div>
					</Popover.Content>
				</Popover.Root>
				<TagIconPicker icon={newIcon} hex={tagHex(newColor)} onSelect={(i) => (newIcon = i)} />
				<Button size="sm" onclick={create} disabled={creating || !normalizeTag(newName)}>
					<Plus class="w-4 h-4" /> Add tag
				</Button>
			</div>
		{/if}

		{#if loading}
			<p class="text-sm text-muted-foreground">Loading...</p>
		{:else if tags.length === 0}
			<div class="py-6 text-center text-sm text-muted-foreground">No tags yet</div>
		{:else}
			<div
				class="flex flex-wrap gap-2"
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
					<div
						animate:flip={{ duration: 180, easing: cubicOut }}
						class="flex items-center gap-1.5 rounded-md border px-2 py-1 {reorderMode
							? 'cursor-grab active:cursor-grabbing'
							: ''}"
					>
						{#if reorderMode}
							<GripVertical class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
						{/if}
						{#if editId === tag.id}
							<Input bind:value={editName} bind:ref={editInput} class="h-6 w-32 text-sm"
								onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') saveEdit(tag); if (e.key === 'Escape') editId = null; }} />
							<button type="button" class="text-primary" onclick={() => saveEdit(tag)}><Check class="w-3.5 h-3.5" /></button>
						{:else}
							{@const hex = tagHex(tag.color)}
							<span class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0 text-2xs font-medium"
								style="color: {hex}; background-color: {hex}1a; border-color: {hex}33;">
								{#if tag.icon}<TagLucideIcon name={tag.icon} class="h-2.5 w-2.5" />{:else}<TagIcon class="h-2.5 w-2.5" />{/if}
								{tag.name}
							</span>
							{#if canEdit && !reorderMode}
								<!-- Recolour -->
								<Popover.Root open={colorPopoverId === tag.id} onOpenChange={(o) => colorPopoverId = o ? tag.id : null}>
									<Popover.Trigger>
										{#snippet child({ props })}
											<button {...props} type="button" title="Change colour" class="text-muted-foreground hover:text-foreground">
												<span class="h-3 w-3 rounded-full block" style="background-color: {hex};"></span>
											</button>
										{/snippet}
									</Popover.Trigger>
									<Popover.Content class="w-auto p-2">
										<div class="grid grid-cols-8 gap-1">
											{#each TAG_COLORS as c}
												<button type="button" title={c} onclick={() => setColor(tag, c)}
													class="h-5 w-5 rounded-full ring-offset-1 ring-offset-background {tag.color === c ? 'ring-2 ring-foreground' : ''}"
													style="background-color: {tagHex(c)};"></button>
											{/each}
										</div>
									</Popover.Content>
								</Popover.Root>
								<!-- Change icon -->
								<TagIconPicker icon={tag.icon ?? null} hex={hex} triggerClass="h-5 w-5 border-0"
									onSelect={(i) => setIcon(tag, i)} />
								<button type="button" title="Rename" class="text-muted-foreground hover:text-foreground"
									onclick={() => startRename(tag)}><Pencil class="w-3 h-3" /></button>
								<ConfirmPopover
									action="Delete"
									itemType="tag"
									itemName={tag.name}
									title="Delete this tag from every container and stack?"
									confirmText="Delete"
									variant="destructive"
									onConfirm={() => remove(tag)}
								>
									{#snippet children({ open })}
										<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
									{/snippet}
								</ConfirmPopover>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
			{#if tags.length > 1}
				<div class="mt-2 flex items-center gap-3 text-xs leading-none">
					{#if reorderMode}
						<button
							type="button"
							class="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground transition-colors"
							title="List tags by name again"
							onclick={() => {
								tagOrder.reset();
								dragList = null;
								reorderMode = false;
							}}
						>
							<RotateCcw class="h-3 w-3 shrink-0 text-red-400" />
							Reset
						</button>
						<button
							type="button"
							class="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground transition-colors"
							onclick={() => (reorderMode = false)}
						>
							<Check class="h-3 w-3 shrink-0 text-emerald-500" />
							Apply
						</button>
					{:else}
						<button
							type="button"
							class="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground transition-colors"
							title="Drag tags into the order you want them listed and grouped in"
							onclick={() => (reorderMode = true)}
						>
							<ArrowUpDown class="h-3 w-3 shrink-0" />
							Reorder
						</button>
					{/if}
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>
