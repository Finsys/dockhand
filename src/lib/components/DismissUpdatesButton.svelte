<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { CircleArrowUp, Tag } from 'lucide-svelte';
	import { scale } from 'svelte/transition';
	import { backOut } from 'svelte/easing';

	interface Props {
		/** Whether any update indicator is present (digest, newer-version, or failed check). */
		show: boolean;
		/** Number of items with a digest update - shows the up-arrow icon + count. */
		digestCount: number;
		/** Number of items with a newer-version tag - shows the tag icon + count. */
		newerVersionCount: number;
		onDismiss: () => void;
	}

	let { show, digestCount, newerVersionCount, onDismiss }: Props = $props();
</script>

{#if show}
	<div transition:scale={{ duration: 220, start: 0.85, opacity: 0, easing: backOut }} class="flex">
	<Button
		size="sm"
		variant="outline"
		onclick={onDismiss}
		class="gap-1.5 border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:border-amber-500"
		title="Dismiss all update indicators"
	>
		{#if digestCount > 0}
			<span class="flex items-center gap-0.5">
				<CircleArrowUp class="w-3.5 h-3.5" />
				<span class="text-xs font-medium tabular-nums">{digestCount}</span>
			</span>
		{/if}
		{#if newerVersionCount > 0}
			<span class="flex items-center gap-0.5">
				<Tag class="w-2.5 h-2.5" />
				<span class="text-xs font-medium tabular-nums">{newerVersionCount}</span>
			</span>
		{/if}
		{#if digestCount === 0 && newerVersionCount === 0}
			<!-- only failed checks remain - fall back to the update icon -->
			<CircleArrowUp class="w-3.5 h-3.5" />
		{/if}
		<span class="text-base leading-none opacity-50">×</span>
	</Button>
	</div>
{/if}
