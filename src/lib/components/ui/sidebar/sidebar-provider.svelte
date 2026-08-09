<script lang="ts">
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";
	import {
		SIDEBAR_WIDTH,
		SIDEBAR_WIDTH_ICON,
	} from "./constants.js";
	import { setSidebar } from "./context.svelte.js";

	const SIDEBAR_STORAGE_KEY = "sidebar:state";

	// Read the persisted open/collapsed state SYNCHRONOUSLY (before first paint) so a
	// collapsed sidebar doesn't flash open on every load. onMount ran too late — the
	// initial render showed the default-open sidebar until localStorage was read.
	function initialOpen(): boolean {
		if (typeof localStorage === 'undefined') return true;
		const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
		return stored === null ? true : stored === 'true';
	}

	let {
		ref = $bindable(null),
		open = $bindable(initialOpen()),
		onOpenChange = () => {},
		class: className,
		style,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
	} = $props();

	const sidebar = setSidebar({
		open: () => open,
		setOpen: (value: boolean) => {
			open = value;
			onOpenChange(value);

			// Store in localStorage for persistence
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
			}
		},
	});

</script>

<svelte:window onkeydown={sidebar.handleShortcutKeydown} />

<Tooltip.Provider delayDuration={0}>
	<div
		data-slot="sidebar-wrapper"
		style="--sidebar-width: {SIDEBAR_WIDTH}; --sidebar-width-icon: {SIDEBAR_WIDTH_ICON}; {style}"
		class={cn(
			"group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex h-dvh w-full overflow-hidden",
			className
		)}
		bind:this={ref}
		{...restProps}
	>
		{@render children?.()}
	</div>
</Tooltip.Provider>
