<script lang="ts">
	import { getLabelColors } from '$lib/utils/label-colors';
	import { labelColorOverrides } from '$lib/stores/label-colors';

	interface Props {
		labels?: string[];
		compact?: boolean;
		unified?: boolean;
	}

	let { labels = [], compact = false, unified = false }: Props = $props();
</script>

{#if labels && labels.length > 0}
	{#if compact}
		<div class="flex flex-wrap gap-0.5 pl-6 mt-0.5">
			{#each labels as label}
				{@const colors = getLabelColors(label, $labelColorOverrides)}
				<span class="px-1.5 py-0.5 text-[11px] rounded-sm font-medium leading-tight"
					style="background-color: {colors.bgColor}; color: {colors.color}">
					{label}
				</span>
			{/each}
		</div>
	{:else if unified}
		<div class="flex flex-wrap gap-0.5 px-4 -mt-0.5 mb-1">
			{#each labels as label}
				{@const colors = getLabelColors(label, $labelColorOverrides)}
				<span class="px-1.5 py-0.5 text-[11px] rounded-sm font-medium leading-tight"
					style="background-color: {colors.bgColor}; color: {colors.color}">
					{label}
				</span>
			{/each}
		</div>
	{:else}
		<div class="flex flex-wrap gap-0.5 pl-6 pr-4 -mt-8 -mb-4">
			{#each labels as label}
				{@const colors = getLabelColors(label, $labelColorOverrides)}
				<span class="px-1.5 py-0.5 text-[11px] rounded-sm font-medium leading-tight"
					style="background-color: {colors.bgColor}; color: {colors.color}">
					{label}
				</span>
			{/each}
		</div>
	{/if}
{/if}
