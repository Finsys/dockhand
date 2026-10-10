<script lang="ts">
	import { themeStore, type FontSize } from '$lib/stores/theme';
	import { sseConnected } from '$lib/stores/events';
	import { m } from '$lib/paraglide/messages.js';
	import { Badge } from '$lib/components/ui/badge';
	import { Wifi } from 'lucide-svelte';
	import type { Component } from 'svelte';

	export interface HeaderTab {
		id: string;
		label: string;
		icon: Component;
		/** Optional count badge shown next to the label. */
		count?: number | string;
		/** Optional secondary total, rendered as "count of total" (active tab only). */
		total?: number;
		/** Show the live-connection (wifi) indicator inside this tab's segment. */
		showConnection?: boolean;
	}

	interface Props {
		tabs: HeaderTab[];
		activeTab: string;
		onTabChange: (id: string) => void;
		class?: string;
	}

	let {
		tabs,
		activeTab,
		onTabChange,
		class: className = ''
	}: Props = $props();

	// Font size scaling (mirrors PageHeader so the active tab matches page titles).
	// $themeStore auto-subscribes/cleans up; no manual subscription to leak.
	const fontSize = $derived<FontSize>($themeStore.fontSize);

	const headerTextClass = $derived.by(() => {
		switch (fontSize) {
			case 'small': return 'text-lg';
			case 'normal': return 'text-xl';
			case 'medium': return 'text-2xl';
			case 'large': return 'text-2xl';
			case 'xlarge': return 'text-3xl';
			default: return 'text-xl';
		}
	});

	const headerIconClass = $derived.by(() => {
		switch (fontSize) {
			case 'small': return 'w-4 h-4';
			case 'normal': return 'w-5 h-5';
			case 'medium': return 'w-6 h-6';
			case 'large': return 'w-6 h-6';
			case 'xlarge': return 'w-7 h-7';
			default: return 'w-5 h-5';
		}
	});

	function countDisplay(tab: HeaderTab): string | null {
		if (tab.count === undefined) return null;
		const countStr = typeof tab.count === 'number' ? tab.count.toLocaleString() : tab.count;
		if (tab.total !== undefined) {
			return `${countStr} of ${tab.total.toLocaleString()}`;
		}
		return countStr;
	}

	let active = $derived(tabs.find(t => t.id === activeTab) ?? tabs[0]);
</script>

<!-- A header that IS the switcher: all tabs live in one left-aligned segmented
     control, the active segment filled and scaled to page-title size. Replaces
     the plain PageHeader on pages that have sub-views. -->
<div class="flex items-center gap-3 {className}">
	<div class="inline-flex items-center gap-1 rounded-lg bg-muted/60 p-1">
		{#each tabs as tab (tab.id)}
			{@const TabIcon = tab.icon}
			{@const isActive = tab.id === active?.id}
			<button
				type="button"
				aria-pressed={isActive}
				onclick={() => onTabChange(tab.id)}
				class="flex items-center gap-2 rounded-md font-bold leading-none transition-colors {headerTextClass} px-3 py-1.5 {isActive
					? 'bg-background text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground hover:bg-background/40'}"
			>
				<TabIcon class={headerIconClass} />
				<span>{tab.label}</span>
				{#if countDisplay(tab)}
					<Badge variant="secondary" class="text-xs tabular-nums min-w-8 justify-center">
						{countDisplay(tab)}
					</Badge>
				{/if}
				{#if tab.showConnection}
					<span title={$sseConnected ? m.pageheader_live_active() : m.pageheader_live_connecting()}>
						<Wifi class="w-3.5 h-3.5 {$sseConnected ? 'text-emerald-500' : 'text-muted-foreground'}" />
					</span>
				{/if}
			</button>
		{/each}
	</div>
</div>
