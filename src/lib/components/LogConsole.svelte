<script lang="ts">
	import { Terminal, Sun, Moon, Folder, HardDrive } from 'lucide-svelte';

	interface Props {
		/** Log lines. A leading `[source]` token is rendered as a colored pill. */
		lines: string[];
		/** Map a source token (e.g. "restic") to a pill background class. Unknown
		 *  sources fall back to a neutral slate pill. */
		sourceColors?: Record<string, string>;
		class?: string;
	}
	let { lines, sourceColors = {}, class: className = '' }: Props = $props();

	const DEFAULT_COLORS: Record<string, string> = {
		dockhand: 'bg-slate-500',
		restic: 'bg-sky-600',
		grype: 'bg-violet-500',
		trivy: 'bg-teal-500',
		scan: 'bg-violet-500',
		error: 'bg-red-500',
	};
	const colorFor = (src: string) => sourceColors[src] ?? DEFAULT_COLORS[src] ?? 'bg-slate-500';

	// Split a line into its optional `[source]` pill token and the remaining text.
	function parse(line: string): { source: string | null; text: string } {
		const m = line.match(/^\[([a-z0-9_-]+)\]\s?/i);
		if (!m) return { source: null, text: line };
		return { source: m[1].toLowerCase(), text: line.slice(m[0].length) };
	}

	// A backup volume-list line looks like `  • [BIND] /config` or `  • [VOL] name`.
	// Render the `[BIND]`/`[VOL]` token as a typed chip (same amber-bind / sky-vol
	// as the backup config UI) so the log matches the picker. Inert for any other
	// line (scan logs never emit this), so this stays a no-op for non-backup output.
	function volToken(text: string): { kind: 'bind' | 'vol'; rest: string } | null {
		const m = text.match(/^\s*•\s*\[(BIND|VOL)\]\s?(.*)$/);
		if (!m) return null;
		return { kind: m[1] === 'BIND' ? 'bind' : 'vol', rest: m[2] };
	}

	let dark = $state(true);
	let container = $state<HTMLDivElement>();

	// Auto-scroll to the newest line as logs stream in.
	$effect(() => {
		void lines.length;
		if (container) requestAnimationFrame(() => { if (container) container.scrollTop = container.scrollHeight; });
	});
</script>

<div class="flex flex-col {className}">
	<div class="mb-2 flex shrink-0 items-center justify-between text-xs text-muted-foreground">
		<div class="flex items-center gap-2">
			<Terminal class="h-3.5 w-3.5" />
			<span>Output ({lines.length} {lines.length === 1 ? 'line' : 'lines'})</span>
		</div>
		<button type="button" onclick={() => (dark = !dark)} class="cursor-pointer rounded p-1 transition-colors hover:bg-muted" title="Toggle log theme">
			{#if dark}<Sun class="h-3.5 w-3.5" />{:else}<Moon class="h-3.5 w-3.5" />{/if}
		</button>
	</div>
	<div
		bind:this={container}
		class="{dark ? 'bg-zinc-950 text-zinc-300' : 'bg-zinc-100 text-zinc-700'} min-h-0 flex-1 overflow-auto rounded-lg p-3 font-mono text-xs"
	>
		{#each lines as line}
			{@const p = parse(line)}
			{@const isError = p.source === 'error' || /error|fatal|fail/i.test(p.text)}
			{@const vt = volToken(p.text)}
			<div class="flex items-start gap-1.5 whitespace-pre-wrap break-all leading-relaxed">
				{#if p.source}
					<span class="mt-[3px] inline-flex w-16 shrink-0 items-center justify-center rounded px-1 text-[8px] font-medium text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] {colorFor(p.source)}">{p.source}</span>
				{/if}
				{#if vt}
					{#if vt.kind === 'bind'}
						<span class="mt-[2px] inline-flex w-14 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-amber-500/15 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-500"><Folder class="h-2.5 w-2.5 shrink-0" />bind</span>
					{:else}
						<span class="mt-[2px] inline-flex w-14 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full bg-sky-500/15 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-sky-500"><HardDrive class="h-2.5 w-2.5 shrink-0" />vol</span>
					{/if}
					<span class={isError ? 'text-red-400' : ''}>{vt.rest}</span>
				{:else}
					<span class={isError ? 'text-red-400' : ''}>{p.text}</span>
				{/if}
			</div>
		{/each}
	</div>
</div>
