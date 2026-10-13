<script lang="ts">
	import { themeStore, type FontSize } from '$lib/stores/theme';
	import { sseConnected } from '$lib/stores/events';
	import { m } from '$lib/paraglide/messages.js';
	import { Badge } from '$lib/components/ui/badge';
	import { Wifi } from 'lucide-svelte';
	import type { Component } from 'svelte';

	interface Props {
		icon: Component;
		title: string;
		count?: number | string;
		total?: number;
		showConnection?: boolean;
		class?: string;
		iconClass?: string;
		countClass?: string;
	}

	let {
		icon: Icon,
		title,
		count,
		total,
		showConnection = true,
		class: className = '',
		iconClass = '',
		countClass = 'min-w-12'
	}: Props = $props();

	// Font size scaling for page header
	let fontSize = $state<FontSize>('normal');
	themeStore.subscribe(prefs => fontSize = prefs.fontSize);

	// Page header text size - shifted smaller (normal = what was small)
	const headerTextClass = $derived(() => {
		switch (fontSize) {
			case 'small': return 'text-lg';
			case 'normal': return 'text-xl';
			case 'medium': return 'text-2xl';
			case 'large': return 'text-2xl';
			case 'xlarge': return 'text-3xl';
			default: return 'text-xl';
		}
	});

	// Page header icon size - shifted smaller (normal = what was small)
	const headerIconClass = $derived(() => {
		switch (fontSize) {
			case 'small': return 'w-4 h-4';
			case 'normal': return 'w-5 h-5';
			case 'medium': return 'w-6 h-6';
			case 'large': return 'w-6 h-6';
			case 'xlarge': return 'w-7 h-7';
			default: return 'w-5 h-5';
		}
	});

	// Format count display
	const countDisplay = $derived(() => {
		if (count === undefined) return null;
		const countStr = typeof count === 'number' ? count.toLocaleString() : count;
		if (total !== undefined) {
			return `${countStr} of ${total.toLocaleString()}`;
		}
		return countStr;
	});
</script>

<div class="flex items-center gap-3 {className}">
	<Icon class="{headerIconClass()} {iconClass}" />
	<h1 class="{headerTextClass()} font-bold">{title}</h1>
	{#if countDisplay()}
		<Badge variant="secondary" class="text-xs tabular-nums {countClass} justify-center">
			{countDisplay()}
		</Badge>
	{/if}
	{#if showConnection}
		<span title={$sseConnected ? m.pageheader_live_active() : m.pageheader_live_connecting()}>
			<Wifi class="w-3.5 h-3.5 {$sseConnected ? 'text-emerald-500' : 'text-muted-foreground'}" />
		</span>
	{/if}
	<slot />
</div>
