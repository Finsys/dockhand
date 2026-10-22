<script lang="ts">
	import { Activity } from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		today: number;
		total: number;
	}

	let { today, total }: Props = $props();
</script>

{#if total > 0}
	<div class="flex items-center justify-between text-xs pt-1 border-t border-border/50">
		<span class="flex items-center gap-1 text-muted-foreground">
			<Activity class="w-3 h-3" /> {m.dashboard_events()}
		</span>
		<span class="font-medium">
			{m.dashboard_events_today({ count: today })} <span class="text-muted-foreground">/ {m.dashboard_events_total({ count: total })}</span>
		</span>
	</div>
{/if}
