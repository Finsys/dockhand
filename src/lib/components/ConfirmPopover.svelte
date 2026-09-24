<script lang="ts">
	import { tick } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import type { Snippet } from 'svelte';
	import { appSettings } from '$lib/stores/settings';

	interface Props {
		/** Optional — the popover self-manages its open state; bind only if the parent needs it. */
		open?: boolean;
		action: string;
		itemName?: string;
		itemType: string;
		confirmText?: string;
		variant?: 'destructive' | 'secondary' | 'default';
		autoHideMs?: number;
		title?: string;
		position?: 'left' | 'right';
		unstyled?: boolean;
		disabled?: boolean;
		onConfirm: () => void;
		/** Optional — notified when the popover opens/closes. */
		onOpenChange?: (open: boolean) => void;
		children: Snippet<[{ open: boolean }]>;
		extraContent?: Snippet;
		/** Optional leading glyph rendered before the confirm text (e.g. a stack icon). */
		icon?: Snippet;
	}

	let {
		open = $bindable(false),
		action,
		itemName = '',
		itemType,
		confirmText = 'Confirm',
		variant = 'destructive',
		autoHideMs = 3000,
		title = '',
		position = 'right',
		unstyled = false,
		disabled = false,
		onConfirm,
		onOpenChange,
		children,
		extraContent,
		icon
	}: Props = $props();

	const triggerClass = $derived(unstyled
		? 'inline-flex items-center cursor-pointer'
		: 'p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer inline-flex items-center'
	);

	// Get the confirmDestructive setting from the store
	const confirmDestructive = $derived($appSettings.confirmDestructive);

	// Truncate long names
	const displayName = $derived(itemName && itemName.length > 20 ? itemName.slice(0, 20) + '...' : itemName);

	// The heavy bits-ui Popover.Root (floating-ui context + portal) is only mounted once
	// this confirm is actually opened. Before that the trigger is a plain button, so a grid
	// of N rows with several ConfirmPopovers each mounts N cheap buttons instead of hundreds
	// of popovers - the difference between an instant filter/regroup and a multi-second one.
	let activated = $state(open);
	$effect(() => { if (open) activated = true; });

	// Auto-hide after specified time
	$effect(() => {
		if (open && autoHideMs > 0) {
			const timeout = setTimeout(() => {
				open = false;
				onOpenChange?.(false);
			}, autoHideMs);
			return () => clearTimeout(timeout);
		}
	});

	function handleConfirm() {
		onConfirm();
		open = false;
		onOpenChange?.(false);
	}

	async function handleTriggerClick(e: MouseEvent) {
		e.stopPropagation();
		// If confirmDestructive is disabled, execute action immediately (no popover ever).
		if (!confirmDestructive) {
			onConfirm();
			return;
		}
		if (open) {
			open = false;
			onOpenChange?.(false);
			return;
		}
		// Mount the Root first, then open on the next microtask so bits-ui positions the
		// content against a trigger already in the DOM.
		activated = true;
		await tick();
		open = true;
		onOpenChange?.(true);
	}

	function handleOpenChange(newOpen: boolean) {
		open = newOpen;
		onOpenChange?.(newOpen);
	}
</script>

{#if !activated}
	<!-- Cheap placeholder: no Popover.Root until this confirm is opened. -->
	<button
		type="button"
		{title}
		onclick={handleTriggerClick}
		class={triggerClass}
	>
		{@render children({ open: false })}
	</button>
{:else}
<Popover.Root bind:open onOpenChange={handleOpenChange}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				type="button"
				{title}
				{...props}
				onclick={handleTriggerClick}
				class={triggerClass}
			>
				{@render children({ open })}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		class="w-auto p-2 z-[200]"
		side="top"
		align={position === 'left' ? 'start' : 'end'}
		sideOffset={8}
	>
		<div class="flex flex-col gap-1.5">
			<div class="flex items-center gap-2">
				{#if icon}{@render icon()}{/if}
				<span class="text-xs whitespace-nowrap">{action} {itemType} {#if displayName}<strong class="font-semibold text-foreground">{displayName}</strong>{/if}?</span>
				<Button size="sm" {variant} class="h-6 px-2 text-xs" onclick={handleConfirm}>
					{confirmText}
				</Button>
			</div>
			{#if extraContent}
				{@render extraContent()}
			{/if}
		</div>
	</Popover.Content>
</Popover.Root>
{/if}
