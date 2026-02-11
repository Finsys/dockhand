<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';

	interface Props {
		collectActivity: boolean;
		collectMetrics: boolean;
		highlightChanges: boolean;
	}

	let {
		collectActivity = $bindable(),
		collectMetrics = $bindable(),
		highlightChanges = $bindable()
	}: Props = $props();
</script>

<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Collect container activity</Label>
		<p class="text-xs text-muted-foreground">Track container events (start, stop, restart, etc.) from this environment in real-time</p>
	</div>
	<TogglePill bind:checked={collectActivity} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Collect system metrics</Label>
		<p class="text-xs text-muted-foreground">Collect CPU and memory usage statistics from this environment</p>
	</div>
	<TogglePill bind:checked={collectMetrics} />
</div>
<div class="flex items-start gap-3">
	<div class="flex-1">
		<Label>Highlight value changes</Label>
		<p class="text-xs text-muted-foreground">Show amber glow when container values change in the containers list</p>
	</div>
	<TogglePill bind:checked={highlightChanges} />
</div>
