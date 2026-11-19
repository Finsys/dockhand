<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconComponent } from '$lib/types';
	import { cn } from '$lib/utils.js';

	interface Props {
		icon?: IconComponent;
		title: string;
		description?: string;
		class?: string;
		children?: Snippet;
	}

	let { icon: Icon, title, description, class: className, children }: Props = $props();
</script>

<div class={cn("flex flex-col items-center justify-center py-12 px-4 text-center", className)}>
	{#if Icon}
		<div class="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
			<Icon class="w-6 h-6 text-muted-foreground" />
		</div>
	{/if}
	<h3 class="text-lg font-medium text-foreground mb-1">{title}</h3>
	{#if description}
		<p class="text-sm text-muted-foreground max-w-sm mb-4">{description}</p>
	{/if}
	{#if children}
		<div class="mt-2">
			{@render children()}
		</div>
	{/if}
</div>
