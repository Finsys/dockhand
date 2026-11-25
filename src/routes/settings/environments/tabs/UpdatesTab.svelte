<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import TimezoneSelector from '$lib/components/TimezoneSelector.svelte';
	import VulnerabilityCriteriaSelector, { type VulnerabilityCriteria } from '$lib/components/VulnerabilityCriteriaSelector.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { CircleFadingArrowUp, CircleArrowUp, RefreshCw, Info, HelpCircle } from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		// Update check settings
		updateCheckLoading: boolean;
		updateCheckEnabled: boolean;
		updateCheckCron: string;
		updateCheckAutoUpdate: boolean;
		updateCheckVulnerabilityCriteria: VulnerabilityCriteria;
		minimumReleaseAgeHours: number;
		minimumReleaseAgeOverridden: boolean;
		minimumReleaseAgeOverride: boolean;
		scannerEnabled: boolean;
		// Timezone
		timezone: string;
	}

	let {
		updateCheckLoading,
		updateCheckEnabled = $bindable(),
		updateCheckCron = $bindable(),
		updateCheckAutoUpdate = $bindable(),
		updateCheckVulnerabilityCriteria = $bindable(),
		minimumReleaseAgeHours = $bindable(),
		minimumReleaseAgeOverridden,
		minimumReleaseAgeOverride = $bindable(),
		scannerEnabled,
		timezone = $bindable()
	}: Props = $props();

</script>

<!-- Scheduled Update Check Section -->
<div class="space-y-4">
	<div class="text-sm font-medium">
		{m.settings_envs_updates_title()}
	</div>
	<p class="text-xs text-muted-foreground">
		{m.settings_envs_updates_description()}
	</p>

	{#if updateCheckLoading}
		<div class="flex items-center justify-center py-4">
			<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<div class="flex items-start gap-2">
			<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green mt-0.5 shrink-0" />
			<div class="flex-1">
				<Label>{m.settings_envs_updates_enable()}</Label>
				<p class="text-xs text-muted-foreground">{m.settings_envs_updates_enable_hint()}</p>
			</div>
			<TogglePill bind:checked={updateCheckEnabled} />
		</div>

		{#if updateCheckEnabled}
			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>{m.settings_envs_schedule()}</Label>
					<CronEditor value={updateCheckCron} onchange={(cron) => updateCheckCron = cron} />
				</div>
			</div>

			<div class="flex items-start gap-2">
				<CircleArrowUp class="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
				<div class="flex-1">
					<Label>{m.settings_envs_updates_auto_update()}</Label>
					<p class="text-xs text-muted-foreground">
						{m.settings_envs_updates_auto_update_hint()}
					</p>
				</div>
				<TogglePill bind:checked={updateCheckAutoUpdate} />
			</div>

			{#if updateCheckAutoUpdate && scannerEnabled}
				<div class="flex items-start gap-2">
					<div class="w-4 shrink-0"></div>
					<div class="flex-1">
						<Label>{m.settings_envs_updates_block_vulnerable()}</Label>
						<p class="text-xs text-muted-foreground">
							{m.settings_envs_updates_block_vulnerable_hint()}
						</p>
					</div>
					<VulnerabilityCriteriaSelector
						bind:value={updateCheckVulnerabilityCriteria}
						class="w-[200px]"
					/>
				</div>
			{/if}

			<div class="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 flex items-start gap-2">
				<Info class="w-3 h-3 mt-0.5 shrink-0" />
				{#if updateCheckAutoUpdate}
					{#if scannerEnabled && updateCheckVulnerabilityCriteria !== 'never'}
						<span>{m.settings_envs_updates_info_scan()}</span>
					{:else}
						<span>{m.settings_envs_updates_info_auto()}</span>
					{/if}
				{:else}
					<span>{m.settings_envs_updates_info_notify()}</span>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<!-- Minimum image age -->
<div class="space-y-3 pt-4 border-t">
	<div class="text-sm font-medium flex items-center gap-2">
		{m.settings_envs_min_age_title()}
		<Tooltip.Provider delayDuration={100}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content side="right" sideOffset={8} class="!w-96 space-y-2">
						<p>{m.settings_envs_min_age_help_source()}</p>
						<p>{m.settings_envs_min_age_help_exempt()}</p>
						<p>{m.settings_envs_min_age_help_restart()}</p>
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		</Tooltip.Provider>
	</div>
	<p class="text-xs text-muted-foreground">{m.settings_envs_min_age_description()}</p>
	<div class="flex items-center justify-between gap-3">
		<div>
			<Label>{m.settings_envs_min_age_override()}</Label>
			<p class="text-xs text-muted-foreground">{m.settings_envs_min_age_override_hint()}</p>
		</div>
		<TogglePill bind:checked={minimumReleaseAgeOverride} disabled={minimumReleaseAgeOverridden} />
	</div>
	{#if minimumReleaseAgeOverride}
		<div class="flex items-center gap-3">
			<Label for="env-minimum-release-age" class="shrink-0">{m.settings_envs_min_age_hours()}</Label>
			<Input id="env-minimum-release-age" type="number" min="0" max="720" step="1" class="w-28" bind:value={minimumReleaseAgeHours} disabled={minimumReleaseAgeOverridden} />
			<span class="text-xs text-muted-foreground">{m.settings_envs_min_age_zero_hint()}</span>
		</div>
	{/if}
	{#if minimumReleaseAgeOverridden}
		<p class="text-xs text-muted-foreground">{m.settings_envs_min_age_set_by_env()}</p>
	{/if}
</div>

<!-- Timezone selector -->
<div class="space-y-2">
	<Label>{m.settings_envs_timezone()}</Label>
	<TimezoneSelector
		bind:value={timezone}
		id="edit-env-timezone"
	/>
	<p class="text-xs text-muted-foreground">
		{m.settings_envs_timezone_hint()}
	</p>
</div>
