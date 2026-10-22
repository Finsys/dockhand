<script lang="ts">
	import { Bell } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { m } from '$lib/paraglide/messages.js';
</script>

<div class="flex flex-col gap-6 p-6">
	<PageHeader icon={Bell} title={m.alerts_title()} />

	<div class="flex flex-col items-center justify-center py-12 text-muted-foreground">
		<Bell class="h-12 w-12 mb-4 opacity-50" />
		<p class="text-lg">{m.alerts_empty_title()}</p>
		<p class="text-sm">{m.alerts_empty_description()}</p>
	</div>
</div>
