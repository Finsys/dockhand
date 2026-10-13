<script lang="ts">
	import {
		ShieldCheck,
		Activity,
		WifiOff,
		CircleArrowUp,
		CircleFadingArrowUp
	} from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		online: boolean;
		scannerEnabled: boolean;
		collectActivity: boolean;
		updateCheckEnabled?: boolean;
		updateCheckAutoUpdate?: boolean;
		compact?: boolean;
	}

	let { online, scannerEnabled, collectActivity, updateCheckEnabled = false, updateCheckAutoUpdate = false, compact = false }: Props = $props();
</script>

<div class="{compact ? 'flex items-center gap-1 shrink-0' : 'flex items-center gap-1.5 shrink-0'}">
	{#if updateCheckEnabled}
		<span title={updateCheckAutoUpdate ? m.dashboard_status_auto_update() : m.dashboard_status_update_check()}>
			{#if updateCheckAutoUpdate}
				<CircleArrowUp class="{compact ? 'w-3.5 h-3.5 glow-green-sm' : 'w-4 h-4 glow-green'} text-green-500" />
			{:else}
				<CircleFadingArrowUp class="{compact ? 'w-3.5 h-3.5 glow-green-sm' : 'w-4 h-4 glow-green'} text-green-500" />
			{/if}
		</span>
	{/if}
	{#if scannerEnabled}
		<span title={m.dashboard_status_vulnerability_scanning()}>
			<ShieldCheck class="{compact ? 'w-3.5 h-3.5 glow-green-sm' : 'w-4 h-4 glow-green'} text-green-500" />
		</span>
	{/if}
	{#if collectActivity}
		<span title={m.dashboard_status_activity_collection()}>
			<Activity class="{compact ? 'w-3.5 h-3.5 glow-amber-sm' : 'w-4 h-4 glow-amber'} text-amber-500" />
		</span>
	{/if}
	{#if !online && compact}
		<span title={m.dashboard_offline()}>
			<WifiOff class="w-3.5 h-3.5 text-red-500 shrink-0" />
		</span>
	{/if}
</div>
