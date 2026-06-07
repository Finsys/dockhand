<script lang="ts">
	import { CalendarClock, X } from 'lucide-svelte';
	import * as Popover from '$lib/components/ui/popover';
	import { Calendar } from '$lib/components/ui/calendar';
	import { CalendarDate, today, getLocalTimeZone } from '@internationalized/date';

	interface Props {
		sinceDate: string;
		sinceTime: string;
		untilDate: string;
		untilTime: string;
		darkMode: boolean;
		onApply: () => void;
		onClear: () => void;
	}

	let {
		sinceDate = $bindable(),
		sinceTime = $bindable(),
		untilDate = $bindable(),
		untilTime = $bindable(),
		darkMode,
		onApply,
		onClear
	}: Props = $props();

	let open = $state(false);
	let picking = $state<'from' | 'to'>('from');

	const hasFilter = $derived(sinceDate || untilDate);

	function formatLabel(): string {
		const parts: string[] = [];
		if (sinceDate) parts.push(sinceDate.slice(5) + ' ' + (sinceTime || '00:00'));
		if (untilDate) parts.push(untilDate.slice(5) + ' ' + (untilTime || '23:59'));
		if (parts.length === 2) return parts.join(' → ');
		if (sinceDate) return parts[0] + ' →';
		return '→ ' + parts[0];
	}

	function parseDate(dateStr: string): CalendarDate | undefined {
		if (!dateStr) return undefined;
		const [y, m, d] = dateStr.split('-').map(Number);
		return new CalendarDate(y, m, d);
	}

	function toDateString(date: CalendarDate): string {
		return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
	}

	const sinceCalValue = $derived(parseDate(sinceDate));
	const untilCalValue = $derived(parseDate(untilDate));

	function onFromSelect(value: any) {
		if (!value) return;
		sinceDate = toDateString(value);
		// Auto-switch to "To" picker
		picking = 'to';
		// If both dates are set, auto-apply
		if (untilDate) {
			open = false;
			onApply();
		}
	}

	function onToSelect(value: any) {
		if (!value) return;
		untilDate = toDateString(value);
		// If both dates are set, auto-apply and close
		if (sinceDate) {
			open = false;
			onApply();
		}
	}

	function clear() {
		sinceDate = '';
		sinceTime = '';
		untilDate = '';
		untilTime = '';
		open = false;
		onClear();
	}

	function apply() {
		open = false;
		onApply();
	}
</script>

<Popover.Root bind:open onOpenChange={(v) => { if (v) picking = sinceDate && !untilDate ? 'to' : 'from'; }}>
	<Popover.Trigger
		class="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors {hasFilter ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-300'}"
		title={hasFilter ? `Time range: ${formatLabel()}` : 'Filter logs by time range'}
	>
		<CalendarClock class="w-3 h-3" />
		{#if hasFilter}<span class="tabular-nums">{formatLabel()}</span>{/if}
	</Popover.Trigger>
	<Popover.Content class="w-auto p-0 z-[200]" align="start">
		<div class="flex flex-col">
			<!-- From/To tabs -->
			<div class="flex border-b border-border">
				<button
					type="button"
					onclick={() => picking = 'from'}
					class="flex-1 px-3 py-1.5 text-xs font-medium transition-colors {picking === 'from' ? 'text-foreground border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'}"
				>
					From{#if sinceDate}<span class="ml-1 text-muted-foreground">({sinceDate.slice(5)})</span>{/if}
				</button>
				<button
					type="button"
					onclick={() => picking = 'to'}
					class="flex-1 px-3 py-1.5 text-xs font-medium transition-colors {picking === 'to' ? 'text-foreground border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'}"
				>
					To{#if untilDate}<span class="ml-1 text-muted-foreground">({untilDate.slice(5)})</span>{/if}
				</button>
			</div>

			<!-- Calendar -->
			{#if picking === 'from'}
				<Calendar
					type="single"
					value={sinceCalValue}
					onValueChange={onFromSelect}
					class="p-2"
				/>
				<div class="px-3 pb-2">
					<div class="flex items-center gap-2">
						<span class="text-xs text-muted-foreground">Time:</span>
						<input type="time" bind:value={sinceTime} class="h-7 rounded border border-border px-2 text-xs bg-background text-foreground [color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-ring" />
					</div>
				</div>
			{:else}
				<Calendar
					type="single"
					value={untilCalValue}
					onValueChange={onToSelect}
					class="p-2"
				/>
				<div class="px-3 pb-2">
					<div class="flex items-center gap-2">
						<span class="text-xs text-muted-foreground">Time:</span>
						<input type="time" bind:value={untilTime} class="h-7 rounded border border-border px-2 text-xs bg-background text-foreground [color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-ring" />
					</div>
				</div>
			{/if}

			<!-- Actions -->
			<div class="flex items-center gap-2 px-3 pb-2">
				<button onclick={apply} class="px-2 py-1 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90" disabled={!sinceDate && !untilDate}>Apply</button>
				<button onclick={clear} class="px-2 py-1 rounded text-xs bg-muted text-muted-foreground hover:bg-muted/80">Clear</button>
			</div>
		</div>
	</Popover.Content>
</Popover.Root>
