<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Loader2 } from 'lucide-svelte';
	import LogViewer from '../logs/LogViewer.svelte';

	// A plain display window for compose output. It owns none of the polling —
	// the parent pushes lines in as they arrive via readJobResponse's onLine callback
	// and flips `running` to false once the job settles.
	interface Props {
		open: boolean;
		title: string;
		lines: string[];
		running: boolean;
	}

	let { open = $bindable(false), title, lines, running }: Props = $props();

	function handleClose() {
		// Closing only hides this window. The operation it is watching keeps running
		// against the server regardless (watchJob's poll loop in sse-fetch.ts has no
		// abort mechanism and isn't meant to gain one here) — never stop it on close.
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-3xl h-[60vh] overflow-hidden flex flex-col">
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				{#if running}
					<Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
				{/if}
				{title}
			</Dialog.Title>
			<Dialog.Description>
				{running ? 'Running…' : 'Finished — output stays here to read.'}
			</Dialog.Description>
		</Dialog.Header>

		<LogViewer
			logs={lines.join('\n')}
			{title}
			autoRefresh={false}
			autoScroll={running}
			class="flex-1 min-h-0"
		/>

		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={handleClose}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
