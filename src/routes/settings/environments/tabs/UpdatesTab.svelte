<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import TimezoneSelector from '$lib/components/TimezoneSelector.svelte';
	import VulnerabilityCriteriaSelector, { type VulnerabilityCriteria } from '$lib/components/VulnerabilityCriteriaSelector.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { CircleFadingArrowUp, CircleArrowUp, RefreshCw, Info, Trash2, HelpCircle } from 'lucide-svelte';
	import { formatDateTime } from '$lib/stores/settings';
	import { formatBytes } from '$lib/utils/format';

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
		// Image prune settings
		imagePruneLoading: boolean;
		imagePruneEnabled: boolean;
		imagePruneCron: string;
		imagePruneMode: 'dangling' | 'all';
		imagePruneLastPruned?: string;
		imagePruneLastResult?: { spaceReclaimed: number; imagesRemoved: number };
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
		imagePruneLoading,
		imagePruneEnabled = $bindable(),
		imagePruneCron = $bindable(),
		imagePruneMode = $bindable(),
		imagePruneLastPruned,
		imagePruneLastResult,
		timezone = $bindable()
	}: Props = $props();

</script>

<!-- Scheduled Update Check Section -->
<div class="space-y-4">
	<div class="text-sm font-medium">
		Scheduled update check
	</div>
	<p class="text-xs text-muted-foreground">
		Periodically check all containers in this environment for available image updates.
	</p>

	{#if updateCheckLoading}
		<div class="flex items-center justify-center py-4">
			<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<div class="flex items-start gap-2">
			<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green mt-0.5 shrink-0" />
			<div class="flex-1">
				<Label>Enable scheduled update check</Label>
				<p class="text-xs text-muted-foreground">Automatically check for container updates on a schedule</p>
			</div>
			<TogglePill bind:checked={updateCheckEnabled} />
		</div>

		{#if updateCheckEnabled}
			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>Schedule</Label>
					<CronEditor value={updateCheckCron} onchange={(cron) => updateCheckCron = cron} />
				</div>
			</div>

			<div class="flex items-start gap-2">
				<CircleArrowUp class="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
				<div class="flex-1">
					<Label>Automatically update containers</Label>
					<p class="text-xs text-muted-foreground">
						When enabled, containers will be updated automatically when new images are found.
						When disabled, only sends notifications about available updates.
					</p>
				</div>
				<TogglePill bind:checked={updateCheckAutoUpdate} />
			</div>

			{#if updateCheckAutoUpdate && scannerEnabled}
				<div class="flex items-start gap-2">
					<div class="w-4 shrink-0"></div>
					<div class="flex-1">
						<Label>Block updates with vulnerabilities</Label>
						<p class="text-xs text-muted-foreground">
							Block auto-updates if the new image has vulnerabilities exceeding this criteria
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
						<span>New images are pulled to a temporary tag, scanned, then deployed if they pass the vulnerability check. Blocked images are deleted automatically.</span>
					{:else}
						<span>Containers will be updated automatically when new images are available.</span>
					{/if}
				{:else}
					<span>You'll receive notifications when updates are available. Containers won't be modified.</span>
				{/if}
			</div>
		{/if}
	{/if}
</div>

<!-- Minimum image age -->
<div class="space-y-3 pt-4 border-t">
	<div class="text-sm font-medium flex items-center gap-2">
		Minimum image age
		<Tooltip.Provider delayDuration={100}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content side="right" sideOffset={8} class="!w-96 space-y-2">
						<p>The age comes from the image's creation time in the registry, which records the build rather than the publication. When the registry gives no usable time, Dockhand counts from when it first saw that digest.</p>
						<p>Manual pulls warn and proceed; stack deployments, including scheduled Git ones, are exempt.</p>
						<p>A newer image restarts the wait on itself, so a project publishing faster than this age never updates automatically.</p>
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		</Tooltip.Provider>
	</div>
	<p class="text-xs text-muted-foreground">Hold automatic container updates until a new image has been out for a while.</p>
	<div class="flex items-center justify-between gap-3">
		<div>
			<Label>Override global cooldown</Label>
			<p class="text-xs text-muted-foreground">When off, this environment uses the global setting.</p>
		</div>
		<TogglePill bind:checked={minimumReleaseAgeOverride} disabled={minimumReleaseAgeOverridden} />
	</div>
	{#if minimumReleaseAgeOverride}
		<div class="flex items-center gap-3">
			<Label for="env-minimum-release-age" class="shrink-0">Hours</Label>
			<Input id="env-minimum-release-age" type="number" min="0" max="720" step="1" class="w-28" bind:value={minimumReleaseAgeHours} disabled={minimumReleaseAgeOverridden} />
			<span class="text-xs text-muted-foreground">0 disables the cooldown</span>
		</div>
	{/if}
	{#if minimumReleaseAgeOverridden}
		<p class="text-xs text-muted-foreground">Set by MINIMUM_RELEASE_AGE_HOURS on the Dockhand server.</p>
	{/if}
</div>

<!-- Image Pruning Section -->
<div class="space-y-4 pt-4 border-t">
	<div class="text-sm font-medium">
		Automatic image pruning
	</div>
	<p class="text-xs text-muted-foreground">
		Automatically remove unused Docker images on a schedule to free up disk space.
	</p>

	{#if imagePruneLoading}
		<div class="flex items-center justify-center py-4">
			<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<div class="flex items-start gap-2">
			<Trash2 class="w-4 h-4 text-amber-500 glow-amber mt-0.5 shrink-0" />
			<div class="flex-1">
				<Label>Enable automatic image pruning</Label>
				<p class="text-xs text-muted-foreground">Automatically remove unused images on a schedule</p>
			</div>
			<TogglePill bind:checked={imagePruneEnabled} />
		</div>

		{#if imagePruneEnabled}
			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>Schedule</Label>
					<CronEditor value={imagePruneCron} onchange={(cron) => imagePruneCron = cron} />
				</div>
			</div>

			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>Prune mode</Label>
					<Select.Root type="single" bind:value={imagePruneMode}>
						<Select.Trigger class="w-full">
							{imagePruneMode === 'dangling' ? 'Dangling images only' : 'All unused images'}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="dangling">Dangling images only</Select.Item>
							<Select.Item value="all">All unused images</Select.Item>
						</Select.Content>
					</Select.Root>
					<p class="text-xs text-muted-foreground">
						{#if imagePruneMode === 'dangling'}
							Only removes untagged image layers (safest option)
						{:else}
							Removes all images not used by any container (more aggressive)
						{/if}
					</p>
				</div>
			</div>

			{#if imagePruneLastPruned}
				<div class="flex items-start gap-2">
					<div class="w-4 shrink-0"></div>
					<div class="flex-1">
						<p class="text-xs text-muted-foreground">
							Last pruned: {formatDateTime(imagePruneLastPruned)}
							{#if imagePruneLastResult}
								- {imagePruneLastResult.imagesRemoved} images removed, {formatBytes(imagePruneLastResult.spaceReclaimed)} reclaimed
							{/if}
						</p>
					</div>
				</div>
			{/if}

			<div class="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 flex items-start gap-2">
				<Info class="w-3 h-3 mt-0.5 shrink-0" />
				<span>Images in use by running or stopped containers will never be removed.</span>
			</div>
		{/if}
	{/if}
</div>

<!-- Timezone selector -->
<div class="space-y-2">
	<Label>Timezone</Label>
	<TimezoneSelector
		bind:value={timezone}
		id="edit-env-timezone"
	/>
	<p class="text-xs text-muted-foreground">
		Used for scheduling auto-updates, git syncs, and image pruning
	</p>
</div>
