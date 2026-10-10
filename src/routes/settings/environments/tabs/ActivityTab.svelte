<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import * as Select from '$lib/components/ui/select';
	import { Percent, HardDrive, TriangleAlert } from 'lucide-svelte';
	import { percentageOptionDisabled } from '$lib/utils/disk-percentage-support';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		collectActivity: boolean;
		collectMetrics: boolean;
		highlightChanges: boolean;
		diskWarningEnabled: boolean;
		diskWarningMode: 'percentage' | 'absolute';
		diskWarningThreshold: number;
		diskWarningThresholdGb: number;
		/** Whether this host reports a total to measure against; null = could not ask. */
		percentageSupported?: boolean | null;
		storageDriver?: string | null;
		/** The mode as loaded from the server, so switching away cannot lock it out. */
		storedDiskWarningMode?: 'percentage' | 'absolute' | null;
	}

	let {
		collectActivity = $bindable(),
		collectMetrics = $bindable(),
		highlightChanges = $bindable(),
		diskWarningEnabled = $bindable(),
		diskWarningMode = $bindable(),
		diskWarningThreshold = $bindable(),
		diskWarningThresholdGb = $bindable(),
		percentageSupported = null,
		storageDriver = null,
		storedDiskWarningMode = null
	}: Props = $props();

	// Only a definite "no" disables the option. An unreachable host stays unknown, so a
	// momentary outage never takes the setting away from somebody.
	const percentageDead = $derived(percentageSupported === false);
	// Worded here rather than by percentageUnsupportedNote(), whose English its test pins
	const percentageNote = $derived(
		storageDriver?.trim()
			? m.settings_envs_disk_pct_unsupported_driver({ driver: storageDriver.trim() })
			: m.settings_envs_disk_pct_unsupported()
	);
</script>

<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>{m.settings_envs_activity_collect()}</Label>
		<p class="text-xs text-muted-foreground">{m.settings_envs_activity_collect_hint()}</p>
	</div>
	<TogglePill bind:checked={collectActivity} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>{m.settings_envs_metrics_collect()}</Label>
		<p class="text-xs text-muted-foreground">{m.settings_envs_metrics_collect_hint()}</p>
	</div>
	<TogglePill bind:checked={collectMetrics} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>{m.settings_envs_highlight_changes()}</Label>
		<p class="text-xs text-muted-foreground">{m.settings_envs_highlight_changes_hint()}</p>
	</div>
	<TogglePill bind:checked={highlightChanges} />
</div>

<div class="border-t pt-4 mt-2 space-y-3">
	<div class="flex items-start gap-3">
		<div class="flex-1">
			<Label>{m.settings_envs_disk_warnings()}</Label>
			<p class="text-xs text-muted-foreground">{m.settings_envs_disk_warnings_hint()}</p>
		</div>
		<TogglePill bind:checked={diskWarningEnabled} />
	</div>

	{#if diskWarningEnabled}
		<div class="flex items-center gap-3">
			<Select.Root type="single" value={diskWarningMode} onValueChange={(v) => { if (v) diskWarningMode = v as 'percentage' | 'absolute'; }}>
				<Select.Trigger class="w-48">
					<div class="flex items-center gap-2">
						{#if diskWarningMode === 'percentage'}
							{#if percentageDead}
								<TriangleAlert class="w-3.5 h-3.5 text-[hsl(39_67%_69%)]" />
							{:else}
								<Percent class="w-3.5 h-3.5" />
							{/if}
							<span>{m.settings_envs_disk_mode_percentage()}</span>
						{:else}
							<HardDrive class="w-3.5 h-3.5" />
							<span>{m.settings_envs_disk_mode_absolute()}</span>
						{/if}
					</div>
				</Select.Trigger>
				<Select.Content>
					<Select.Item
						value="percentage"
						disabled={percentageOptionDisabled(percentageSupported, storedDiskWarningMode)}
					>
						<div class="flex flex-col gap-0.5">
							<div class="flex items-center gap-2">
								<Percent class="w-3.5 h-3.5" />
								{m.settings_envs_disk_mode_percentage()}
							</div>
							{#if percentageDead}
								<span class="text-xs text-muted-foreground">{m.settings_envs_disk_mode_percentage_unsupported()}</span>
							{/if}
						</div>
					</Select.Item>
					<Select.Item value="absolute">
						<div class="flex items-center gap-2">
							<HardDrive class="w-3.5 h-3.5" />
							{m.settings_envs_disk_mode_absolute()}
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

		{#if percentageDead && diskWarningMode === 'percentage'}
			<!-- A stored mode that cannot fire is worse than no warning: the setting
			     looks on, so nobody goes looking. Say it where the setting is. -->
			<div
				class="flex items-start gap-2 rounded-md border border-[hsl(39_67%_69%_/_0.3)] bg-[hsl(39_67%_69%_/_0.08)] px-3 py-2"
			>
				<TriangleAlert class="mt-0.5 w-4 h-4 shrink-0 text-[hsl(39_67%_69%)]" />
				<div class="flex-1 text-xs">
					<p class="text-[hsl(39_67%_69%)]">{percentageNote}</p>
					<button
						class="mt-1 underline underline-offset-2 text-muted-foreground hover:text-foreground"
						onclick={() => (diskWarningMode = 'absolute')}
					>
						{m.settings_envs_disk_switch_to_absolute()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>
