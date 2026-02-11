<script lang="ts">
	import { Calendar as CalendarIcon } from 'lucide-svelte';
	import { type DateValue, getLocalTimeZone, parseDate, today } from '@internationalized/date';
	import { cn } from '$lib/utils.js';
	import { buttonVariants } from '$lib/components/ui/button/index.js';
	import { Calendar } from '$lib/components/ui/calendar/index.js';
	import * as Popover from '$lib/components/ui/popover/index.js';
	import { formatDate } from '$lib/stores/settings';

	interface Props {
		/** Value in YYYY-MM-DD format (for compatibility with existing code) */
		value: string;
		placeholder?: string;
		class?: string;
	}

	let { value = $bindable(''), placeholder = 'Pick a date', class: className = '' }: Props = $props();

	let open = $state(false);

	// Convert YYYY-MM-DD string to DateValue
	const dateValue = $derived.by(() => {
		if (!value) return undefined;
		try {
			return parseDate(value);
		} catch {
			return undefined;
		}
	});

	// Format display using user's preferred format
	const displayValue = $derived(value ? formatDate(value + 'T00:00:00') : '');

	// Handle calendar selection
	function onSelect(newValue: DateValue | undefined) {
		if (newValue) {
			// Convert DateValue back to YYYY-MM-DD string
			const year = newValue.year;
			const month = String(newValue.month).padStart(2, '0');
			const day = String(newValue.day).padStart(2, '0');
			value = `${year}-${month}-${day}`;
		} else {
			value = '';
		}
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		class={cn(
			buttonVariants({ variant: 'outline' }),
			'w-[140px] justify-start text-left font-normal h-8',
			!value && 'text-muted-foreground',
			className
		)}
	>
		<CalendarIcon class="mr-2 h-4 w-4" />
		{#if displayValue}
			<span class="text-xs">{displayValue}</span>
		{:else}
			<span class="text-xs">{placeholder}</span>
		{/if}
	</Popover.Trigger>
	<Popover.Content class="w-auto p-0 z-[200]" align="start">
		<Calendar
			type="single"
			value={dateValue}
			onValueChange={onSelect}
			initialFocus
		/>
	</Popover.Content>
</Popover.Root>
