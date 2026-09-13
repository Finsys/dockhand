<script lang="ts">
	import { RefreshCw, Plus, Play, Download, Hammer } from 'lucide-svelte';
	import ContainerIcon from '$lib/components/ContainerIcon.svelte';
	import { summarize } from '$lib/utils/deploy-summary-core';

	// A compact, horizontal recap of a compose run, derived from its output lines
	// (the same pure summarizer the recorded runs use). Renders nothing until there
	// is at least one container/image fact, so it never adds empty chrome.
	interface Props {
		lines: string[];
		class?: string;
	}
	let { lines, class: className = '' }: Props = $props();

	let s = $derived(summarize(lines));
	let hasContainers = $derived(s.containersRecreated + s.containersCreated + s.containersStarted > 0);
	let hasImages = $derived(s.imagesPulled.length + s.imagesBuilt.length > 0);
	let show = $derived(hasContainers || hasImages);
</script>

{#if show}
	<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-normal text-muted-foreground {className}">
		{#if s.containersRecreated > 0}
			<span class="inline-flex items-center gap-1"><RefreshCw class="h-3 w-3" />{s.containersRecreated} recreated</span>
		{/if}
		{#if s.containersCreated > 0}
			<span class="inline-flex items-center gap-1"><Plus class="h-3 w-3" />{s.containersCreated} created</span>
		{/if}
		{#if s.containersStarted > 0}
			<span class="inline-flex items-center gap-1"><Play class="h-3 w-3" />{s.containersStarted} started</span>
		{/if}
		{#if s.imagesPulled.length > 0}
			<span class="inline-flex items-center gap-1.5">
				<Download class="h-3 w-3 shrink-0" />
				{#each s.imagesPulled as img}
					<span class="inline-flex items-center gap-1"><ContainerIcon image={img} showFallbackWhenOff class="h-3 w-3 shrink-0" />{img}</span>
				{/each}
			</span>
		{/if}
		{#if s.imagesBuilt.length > 0}
			<span class="inline-flex items-center gap-1.5">
				<Hammer class="h-3 w-3 shrink-0" />
				{#each s.imagesBuilt as img}
					<span class="inline-flex items-center gap-1"><ContainerIcon image={img} showFallbackWhenOff class="h-3 w-3 shrink-0" />{img}</span>
				{/each}
			</span>
		{/if}
	</div>
{/if}
