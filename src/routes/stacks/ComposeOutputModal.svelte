<script lang="ts">
	import { onMount } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Loader2 } from 'lucide-svelte';
	import LogViewer from '../logs/LogViewer.svelte';
	import { formatRunStatus } from '$lib/utils/run-status';

	// A plain display window for compose output. It owns none of the polling —
	// the parent pushes lines in as they arrive via readJobResponse's onLine callback
	// and flips `running` to false once the job settles, at which point it also
	// supplies `ok`/`ms`/`exitCode` for the status line below.
	interface Props {
		open: boolean;
		title: string;
		lines: string[];
		running: boolean;
		ok?: boolean;
		ms?: number;
		exitCode?: number;
	}

	let { open = $bindable(false), title, lines, running, ok, ms, exitCode }: Props = $props();

	let statusLine = $derived(formatRunStatus({ running, ok, ms, exitCode }));

	// This modal is opened straight from the stack list, with no editor in scope to
	// borrow a theme from (unlike the docked panel and Deploys tab inside StackModal,
	// which both follow `dockhand-editor-theme`). Its Dialog.Content already tracks
	// the app-wide light/dark switch via bg-background, so the log viewer inside
	// follows the same switch instead of introducing a third, unrelated toggle.
	// Same read-once-on-mount + system-preference-fallback pattern as
	// ComposeGraphViewer's graphTheme -- this component is mounted once at the page
	// root and toggled via `open`, so onMount runs once per page load.
	let outputTheme = $state<'light' | 'dark'>('dark');

	onMount(() => {
		const appTheme = localStorage.getItem('theme');
		if (appTheme === 'dark' || appTheme === 'light') {
			outputTheme = appTheme;
		} else {
			outputTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
		}
	});

	function handleClose() {
		// Closing only hides this window. The operation it is watching keeps running
		// against the server regardless (watchJob's poll loop in sse-fetch.ts has no
		// abort mechanism and isn't meant to gain one here) — never stop it on close.
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<!-- Build output is line-oriented and often wide (BuildKit step lines, image digests).
	     A narrow window forces wrapping or horizontal scrolling on every other line, so this
	     one is sized generously -- but clamped to the viewport so it never overflows on a
	     laptop screen: min() picks the smaller of the two, and the 4rem keeps a margin. -->
	<Dialog.Content class="max-w-[min(90rem,calc(100vw-4rem))] h-[85vh] overflow-hidden flex flex-col">
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				{#if running}
					<Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
				{/if}
				{title}
			</Dialog.Title>
			<Dialog.Description>
				{statusLine}
			</Dialog.Description>
		</Dialog.Header>

		<LogViewer
			logs={lines.join('\n')}
			{title}
			autoRefresh={false}
			autoScroll={running}
			class="flex-1 min-h-0"
			theme={outputTheme}
		/>

		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={handleClose}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
