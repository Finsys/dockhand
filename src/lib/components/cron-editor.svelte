<script lang="ts">
	import * as Select from '$lib/components/ui/select';
	import { Input } from '$lib/components/ui/input';
	import { Calendar, CalendarDays, Clock } from 'lucide-svelte';
	import { appSettings } from '$lib/stores/settings';
	import cronstrue from 'cronstrue';

	// Reactive time format from settings
	let is12Hour = $derived($appSettings.timeFormat === '12h');

	interface Props {
		value: string;
		onchange: (cron: string) => void;
		disabled?: boolean;
	}

	let { value, onchange, disabled = false }: Props = $props();

	// Detect schedule type from cron expression
	function detectScheduleType(cron: string): 'daily' | 'weekly' | 'custom' {
		const parts = cron.split(' ');
		if (parts.length < 5) return 'custom';

		const [min, hr, day, month, dow] = parts;

		// Simple minute and hour: plain numbers only (not */n, ranges, or lists)
		const isSimpleNumber = (s: string) => /^\d+$/.test(s);

		// Weekly: specific single day of week (0-6), day and month are wildcards, simple min/hour
		if (dow !== '*' && /^\d$/.test(dow) && day === '*' && month === '*' && isSimpleNumber(min) && isSimpleNumber(hr)) {
			return 'weekly';
		}

		// Daily: all wildcards except simple minute and hour
		if (day === '*' && month === '*' && dow === '*' && isSimpleNumber(min) && isSimpleNumber(hr)) {
			return 'daily';
		}

		return 'custom';
	}

	// Parse cron into components for UI
	let minute = $state('0');
	let hour = $state('3');
	let dayOfWeek = $state('1'); // Monday
	let scheduleType = $state<'daily' | 'weekly' | 'custom'>('daily');

	// Track if component has been initialized
	let initialized = $state(false);
	let previousScheduleType = $state<'daily' | 'weekly' | 'custom'>('daily');
	let isTypingCustom = $state(false); // Track if user is actively typing in custom mode

	// Update UI when value (cron expression) changes externally
	$effect(() => {
		if (value) {
			const parts = value.split(' ');
			if (parts.length >= 5) {
				minute = parts[0] || '0';
				hour = parts[1] || '3';
				dayOfWeek = parts[4] !== '*' ? parts[4] : '1'; // Default to Monday

				// Only update schedule type if not actively typing in custom mode
				if (!isTypingCustom) {
					scheduleType = detectScheduleType(value);
				}
			}
		}

		// Mark as initialized after first parse
		if (!initialized) {
			initialized = true;
			previousScheduleType = scheduleType;
		}
	});

	// Generate cron expression from UI inputs
	function updateCronExpression() {
		let newCron = '';

		if (scheduleType === 'daily') {
			newCron = `${minute} ${hour} * * *`;
		} else if (scheduleType === 'weekly') {
			newCron = `${minute} ${hour} * * ${dayOfWeek}`;
		} else {
			// For custom, keep the current value
			return;
		}

		onchange(newCron);
	}

	// Handle schedule type change
	function handleScheduleTypeChange(newType: string) {
		const type = newType as 'daily' | 'weekly' | 'custom';
		scheduleType = type;

		// Set flag when switching to custom mode
		if (type === 'custom') {
			isTypingCustom = true;
		} else {
			isTypingCustom = false;
		}

		// Only reset to defaults if schedule type actually changed after initialization
		if (initialized && type !== previousScheduleType) {
			if (type === 'daily') {
				minute = '0';
				hour = '3';
				onchange('0 3 * * *');
			} else if (type === 'weekly') {
				minute = '0';
				hour = '3';
				dayOfWeek = '1'; // Monday
				onchange('0 3 * * 1');
			}
			previousScheduleType = type;
		}
	}

	function handleMinuteChange(value: string) {
		minute = value;
		updateCronExpression();
	}

	function handleHourChange(value: string) {
		hour = value;
		updateCronExpression();
	}

	function handleDayOfWeekChange(value: string) {
		dayOfWeek = value;
		updateCronExpression();
	}

	function handleCustomCronInput(e: Event) {
		const newValue = (e.currentTarget as HTMLInputElement).value;
		onchange(newValue);
	}

	// Validate cron expression
	function isValidCron(cron: string): boolean {
		const parts = cron.trim().split(/\s+/);
		if (parts.length !== 5) return false;

		const [min, hr, day, month, dow] = parts;

		// Basic pattern validation (number, *, */n, range, list)
		const cronFieldPattern = /^(\*|(\*\/\d+)|\d+(-\d+)?(,\d+(-\d+)?)*)$/;

		return (
			cronFieldPattern.test(min) &&
			cronFieldPattern.test(hr) &&
			cronFieldPattern.test(day) &&
			cronFieldPattern.test(month) &&
			cronFieldPattern.test(dow)
		);
	}

	// Human-readable description using cronstrue
	let humanReadable = $derived(() => {
		if (!value) return '';
		if (!value.trim()) return '';

		// Validate first
		if (!isValidCron(value)) {
			return 'Invalid';
		}

		try {
			// Use cronstrue to parse the cron expression
			// Configure it to use the user's time format preference
			const description = cronstrue.toString(value, {
				use24HourTimeFormat: !is12Hour,
				throwExceptionOnParseError: true,
				locale: 'en' // You can add user locale preference here if needed
			});
			return description;
		} catch (error) {
			return 'Invalid';
		}
	});

	// Generate hours array based on time format preference
	const hours = $derived(
		Array.from({ length: 24 }, (_, i) => ({
			value: String(i),
			label: is12Hour
				? i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`
				: i.toString().padStart(2, '0') + ':00'
		}))
	);

	const minutes = [
		{ value: '0', label: ':00' },
		{ value: '15', label: ':15' },
		{ value: '30', label: ':30' },
		{ value: '45', label: ':45' }
	];

	const daysOfWeek = [
		{ value: '1', label: 'Monday' },
		{ value: '2', label: 'Tuesday' },
		{ value: '3', label: 'Wednesday' },
		{ value: '4', label: 'Thursday' },
		{ value: '5', label: 'Friday' },
		{ value: '6', label: 'Saturday' },
		{ value: '0', label: 'Sunday' }
	];
</script>

<div class="flex items-center gap-2 flex-wrap">
	<!-- Schedule Type Selector -->
	<Select.Root type="single" value={scheduleType} onValueChange={handleScheduleTypeChange} {disabled}>
		<Select.Trigger class="w-[140px] h-9">
			<div class="flex items-center gap-2">
				{#if scheduleType === 'daily'}
					<Calendar class="w-4 h-4" />
					<span>Daily</span>
				{:else if scheduleType === 'weekly'}
					<CalendarDays class="w-4 h-4" />
					<span>Weekly</span>
				{:else}
					<Clock class="w-4 h-4" />
					<span>Custom</span>
				{/if}
			</div>
		</Select.Trigger>
		<Select.Content>
			<Select.Item value="daily">
				<div class="flex items-center gap-2">
					<Calendar class="w-4 h-4" />
					<span>Daily</span>
				</div>
			</Select.Item>
			<Select.Item value="weekly">
				<div class="flex items-center gap-2">
					<CalendarDays class="w-4 h-4" />
					<span>Weekly</span>
				</div>
			</Select.Item>
			<Select.Item value="custom">
				<div class="flex items-center gap-2">
					<Clock class="w-4 h-4" />
					<span>Custom</span>
				</div>
			</Select.Item>
		</Select.Content>
	</Select.Root>

	{#if scheduleType === 'daily' || scheduleType === 'weekly'}
		<!-- Time Selectors -->
		<span class="text-sm text-muted-foreground">at</span>
		<Select.Root type="single" value={hour} onValueChange={handleHourChange} {disabled}>
			<Select.Trigger class="w-[100px] h-9">
				<span>{hours.find((h: { value: string; label: string }) => h.value === hour)?.label || hour}</span>
			</Select.Trigger>
			<Select.Content>
				{#each hours as h}
					<Select.Item value={h.value} label={h.label} />
				{/each}
			</Select.Content>
		</Select.Root>
		<Select.Root type="single" value={minute} onValueChange={handleMinuteChange} {disabled}>
			<Select.Trigger class="w-[70px] h-9">
				<span>{minutes.find(m => m.value === minute)?.label || `:${minute}`}</span>
			</Select.Trigger>
			<Select.Content>
				{#each minutes as m}
					<Select.Item value={m.value} label={m.label} />
				{/each}
			</Select.Content>
		</Select.Root>

		{#if scheduleType === 'weekly'}
			<span class="text-sm text-muted-foreground">on</span>
			<Select.Root type="single" value={dayOfWeek} onValueChange={handleDayOfWeekChange} {disabled}>
				<Select.Trigger class="w-[110px] h-9">
					<span>{daysOfWeek.find(d => d.value === dayOfWeek)?.label || dayOfWeek}</span>
				</Select.Trigger>
				<Select.Content>
					{#each daysOfWeek as d}
						<Select.Item value={d.value} label={d.label} />
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}

	{:else}
		<!-- Custom cron input -->
		{@const readable = humanReadable()}
		{@const isInvalid = readable === 'Invalid'}
		<Input
			value={value}
			oninput={handleCustomCronInput}
			placeholder="0 3 * * *"
			class="h-9 font-mono flex-1 min-w-[200px] {isInvalid ? 'border-destructive focus-visible:ring-destructive' : ''}"
			{disabled}
		/>
	{/if}
</div>

<!-- Description area with fixed height -->
<div class="min-h-[20px] mt-1">
	{#if value}
		{@const readable = humanReadable()}
		{@const isInvalid = readable === 'Invalid'}
		<p class="text-xs {isInvalid ? 'text-destructive' : 'text-muted-foreground'}">
			{readable}
		</p>
	{/if}
</div>
