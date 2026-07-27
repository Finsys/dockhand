<script lang="ts">
	import { Check, CircleOff } from 'lucide-svelte';

	interface Props {
		checked: boolean;
		disabled?: boolean;
		onLabel?: string;
		offLabel?: string;
		onchange?: (checked: boolean) => void;
	}

	let { checked = $bindable(), disabled = false, onLabel = 'ON', offLabel = 'OFF', onchange }: Props = $props();

	function toggle() {
		if (disabled) return;
		const newValue = !checked;
		checked = newValue;
		onchange?.(newValue);
	}
</script>

<button
	type="button"
	class="inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors min-w-[65px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 {checked ? 'bg-green-500/15 text-green-600 hover:bg-green-500/25' : 'bg-muted text-muted-foreground hover:bg-muted/80'} {disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}"
	onclick={toggle}
	{disabled}
>
	{#if checked}
		<Check class="w-3 h-3" />
		{onLabel}
	{:else}
		<CircleOff class="w-3 h-3" />
		{offLabel}
	{/if}
</button>
