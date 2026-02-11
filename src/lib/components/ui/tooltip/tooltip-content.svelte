<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 0,
		side = "top",
		children,
		arrowClasses,
		...restProps
	}: TooltipPrimitive.ContentProps & {
		arrowClasses?: string;
	} = $props();
</script>

<TooltipPrimitive.Content
	bind:ref
	data-slot="tooltip-content"
	{sideOffset}
	{side}
	class={cn(
		"bg-popover text-popover-foreground border shadow-lg animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-end-2 data-[side=right]:slide-in-from-start-2 data-[side=top]:slide-in-from-bottom-2 origin-(--bits-tooltip-content-transform-origin) z-[200] w-fit fixed text-balance rounded-md px-3 py-1.5 text-xs",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</TooltipPrimitive.Content>
