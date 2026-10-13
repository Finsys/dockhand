<script lang="ts">
	import TagChips from '$lib/components/TagChips.svelte';
	import TagEditPopover from '$lib/components/TagEditPopover.svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { isAdmin } from '$lib/stores/auth';
	import type { Tag, TagColor } from '$lib/utils/tags-core';

	interface Props {
		stackName: string;
		envId: number | null;
	}
	let { stackName, envId }: Props = $props();

	let catalog = $state<Tag[]>([]);
	let assigned = $state<number[]>([]);
	const byId = $derived(new Map(catalog.map((t) => [t.id, t])));
	const assignedTags = $derived(
		assigned.map((id) => byId.get(id)).filter((t): t is Tag => !!t)
	);

	async function load() {
		if (!stackName) return;
		try {
			const [catRes, idsRes] = await Promise.all([
				fetch('/api/tags'), // catalog: global
				fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/tags`, envId)) // assignments: per env
			]);
			catalog = catRes.ok ? (await catRes.json()).tags : [];
			assigned = idsRes.ok ? (await idsRes.json()).tagIds ?? [] : [];
		} catch { catalog = []; assigned = []; }
	}

	// Reload whenever the stack/env this section points at changes.
	$effect(() => { void stackName; void envId; load(); });

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
			await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/tags`, envId), {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tagIds })
			});
		} catch { /* optimistic */ }
	}
</script>

<div class="flex items-center gap-2 flex-wrap">
	<TagChips tags={assignedTags} onRemove={(t) => apply(assigned.filter((id) => id !== t.id))} />
	<TagEditPopover catalog={catalog} selected={assigned} onCreate={createTag} onApply={apply} allowCreate={$isAdmin} />
</div>
