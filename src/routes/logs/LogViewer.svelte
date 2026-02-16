<script lang="ts">
	import { RefreshCw, Copy, Download, WrapText, ArrowDownToLine, Search, ChevronUp, ChevronDown, X, Type } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as Select from '$lib/components/ui/select';
	import { themeStore } from '$lib/stores/theme';
	import { getMonospaceFont } from '$lib/themes';

	interface Props {
		logs: string;
		containerName: string;
		loading?: boolean;
		autoRefresh?: boolean;
		autoScroll?: boolean;
		onRefresh?: () => void;
		onAutoRefreshChange?: (value: boolean) => void;
		onAutoScrollChange?: (value: boolean) => void;
		class?: string;
	}

	let {
		logs,
		containerName,
		loading = false,
		autoRefresh = true,
		autoScroll = true,
		onRefresh,
		onAutoRefreshChange,
		onAutoScrollChange,
		class: className = ''
	}: Props = $props();

	let logsRef: HTMLDivElement;
	let wordWrap = $state(true);
	let fontSize = $state(12);

	// Search state
	let logSearchActive = $state(false);
	let logSearchQuery = $state('');
	let currentMatchIndex = $state(0);
	let matchCount = $state(0);
	let logSearchInputRef: HTMLInputElement;

	const fontSizeOptions = [10, 12, 14, 16];

	// Get terminal font family from theme preferences
	let terminalFontFamily = $derived(() => {
		const fontMeta = getMonospaceFont($themeStore.terminalFont);
		return fontMeta?.family || 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
	});

	// Auto-scroll when logs change
	$effect(() => {
		if (autoScroll && logsRef && logs) {
			setTimeout(() => {
				logsRef.scrollTop = logsRef.scrollHeight;
			}, 50);
		}
	});

	// Copy logs to clipboard
	async function copyLogs() {
		if (logs) {
			await copyToClipboard(logs);
		}
	}

	// Download logs as txt file
	function downloadLogs() {
		if (logs && containerName) {
			const blob = new Blob([logs], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${containerName}-logs.txt`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		}
	}

	// Search functions
	function toggleLogSearch() {
		logSearchActive = !logSearchActive;
		if (logSearchActive) {
			setTimeout(() => logSearchInputRef?.focus(), 50);
		} else {
			logSearchQuery = '';
			currentMatchIndex = 0;
			matchCount = 0;
		}
	}

	function closeLogSearch() {
		logSearchActive = false;
		logSearchQuery = '';
		currentMatchIndex = 0;
		matchCount = 0;
	}

	function navigateMatch(direction: 'prev' | 'next') {
		if (!logsRef || matchCount === 0) return;

		const matches = logsRef.querySelectorAll('.search-match');
		if (matches.length === 0) return;

		matches[currentMatchIndex]?.classList.remove('current-match');

		if (direction === 'next') {
			currentMatchIndex = (currentMatchIndex + 1) % matches.length;
		} else {
			currentMatchIndex = (currentMatchIndex - 1 + matches.length) % matches.length;
		}

		const currentEl = matches[currentMatchIndex];
		if (currentEl) {
			currentEl.classList.add('current-match');
			currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}

	function handleLogSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			if (e.shiftKey) {
				navigateMatch('prev');
			} else {
				navigateMatch('next');
			}
		} else if (e.key === 'Escape') {
			closeLogSearch();
		}
	}

	// Escape HTML to prevent XSS
	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	// Highlighted logs with search matches
	let highlightedLogs = $derived(() => {
		const escaped = escapeHtml(logs || '');
		if (!logSearchQuery.trim()) return escaped;

		const query = logSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const escapedQuery = escapeHtml(query);
		const regex = new RegExp(`(${escapedQuery})`, 'gi');
		return escaped.replace(regex, '<mark class="search-match">$1</mark>');
	});

	// Update match count after render
	$effect(() => {
		const html = highlightedLogs();

		if (logSearchQuery && logsRef) {
			setTimeout(() => {
				const matches = logsRef.querySelectorAll('.search-match');
				matchCount = matches.length;
				currentMatchIndex = 0;
				if (matches.length > 0) {
					matches[0].classList.add('current-match');
					matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
				}
			}, 100);
		} else {
			matchCount = 0;
			currentMatchIndex = 0;
		}
	});
</script>

<div class="flex flex-col bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden {className}">
	<!-- Header bar -->
	<div class="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
		<div class="flex items-center gap-2">
			{#if loading}
				<RefreshCw class="w-3 h-3 text-zinc-500 animate-spin" />
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<!-- Auto-refresh button -->
			<button
				onclick={() => onAutoRefreshChange?.(!autoRefresh)}
				class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors {autoRefresh ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}"
				title="Toggle auto-refresh"
			>
				<RefreshCw class="w-3 h-3" />
			</button>
			<!-- Auto-scroll button -->
			<button
				onclick={() => onAutoScrollChange?.(!autoScroll)}
				class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors {autoScroll ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}"
				title="Toggle auto-scroll"
			>
				<ArrowDownToLine class="w-3 h-3" />
			</button>
			<!-- Font size -->
			<Select.Root type="single" value={String(fontSize)} onValueChange={(v) => fontSize = Number(v)}>
				<Select.Trigger class="h-6 w-16 bg-zinc-800 border-zinc-700 text-xs text-zinc-300 px-1.5">
					<Type class="w-3 h-3 mr-1 text-zinc-400" />
					<span>{fontSize}px</span>
				</Select.Trigger>
				<Select.Content>
					{#each fontSizeOptions as size}
						<Select.Item value={String(size)} label="{size}px">
							<Type class="w-3 h-3 mr-1.5 text-muted-foreground" />
							{size}px
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<!-- Word wrap -->
			<button
				onclick={() => wordWrap = !wordWrap}
				class="p-1 rounded hover:bg-zinc-800 transition-colors {wordWrap ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : ''}"
				title="Toggle word wrap"
			>
				<WrapText class="w-3 h-3 transition-colors {wordWrap ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-300'}" />
			</button>
			<!-- Search -->
			{#if logSearchActive}
				<div class="flex items-center gap-1 bg-zinc-800 rounded px-1.5 py-0.5">
					<Search class="w-3 h-3 text-amber-400" />
					<input
						bind:this={logSearchInputRef}
						type="text"
						placeholder="Search..."
						bind:value={logSearchQuery}
						onkeydown={handleLogSearchKeydown}
						class="bg-transparent border-none outline-none text-xs text-zinc-200 w-20 placeholder:text-zinc-500"
					/>
					{#if matchCount > 0}
						<span class="text-xs text-zinc-400">{currentMatchIndex + 1}/{matchCount}</span>
					{:else if logSearchQuery}
						<span class="text-xs text-zinc-500">0/0</span>
					{/if}
					<button onclick={() => navigateMatch('prev')} class="p-0.5 rounded hover:bg-zinc-700" title="Previous">
						<ChevronUp class="w-3 h-3 text-zinc-400" />
					</button>
					<button onclick={() => navigateMatch('next')} class="p-0.5 rounded hover:bg-zinc-700" title="Next">
						<ChevronDown class="w-3 h-3 text-zinc-400" />
					</button>
					<button onclick={closeLogSearch} class="p-0.5 rounded hover:bg-zinc-700" title="Close">
						<X class="w-3 h-3 text-zinc-400" />
					</button>
				</div>
			{:else}
				<button
					onclick={toggleLogSearch}
					class="p-1 rounded hover:bg-zinc-800 transition-colors"
					title="Search logs"
				>
					<Search class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
				</button>
			{/if}
			<!-- Copy -->
			<button
				onclick={copyLogs}
				class="p-1 rounded hover:bg-zinc-800 transition-colors"
				title="Copy logs"
			>
				<Copy class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
			</button>
			<!-- Download -->
			<button
				onclick={downloadLogs}
				class="p-1 rounded hover:bg-zinc-800 transition-colors"
				title="Download logs"
			>
				<Download class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
			</button>
			<!-- Refresh -->
			<button
				onclick={() => onRefresh?.()}
				class="p-1 rounded hover:bg-zinc-800 transition-colors"
				title="Refresh logs"
			>
				<RefreshCw class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
			</button>
		</div>
	</div>

	<!-- Logs content -->
	<div bind:this={logsRef} class="flex-1 overflow-auto p-4">
		{#if logs}
			<pre class="text-zinc-50 {wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'}" style="font-size: {fontSize}px; font-family: {terminalFontFamily()};">{@html highlightedLogs()}</pre>
		{:else if loading}
			<div class="flex items-center justify-center h-full text-muted-foreground">
				<RefreshCw class="w-5 h-5 animate-spin mr-2" />
				Loading logs...
			</div>
		{:else}
			<p class="text-zinc-500 text-sm">No logs available</p>
		{/if}
	</div>
</div>

<style>
	:global(.search-match) {
		background-color: rgba(234, 179, 8, 0.4);
		color: #fef3c7;
		border-radius: 2px;
		padding: 1px 2px;
		box-shadow: 0 0 4px rgba(234, 179, 8, 0.5);
	}
	:global(.search-match.current-match) {
		background-color: rgba(234, 179, 8, 0.8);
		color: #1a1a1a;
		font-weight: 600;
		box-shadow: 0 0 8px rgba(234, 179, 8, 0.9), 0 0 16px rgba(234, 179, 8, 0.5);
		outline: 2px solid rgb(250, 204, 21);
	}
</style>
