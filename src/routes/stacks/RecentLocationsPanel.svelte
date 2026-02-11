<script lang="ts">
	import { FolderOpen, X, Home } from 'lucide-svelte';

	interface Props {
		currentPath?: string | null;
		onSelect: (path: string) => void;
	}

	let {
		currentPath = null,
		onSelect
	}: Props = $props();

	let locations = $state<string[]>([]);
	let defaultBasePath = $state<string | null>(null);

	// Load recent locations and default base path on mount
	$effect(() => {
		loadLocations();
		loadDefaultBasePath();
	});

	async function loadDefaultBasePath() {
		try {
			const response = await fetch('/api/stacks/base-path');
			if (response.ok) {
				const data = await response.json();
				defaultBasePath = data.basePath;
			}
		} catch (e) {
			console.error('Failed to load default base path:', e);
		}
	}

	async function loadLocations() {
		try {
			const response = await fetch('/api/settings/general');
			if (response.ok) {
				const settings = await response.json();
				locations = settings.externalStackPaths || [];
			}
		} catch (e) {
			console.error('Failed to load recent locations:', e);
		}
	}

	async function saveLocations(newLocations: string[]) {
		try {
			await fetch('/api/settings/general', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ externalStackPaths: newLocations })
			});
		} catch (e) {
			console.error('Failed to save recent locations:', e);
		}
	}

	async function handleRemove(path: string) {
		const newLocations = locations.filter(p => p !== path);
		locations = newLocations;
		await saveLocations(newLocations);
	}

	export async function addLocation(path: string) {
		if (!path || locations.includes(path)) return;
		const newLocations = [path, ...locations].slice(0, 10);
		locations = newLocations;
		await saveLocations(newLocations);
	}

	export function getFirstLocation(): string | null {
		return locations[0] || null;
	}
</script>

<div class="w-56 border-r p-3 overflow-y-auto shrink-0">
	<h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Locations</h3>
	<div class="space-y-1">
		<!-- Default Dockhand location (always shown, not removable) -->
		{#if defaultBasePath}
			<button
				type="button"
				class="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted text-left {currentPath === defaultBasePath ? 'bg-muted' : ''}"
				onclick={() => onSelect(defaultBasePath!)}
			>
				<Home class="w-4 h-4 shrink-0 text-sky-500" />
				<span class="truncate" title={defaultBasePath}>Dockhand default</span>
			</button>
		{/if}

		<!-- Recent locations -->
		{#each locations.filter(l => l !== defaultBasePath) as location}
			<div class="group flex items-center gap-1">
				<button
					type="button"
					class="flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted text-left truncate {currentPath === location ? 'bg-muted' : ''}"
					onclick={() => onSelect(location)}
				>
					<FolderOpen class="w-4 h-4 shrink-0 text-muted-foreground" />
					<span class="truncate" title={location}>{location.split('/').pop() || location}</span>
				</button>
				<button
					type="button"
					class="p-1 opacity-0 group-hover:opacity-100 hover:bg-muted rounded transition-opacity"
					onclick={() => handleRemove(location)}
					title="Remove from recent"
				>
					<X class="w-3 h-3 text-muted-foreground" />
				</button>
			</div>
		{/each}

		{#if !defaultBasePath && locations.length === 0}
			<p class="text-xs text-muted-foreground italic px-2">
				No locations yet. Browse folders to add them here.
			</p>
		{/if}
	</div>
</div>
