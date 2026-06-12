<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';

	interface Props {
		enabled: boolean;
		cronExpression: string;
		onenablechange?: (enabled: boolean) => void;
		oncronchange?: (cron: string) => void;
	}

	let {
		enabled = $bindable(),
		cronExpression = $bindable(),
		onenablechange,
		oncronchange
	}: Props = $props();
</script>

<div class="space-y-3">
	<div class="flex items-center gap-3">
		<Label class="text-xs font-normal">Enable scheduled container start</Label>
		<TogglePill bind:checked={enabled} onchange={(value) => onenablechange?.(value)} />
	</div>

	{#if enabled}
		<CronEditor
			value={cronExpression}
			onchange={(cron) => {
				cronExpression = cron;
				oncronchange?.(cron);
			}}
		/>

		<p class="text-xs text-muted-foreground">
			Start this container on a schedule. The container should exit on its own after completing its work.
		</p>
	{/if}
</div>
