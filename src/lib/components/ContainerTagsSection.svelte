<script lang="ts">
	import TagChips from '$lib/components/TagChips.svelte';
	import TagEditPopover from '$lib/components/TagEditPopover.svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { isAdmin } from '$lib/stores/auth';
	import type { Tag, TagColor } from '$lib/utils/tags-core';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		containerName: string;
		envId: number | null;
		/** Shown when the container has no tags (assign affordance). */
		emptyHint?: string;
	}
	let { containerName, envId, emptyHint = undefined }: Props = $props();

	let catalog = $state<Tag[]>([]);
	let assigned = $state<number[]>([]);
	const byId = $derived(new Map(catalog.map((t) => [t.id, t])));
	const assignedTags = $derived(assigned.map((id) => byId.get(id)).filter((t): t is Tag => !!t));

	async function load() {
		if (!containerName) return;
		try {
			const [catRes, idsRes] = await Promise.all([
				fetch('/api/tags'), // catalog: global
				fetch(appendEnvParam(`/api/container-tags/${encodeURIComponent(containerName)}`, envId)) // assignments: per env
			]);
			catalog = catRes.ok ? (await catRes.json()).tags : [];
			assigned = idsRes.ok ? (await idsRes.json()).tagIds ?? [] : [];
		} catch { catalog = []; assigned = []; }
	}

	// Reload whenever the container/env this section points at changes.
	$effect(() => { void containerName; void envId; load(); });

	async function createTag(name: string, color: TagColor, icon: string | null): Promise<Tag | null> {
		try {
			const res = await fetch('/api/tags', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, color, icon })
			});
			if (!res.ok) return null;
			const tag = await res.json();
			await load();
			return tag;
		} catch { return null; }
	}

	async function apply(tagIds: number[]) {
		assigned = tagIds;
		try {
			await fetch(appendEnvParam(`/api/container-tags/${encodeURIComponent(containerName)}`, envId), {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tagIds })
			});
		} catch { /* optimistic */ }
	}
</script>

<div class="flex items-center gap-1.5 flex-wrap min-h-6">
	<TagChips tags={assignedTags} onRemove={(t) => apply(assigned.filter((id) => id !== t.id))} />
	<TagEditPopover catalog={catalog} selected={assigned} onCreate={createTag} onApply={apply} allowCreate={$isAdmin} />
	{#if assignedTags.length === 0}
		<span class="text-xs text-muted-foreground">{emptyHint ?? m.tagsection_empty_hint()}</span>
	{/if}
</div>
