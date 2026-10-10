<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { EmptyState } from '$lib/components/ui/empty-state';
	import { Server, Settings } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { environments } from '$lib/stores/environment';
	import { m } from '$lib/paraglide/messages.js';

	const hasEnvironments = $derived($environments.length > 0);
</script>

{#if hasEnvironments}
	<EmptyState
		icon={Server}
		title={m.emptystate_no_environment_selected_title()}
		description={m.emptystate_no_environment_selected_description()}
	/>
{:else}
	<EmptyState
		icon={Server}
		title={m.emptystate_no_environment_configured_title()}
		description={m.emptystate_no_environment_configured_description()}
	>
		<Button variant="secondary" onclick={() => goto('/settings?tab=environments')}>
			<Settings class="w-4 h-4" />
			{m.dashboard_go_to_settings()}
		</Button>
	</EmptyState>
{/if}
