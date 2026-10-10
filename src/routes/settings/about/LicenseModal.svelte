<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { ScrollText, X } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
	}

	let { open = $bindable() }: Props = $props();

	let content = $state('');
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function fetchLicense() {
		try {
			const res = await fetch('/api/legal/license');
			if (!res.ok) throw new Error(m.settings_about_terms_load_failed());
			const data = await res.json();
			content = data.content;
		} catch (e) {
			error = e instanceof Error ? e.message : m.settings_about_unknown_error();
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open && !content && !error) {
			fetchLicense();
		}
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-4xl h-[80vh] flex flex-col">
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				<ScrollText class="w-5 h-5" />
				{m.settings_about_terms_title()}
			</Dialog.Title>
		</Dialog.Header>

		<div class="flex-1 min-h-0 overflow-hidden">
			{#if loading}
				<div class="flex items-center justify-center h-full">
					<div class="text-sm text-muted-foreground">{m.settings_about_loading()}</div>
				</div>
			{:else if error}
				<div class="flex items-center justify-center h-full">
					<div class="text-sm text-destructive">{error}</div>
				</div>
			{:else}
				<pre class="h-full overflow-y-auto text-xs font-mono whitespace-pre-wrap bg-muted/30 p-4 rounded-lg">{content}</pre>
			{/if}
		</div>

		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={() => open = false}>
				{m.ui_close()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
