<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Package, Star, Download, Loader2, ExternalLink } from 'lucide-svelte';
	import type { TemplateItem } from '../api/templates/+server';

	interface Props {
		template: TemplateItem;
		loading?: boolean;
		onclick: () => void;
	}

	let { template, loading = false, onclick }: Props = $props();

	let logoError = $state(false);

	const MAX_CATEGORIES = 3;
	const visibleCategories = $derived(template.categories.slice(0, MAX_CATEGORIES));
	const overflowCount = $derived(Math.max(0, template.categories.length - MAX_CATEGORIES));

	function formatPulls(pulls: number): string {
		if (pulls >= 1_000_000) return `${(pulls / 1_000_000).toFixed(1)}M`;
		if (pulls >= 1_000) return `${(pulls / 1_000).toFixed(1)}K`;
		return String(pulls);
	}

	// Convert markdown links [text](url) to HTML <a> tags, strip other HTML
	function renderDescription(text: string): string {
		return text
			.replace(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '[$2]($1)')  // normalize HTML links to markdown first
			.replace(/<[^>]+>/g, '')  // strip remaining HTML tags
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-primary hover:underline">$1</a>')
			.trim();
	}
</script>

<button
	class="text-left w-full group"
	onclick={onclick}
	disabled={loading}
>
	<Card.Root class="h-full gap-0 py-0 transition-all hover:border-primary/50 hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring {loading ? 'opacity-60' : ''}">
		<Card.Header class="p-3 pb-1.5">
			<div class="flex items-start gap-2.5">
				<!-- Logo -->
				<div class="w-8 h-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden">
					{#if template.logo && !logoError}
						<img
							src={template.logo}
							alt={template.title}
							class="w-8 h-8 object-contain rounded-md"
							loading="lazy"
							onerror={() => logoError = true}
						/>
					{:else}
						<Package class="w-4 h-4 text-muted-foreground" />
					{/if}
				</div>
				<!-- Title + source -->
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						<Card.Title class="text-sm font-semibold truncate flex-1">{template.title}</Card.Title>
						{#if loading}
							<Loader2 class="w-3.5 h-3.5 animate-spin text-muted-foreground" />
						{/if}
					</div>
					<Badge variant="outline" class="text-2xs px-1.5 py-0 font-normal">
						{template.source}
					</Badge>
				</div>
			</div>
		</Card.Header>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<Card.Content class="px-3 pb-2 pt-0" onclick={(e: MouseEvent) => { if ((e.target as HTMLElement).closest('a')) e.stopPropagation(); }}>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<p class="text-xs text-muted-foreground line-clamp-2">
				{@html renderDescription(template.description) || 'No description available'}
			</p>
		</Card.Content>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<Card.Footer
			class="px-3 pb-3 pt-0 flex items-center gap-1.5 flex-wrap"
			onclick={(e: MouseEvent) => { if ((e.target as HTMLElement).closest('a')) e.stopPropagation(); }}
		>
			{#each visibleCategories as category}
				<Badge variant="secondary" class="text-2xs px-1.5 py-0">
					{category}
				</Badge>
			{/each}
			{#if overflowCount > 0}
				<span class="text-2xs text-muted-foreground">+{overflowCount}</span>
			{/if}
			<div class="ml-auto flex items-center gap-2 text-2xs text-muted-foreground">
				{#if template.projectUrl}
					<a
						href={template.projectUrl}
						target="_blank"
						rel="noopener"
						class="flex items-center gap-0.5 hover:text-primary hover:underline"
						title={`Open project page: ${template.projectUrl}`}
						onclick={(e: MouseEvent) => {
							e.stopPropagation();
							e.preventDefault();
							window.open(template.projectUrl, '_blank', 'noopener');
						}}
					>
						<ExternalLink class="w-3 h-3" />
						Project
					</a>
				{/if}
				{#if template.stars}
					<span class="flex items-center gap-0.5">
						<Star class="w-3 h-3" />
						{template.stars}
					</span>
				{/if}
				{#if template.pulls}
					<span class="flex items-center gap-0.5">
						<Download class="w-3 h-3" />
						{formatPulls(template.pulls)}
					</span>
				{/if}
			</div>
		</Card.Footer>
	</Card.Root>
</button>
