<script lang="ts">
	import { getIconComponent, isCustomIcon } from '$lib/utils/icons';
	import type { Component } from 'svelte';

	interface Props {
		icon: string;
		envId: number;
		class?: string;
		cacheBust?: string | number;
	}

	let { icon, envId, class: className = 'w-4 h-4', cacheBust }: Props = $props();

	const isCustom = $derived(isCustomIcon(icon));
	const LucideIcon = $derived(!isCustom ? getIconComponent(icon) : null) as Component | null;
	const imgSrc = $derived(isCustom ? `/api/environments/${envId}/icon${cacheBust ? `?v=${cacheBust}` : ''}` : '');
</script>

{#if isCustom}
	<img src={imgSrc} alt="" class="{className} rounded-full object-cover" />
{:else if LucideIcon}
	<LucideIcon class={className} />
{/if}
