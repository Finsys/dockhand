<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { iconMap, getIconComponent } from '$lib/utils/icons';

	interface Props {
		value: string;
		onchange: (icon: string) => void;
	}

	let { value, onchange }: Props = $props();

	let searchQuery = $state('');
	let open = $state(false);

	const allIcons = Object.keys(iconMap);

	let filteredIcons = $derived(
		searchQuery.trim()
			? allIcons.filter(name => name.toLowerCase().includes(searchQuery.toLowerCase()))
			: allIcons
	);

	function selectIcon(iconName: string) {
		onchange(iconName);
		open = false;
	}

	// Get the current icon component
	let CurrentIcon = $derived(getIconComponent(value || 'globe'));
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		<Button variant="outline" size="sm" class="h-9 w-9 p-0" type="button">
			<CurrentIcon class="h-4 w-4" />
		</Button>
	</Popover.Trigger>
	<Popover.Content class="w-80 p-3 z-[200]" align="start">
		<div class="space-y-3">
			<Input
				bind:value={searchQuery}
				placeholder="Search icons..."
				class="h-8"
			/>
			<div class="grid grid-cols-8 gap-1 max-h-48 overflow-y-auto">
				{#each filteredIcons as iconName}
					{@const IconComponent = iconMap[iconName]}
					<button
						type="button"
						onclick={() => selectIcon(iconName)}
						class="p-2 rounded hover:bg-muted transition-colors {value === iconName ? 'bg-primary/10 ring-1 ring-primary' : ''}"
						title={iconName}
					>
						<IconComponent class="h-4 w-4" />
					</button>
				{/each}
			</div>
			{#if filteredIcons.length === 0}
				<p class="text-sm text-muted-foreground text-center py-2">No icons found</p>
			{/if}
		</div>
	</Popover.Content>
</Popover.Root>
