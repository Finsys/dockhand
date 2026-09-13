<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import DeployOutputHeader from './DeployOutputHeader.svelte';
	import DeploySummaryBar from './DeploySummaryBar.svelte';
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
		// Optional stack identity so the header shows the stack's icon (matches the list).
		stackName?: string;
		stackIcon?: string | null;
		envId?: number | null;
		ok?: boolean;
		ms?: number;
		exitCode?: number;
	}

	let { open = $bindable(false), title, lines, running, ok, ms, exitCode, stackName, stackIcon = null, envId = null }: Props = $props();

	let statusLine = $derived(formatRunStatus({ running, ok, ms, exitCode }));

	// The header takes a verb + name separately (so the stack icon sits between them);
	// split the stackName off the title, and map running/ok to the shared state enum.
	let headerVerb = $derived(
		stackName && title.endsWith(stackName) ? title.slice(0, -stackName.length).trim() : title
	);
	let headerState = $derived<'running' | 'complete' | 'error'>(
		running ? 'running' : ok === false ? 'error' : 'complete'
	);

	// Compose output ends abruptly on the last state line; once the run settles, append
	// a colored closing line (green on success, red on failure) so the end state reads
	// at a glance. LogViewer colors via ansi_to_html, so this wraps the text in an ANSI
	// SGR sequence. The ESC byte is built from its code point to keep the source ASCII.
	const ANSI = {
		green: String.fromCharCode(27) + '[32m',
		red: String.fromCharCode(27) + '[31m',
		reset: String.fromCharCode(27) + '[0m'
	};
	let logText = $derived.by(() => {
		const base = lines.join('\n');
		if (running || ok === undefined) return base;
		// Match the closing line's indent to the log's own lines (compose prefixes a
		// space, other producers don't) so it lines up with the text above, not the edge.
		const lastReal = [...lines].reverse().find((l) => l.trim().length > 0);
		const indent = lastReal ? (lastReal.match(/^\s*/)?.[0] ?? '') : '';
		const color = ok ? ANSI.green : ANSI.red;
		const suffix = indent + color + statusLine + ANSI.reset;
		return base ? base + '\n' + suffix : suffix;
	});

	// This modal has no editor in scope to borrow a theme from (unlike StackModal's
	// docked panel). It follows the app-wide light/dark switch, whose source of truth is
	// the `.dark` class on <html> (Tailwind dark mode). Read it EACH time the modal opens:
	// this component mounts once at the page root and is re-shown via `open`, so the value
	// must track the current theme, not whatever it was at mount.
	let outputTheme = $state<'light' | 'dark'>('dark');

	function currentAppTheme(): 'light' | 'dark' {
		if (typeof document !== 'undefined') {
			return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
		}
		return 'dark';
	}

	$effect(() => {
		if (open) outputTheme = currentAppTheme();
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
			<!-- Identity, run status and the run recap all share one line to save
			     vertical space; the recap wraps under it only on a narrow dialog. -->
			<Dialog.Title class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-normal">
				<DeployOutputHeader verb={headerVerb} {stackName} {stackIcon} {envId} state={headerState} {statusLine} />
				<DeploySummaryBar {lines} />
			</Dialog.Title>
			<Dialog.Description class="sr-only">{statusLine}</Dialog.Description>
		</Dialog.Header>

		<LogViewer
			logs={logText}
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
