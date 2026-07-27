<script lang="ts">
	import { Sun, Moon } from 'lucide-svelte';
	import { getTimeFormat } from '$lib/stores/settings';

	interface Props {
		logs: string | null;
		darkMode?: boolean;
		timezone?: string;
		onToggleTheme?: () => void;
	}

	let { logs, darkMode = true, timezone, onToggleTheme }: Props = $props();

	// Parse log lines with timestamp and content
	function parseLogLine(line: string): { timestamp: string; content: string; type: 'trivy' | 'grype' | 'error' | 'default' } {
		const content = line.replace(/^\[[\d\-T:.Z]+\]\s*/, '');
		const timestamp = line.match(/^\[([\d\-T:.Z]+)\]/)?.[1] || '';

		let type: 'trivy' | 'grype' | 'error' | 'default' = 'default';
		if (content.startsWith('[trivy]')) {
			type = 'trivy';
		} else if (content.startsWith('[grype]')) {
			type = 'grype';
		} else if (/\berrors?\b/i.test(content) && !/\bno\s+errors?\b/i.test(content)) {
			type = 'error';
		}

		return { timestamp, content, type };
	}

	function getTypeBadge(type: 'trivy' | 'grype' | 'error' | 'default'): { label: string; class: string } {
		switch (type) {
			case 'trivy':
				return { label: 'trivy', class: 'bg-teal-500 text-white' };
			case 'grype':
				return { label: 'grype', class: 'bg-violet-500 text-white' };
			case 'error':
				return { label: 'error', class: 'bg-red-500 text-white' };
			default:
				return { label: 'dockhand', class: 'bg-slate-500 text-white' };
		}
	}

	function cleanContent(content: string, type: 'trivy' | 'grype' | 'error' | 'default'): string {
		return content.replace(/^\[(trivy|grype|scan)\]\s*/i, '');
	}

	function formatTimestamp(timestamp: string): string {
		const d = new Date(timestamp);
		if (isNaN(d.getTime())) return timestamp;
		return new Intl.DateTimeFormat('en-GB', {
			timeZone: timezone || undefined,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: getTimeFormat() === '12h'
		}).format(d);
	}
</script>

<div class="flex-1 flex flex-col min-h-0">
	<div class="flex items-center justify-between text-xs text-muted-foreground mb-1 shrink-0">
		<span>Logs</span>
		{#if onToggleTheme}
			<button
				type="button"
				onclick={onToggleTheme}
				class="p-1 rounded hover:bg-muted transition-colors"
				title="Toggle log theme"
			>
				{#if darkMode}
					<Sun class="w-3.5 h-3.5" />
				{:else}
					<Moon class="w-3.5 h-3.5" />
				{/if}
			</button>
		{/if}
	</div>
	<div
		class="{darkMode ? 'bg-zinc-950 text-zinc-300' : 'bg-zinc-100 text-zinc-700'} rounded p-3 font-mono text-xs flex-1 overflow-auto"
	>
		{#if logs}
			{#each logs.split('\n') as line}
				{@const parsed = parseLogLine(line)}
				{@const badge = getTypeBadge(parsed.type)}
				<div class="flex items-start gap-1.5 leading-relaxed">
					<span
						class="inline-flex items-center justify-center w-12 px-1 rounded text-[8px] font-medium {badge.class} shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]"
					>
						{badge.label}
					</span>
					{#if parsed.timestamp}
						<span class="{darkMode ? 'text-zinc-500' : 'text-zinc-400'} shrink-0">
							{formatTimestamp(parsed.timestamp)}
						</span>
					{/if}
					<span class="break-all">{cleanContent(parsed.content, parsed.type)}</span>
				</div>
			{/each}
		{:else}
			<span class="text-muted-foreground">No logs available</span>
		{/if}
	</div>
</div>
