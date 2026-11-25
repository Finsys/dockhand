<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import { RefreshCw, Info, Trash2 } from 'lucide-svelte';
	import { formatDateTime } from '$lib/stores/settings';
	import { formatBytes } from '$lib/utils/format';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		// Image prune settings
		imagePruneLoading: boolean;
		imagePruneEnabled: boolean;
		imagePruneCron: string;
		imagePruneMode: 'dangling' | 'all';
		imagePruneLastPruned?: string;
		imagePruneLastResult?: { spaceReclaimed?: number; imagesRemoved: number };
		// Build cache prune settings
		buildCachePruneLoading: boolean;
		buildCachePruneEnabled: boolean;
		buildCachePruneCron: string;
		buildCachePruneMode: 'dangling' | 'all';
		buildCachePruneUntil: string;
		buildCachePruneReservedGiB: string;
		buildCachePruneLastPruned?: string;
		buildCachePruneLastResult?: { spaceReclaimed?: number; cachesDeleted: number };
	}

	let {
		imagePruneLoading,
		imagePruneEnabled = $bindable(),
		imagePruneCron = $bindable(),
		imagePruneMode = $bindable(),
		imagePruneLastPruned,
		imagePruneLastResult,
		buildCachePruneLoading,
		buildCachePruneEnabled = $bindable(),
		buildCachePruneCron = $bindable(),
		buildCachePruneMode = $bindable(),
		buildCachePruneUntil = $bindable(),
		buildCachePruneReservedGiB = $bindable(),
		buildCachePruneLastPruned,
		buildCachePruneLastResult
	}: Props = $props();
</script>

<!-- Image Pruning Section -->
<div class="space-y-4">
	<div class="text-sm font-medium">
		{m.settings_envs_prune_title()}
	</div>
	<p class="text-xs text-muted-foreground">
		{m.settings_envs_prune_description()}
	</p>

	{#if imagePruneLoading}
		<div class="flex items-center justify-center py-4">
			<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<div class="flex items-start gap-2">
			<Trash2 class="w-4 h-4 text-amber-500 glow-amber mt-0.5 shrink-0" />
			<div class="flex-1">
				<Label>{m.settings_envs_prune_enable()}</Label>
				<p class="text-xs text-muted-foreground">{m.settings_envs_prune_enable_hint()}</p>
			</div>
			<TogglePill bind:checked={imagePruneEnabled} />
		</div>

		{#if imagePruneEnabled}
			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>{m.settings_envs_schedule()}</Label>
					<CronEditor value={imagePruneCron} onchange={(cron) => imagePruneCron = cron} />
				</div>
			</div>

			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>{m.settings_envs_prune_mode()}</Label>
					<Select.Root type="single" bind:value={imagePruneMode}>
						<Select.Trigger class="w-full">
							{imagePruneMode === 'dangling' ? m.settings_envs_prune_mode_dangling() : m.settings_envs_prune_mode_all()}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="dangling">{m.settings_envs_prune_mode_dangling()}</Select.Item>
							<Select.Item value="all">{m.settings_envs_prune_mode_all()}</Select.Item>
						</Select.Content>
					</Select.Root>
					<p class="text-xs text-muted-foreground">
						{#if imagePruneMode === 'dangling'}
							{m.settings_envs_prune_mode_dangling_hint()}
						{:else}
							{m.settings_envs_prune_mode_all_hint()}
						{/if}
					</p>
				</div>
			</div>

			{#if imagePruneLastPruned}
				<div class="flex items-start gap-2">
					<div class="w-4 shrink-0"></div>
					<div class="flex-1">
						<p class="text-xs text-muted-foreground">
							{m.settings_envs_prune_last_pruned({ date: formatDateTime(imagePruneLastPruned) })}
							{#if imagePruneLastResult}
								- {imagePruneLastResult.spaceReclaimed === undefined
									? m.settings_envs_prune_last_result_count({ count: imagePruneLastResult.imagesRemoved })
									: m.settings_envs_prune_last_result({ count: imagePruneLastResult.imagesRemoved, size: formatBytes(imagePruneLastResult.spaceReclaimed) })}
							{/if}
						</p>
					</div>
				</div>
			{/if}

			<div class="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 flex items-start gap-2">
				<Info class="w-3 h-3 mt-0.5 shrink-0" />
				<span>{m.settings_envs_prune_in_use_note()}</span>
			</div>
		{/if}
	{/if}
</div>

<!-- Build Cache Pruning Section -->
<div class="space-y-4 pt-4 border-t">
	<div class="text-sm font-medium">
		{m.settings_envs_build_cache_prune_title()}
	</div>
	<p class="text-xs text-muted-foreground">
		{m.settings_envs_build_cache_prune_description()}
	</p>

	{#if buildCachePruneLoading}
		<div class="flex items-center justify-center py-4">
			<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<div class="flex items-start gap-2">
			<Trash2 class="w-4 h-4 text-violet-500 mt-0.5 shrink-0" />
			<div class="flex-1">
				<Label>{m.settings_envs_build_cache_prune_enable()}</Label>
				<p class="text-xs text-muted-foreground">{m.settings_envs_build_cache_prune_enable_hint()}</p>
			</div>
			<TogglePill bind:checked={buildCachePruneEnabled} />
		</div>

		{#if buildCachePruneEnabled}
			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>{m.settings_envs_schedule()}</Label>
					<CronEditor value={buildCachePruneCron} onchange={(cron) => buildCachePruneCron = cron} />
				</div>
			</div>

			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 space-y-2">
					<Label>{m.settings_envs_prune_mode()}</Label>
					<Select.Root type="single" bind:value={buildCachePruneMode}>
						<Select.Trigger class="w-full">
							{buildCachePruneMode === 'dangling' ? m.settings_envs_prune_mode_dangling() : m.settings_envs_prune_mode_all()}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="dangling">{m.settings_envs_prune_mode_dangling()}</Select.Item>
							<Select.Item value="all">{m.settings_envs_prune_mode_all()}</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>

			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<div class="flex-1 grid grid-cols-2 gap-2">
					<div class="space-y-1.5">
						<Label>{m.images_build_cache_until_label()}</Label>
						<Input bind:value={buildCachePruneUntil} placeholder="336h" />
					</div>
					<div class="space-y-1.5">
						<Label>{m.images_build_cache_reserved_label()}</Label>
						<Input type="number" min="0" step="0.5" bind:value={buildCachePruneReservedGiB} placeholder="0" />
					</div>
				</div>
			</div>
			<div class="flex items-start gap-2">
				<div class="w-4 shrink-0"></div>
				<p class="flex-1 text-xs text-muted-foreground">{m.images_build_cache_fields_hint()}</p>
			</div>

			{#if buildCachePruneMode === 'all'}
				<div class="flex items-start gap-2">
					<div class="w-4 shrink-0"></div>
					<div class="flex-1 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md p-2 flex items-start gap-2">
						<Info class="w-3 h-3 mt-0.5 shrink-0" />
						<span>{m.images_build_cache_all_warning()}</span>
					</div>
				</div>
			{/if}

			{#if buildCachePruneLastPruned}
				<div class="flex items-start gap-2">
					<div class="w-4 shrink-0"></div>
					<div class="flex-1">
						<p class="text-xs text-muted-foreground">
							{m.settings_envs_prune_last_pruned({ date: formatDateTime(buildCachePruneLastPruned) })}
							{#if buildCachePruneLastResult && buildCachePruneLastResult.spaceReclaimed !== undefined}
								- {formatBytes(buildCachePruneLastResult.spaceReclaimed)}
							{/if}
						</p>
					</div>
				</div>
			{/if}
		{/if}
	{/if}
</div>
