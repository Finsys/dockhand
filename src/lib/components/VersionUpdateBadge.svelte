<script lang="ts">
	import { Tag } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { NewerVersion } from '$lib/types';

	interface Props {
		/** The newer-version suggestion for this container (target tag + how many were skipped). */
		newerVersion: NewerVersion;
		/** Called when the badge is clicked — opens the release-notes modal. */
		onclick?: () => void;
		/** Compact icon-only marker for the image icon-row (default), or a full pill with the tag. */
		variant?: 'icon' | 'pill';
	}

	let { newerVersion, onclick, variant = 'icon' }: Props = $props();

	// How many versions behind the running tag is (skipped is inclusive of the target).
	const behind = $derived(newerVersion.skipped.length);
	const bumpColor = $derived(
		newerVersion.bump === 'major'
			? 'text-red-400'
			: newerVersion.bump === 'minor'
				? 'text-amber-400'
				: 'text-indigo-400'
	);
</script>

<Tooltip.Root>
	<Tooltip.Trigger
		onclick={(e) => {
			e.stopPropagation();
			onclick?.();
		}}
		class="shrink-0 inline-flex items-center gap-1 self-center text-amber-500 hover:text-amber-400 transition-colors cursor-pointer
			{variant === 'pill'
				? 'rounded-full bg-amber-500/10 hover:bg-amber-500/20 px-1.5 py-0.5 text-2xs font-medium'
				: ''}"
	>
		<Tag class="w-3 h-3 shrink-0" />
		{#if variant === 'pill'}
			<span>{newerVersion.tag}</span>
		{/if}
	</Tooltip.Trigger>
	<Tooltip.Content side="right" class="w-64 p-3">
		<div class="space-y-1.5">
			<p class="font-medium text-sm flex items-center gap-1.5">
				<Tag class="w-4 h-4 text-amber-500 shrink-0" />
				Newer version available
			</p>
			<p class="text-xs">
				<span class="text-muted-foreground">Move to</span>
				<code class="mx-0.5 rounded bg-muted px-1 py-0.5 font-mono">{newerVersion.tag}</code>
				<span class="font-semibold uppercase {bumpColor}">{newerVersion.bump}</span>
			</p>
			{#if behind > 1}
				<p class="text-xs text-muted-foreground">{behind} versions ahead of the tag you run.</p>
			{/if}
			<p class="text-xs text-muted-foreground">Click for release notes. Never auto-applied.</p>
		</div>
	</Tooltip.Content>
</Tooltip.Root>
