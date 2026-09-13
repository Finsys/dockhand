<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { currentEnvironment } from '$lib/stores/environment';

	// Unified modal header: [icon] Title [truncated resource name] on <amber env>.
	// The resource name truncates with an ellipsis and shows the full value in a
	// shadcn Tooltip on hover. Content gets an explicit w-80 (the project's proven
	// long-text pattern) so it doesn't collapse to w-fit; ignoreNonKeyboardFocus
	// stops it opening on the modal's initial focus. The env suffix ("on <name>")
	// inherits the title's colour/weight, only the env name is amber. Anything
	// else — a rename pencil, a status badge — goes in the `extra` snippet,
	// rendered inline after the env suffix.
	import ContainerIcon from '$lib/components/ContainerIcon.svelte';

	let {
		icon,
		title,
		name = undefined,
		envName = undefined,
		extra = undefined,
		iconImage = undefined,
		iconName = undefined
	}: {
		icon: Component;
		title: string;
		name?: string;
		envName?: string;
		extra?: Snippet;
		// When this header describes a container, pass its image (+ name) to show the
		// matched app logo in place of the lucide icon; falls back to `icon` with no match.
		iconImage?: string;
		iconName?: string;
	} = $props();

	const Icon = $derived(icon);
	const env = $derived(envName ?? $currentEnvironment?.name);
</script>

<Dialog.Title class="flex items-center gap-2 min-w-0">
	{#if iconImage !== undefined}
		<ContainerIcon image={iconImage} name={iconName ?? ''} class="w-5 h-5" fallbackIcon={icon} showFallbackWhenOff />
	{:else}
		<Icon class="w-5 h-5 shrink-0" />
	{/if}
	<span class="shrink-0">{title}</span>
	{#if name}
		<Tooltip.Root delayDuration={200} ignoreNonKeyboardFocus>
			<Tooltip.Trigger class="truncate min-w-0 max-w-[min(60%,28rem)] cursor-default">{name}</Tooltip.Trigger>
			<Tooltip.Content class="w-80"><p class="break-all">{name}</p></Tooltip.Content>
		</Tooltip.Root>
	{/if}
	{#if env}
		<span class="shrink-0">on <span class="text-amber-600 dark:text-amber-400">{env}</span></span>
	{/if}
	{#if extra}
		<span class="shrink-0 flex items-center gap-2">{@render extra()}</span>
	{/if}
</Dialog.Title>
