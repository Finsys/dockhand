<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import * as Select from '$lib/components/ui/select';
	import { Percent, HardDrive } from 'lucide-svelte';

	interface Props {
		collectActivity: boolean;
		collectMetrics: boolean;
		highlightChanges: boolean;
		diskWarningEnabled: boolean;
		diskWarningMode: 'percentage' | 'absolute';
		diskWarningThreshold: number;
		diskWarningThresholdGb: number;
	}

	let {
		collectActivity = $bindable(),
		collectMetrics = $bindable(),
		highlightChanges = $bindable(),
		diskWarningEnabled = $bindable(),
		diskWarningMode = $bindable(),
		diskWarningThreshold = $bindable(),
		diskWarningThresholdGb = $bindable()
	}: Props = $props();
</script>

<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Collect container activity</Label>
		<p class="text-xs text-muted-foreground">Track container events (start, stop, restart, etc.) from this environment in real-time</p>
	</div>
	<TogglePill bind:checked={collectActivity} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Collect system metrics</Label>
		<p class="text-xs text-muted-foreground">Collect CPU and memory usage statistics from this environment</p>
	</div>
	<TogglePill bind:checked={collectMetrics} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Highlight value changes</Label>
		<p class="text-xs text-muted-foreground">Show amber glow when container values change in the containers list</p>
	</div>
	<TogglePill bind:checked={highlightChanges} />
</div>

<div class="border-t pt-4 mt-2 space-y-3">
	<div class="flex items-start gap-3">
		<div class="flex-1">
			<Label>Disk space warnings</Label>
			<p class="text-xs text-muted-foreground">Send notifications when Docker disk usage exceeds the threshold</p>
		</div>
		<TogglePill bind:checked={diskWarningEnabled} />
	</div>

	{#if diskWarningEnabled}
		<div class="flex items-center gap-3">
			<Select.Root type="single" value={diskWarningMode} onValueChange={(v) => { if (v) diskWarningMode = v as 'percentage' | 'absolute'; }}>
				<Select.Trigger class="w-48">
					<div class="flex items-center gap-2">
						{#if diskWarningMode === 'percentage'}
							<Percent class="w-3.5 h-3.5" />
							<span>Percentage</span>
						{:else}
							<HardDrive class="w-3.5 h-3.5" />
							<span>Absolute (GB)</span>
						{/if}
					</div>
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="percentage">
						<div class="flex items-center gap-2">
							<Percent class="w-3.5 h-3.5" />
							Percentage
						</div>
					</Select.Item>
					<Select.Item value="absolute">
						<div class="flex items-center gap-2">
							<HardDrive class="w-3.5 h-3.5" />
							Absolute (GB)
						</div>
					</Select.Item>
				</Select.Content>
			</Select.Root>

			{#if diskWarningMode === 'percentage'}
				<Input
					type="number"
					min={1}
					max={100}
					bind:value={diskWarningThreshold}
					class="w-24"
				/>
				<span class="text-sm text-muted-foreground">%</span>
			{:else}
				<Input
					type="number"
					min={1}
					bind:value={diskWarningThresholdGb}
					class="w-24"
				/>
				<span class="text-sm text-muted-foreground">GB</span>
			{/if}
		</div>
	{/if}
</div>
