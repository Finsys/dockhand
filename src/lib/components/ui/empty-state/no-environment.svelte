<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { EmptyState } from '$lib/components/ui/empty-state';
	import { Server, Settings } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { environments } from '$lib/stores/environment';

	const hasEnvironments = $derived($environments.length > 0);
</script>

{#if hasEnvironments}
	<EmptyState
		icon={Server}
		title="No environment selected"
		description="Select a Docker environment from the dropdown to get started"
	/>
{:else}
	<EmptyState
		icon={Server}
		title="No environment configured"
		description="Add a Docker environment in Settings to get started"
	>
		<Button variant="secondary" onclick={() => goto('/settings?tab=environments')}>
			<Settings class="w-4 h-4" />
			Go to Settings
		</Button>
	</EmptyState>
{/if}
