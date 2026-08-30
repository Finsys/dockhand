<script lang="ts">
	import { RefreshCw, Copy, Download, WrapText, ArrowDownToLine, Search, ChevronUp, ChevronDown, X, Type, Eraser, Filter, Hash } from 'lucide-svelte';
	import { wrapHtmlLines } from '$lib/utils/log-lines';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { downloadFileName, stripAnsi } from '$lib/utils/log-download-name';
	import { isScrolledToBottom, shouldResetScrollPause } from '$lib/utils/scroll-position';
	import * as Select from '$lib/components/ui/select';
	import { appSettings, formatLogTimestamps } from '$lib/stores/settings';
	import { themeStore } from '$lib/stores/theme';
	import { getMonospaceFont } from '$lib/themes';
	import { AnsiUp } from 'ansi_up';
	const ansiUp = new AnsiUp();
	ansiUp.use_classes = true;

	interface Props {
		logs: string;
		title?: string;
		loading?: boolean;
		autoRefresh?: boolean;
		autoScroll?: boolean;
		onRefresh?: () => void;
		onClear?: () => void;
		onAutoRefreshChange?: (value: boolean) => void;
		onAutoScrollChange?: (value: boolean) => void;
		class?: string;
		// Follows the caller's own light/dark switch, independent of the app-wide
		// theme -- e.g. the editor theme toggle in StackModal (`dockhand-editor-theme`).
		// Defaults to 'dark' so every existing caller that doesn't pass it renders
		// exactly as before.
		theme?: 'light' | 'dark';
	}

	let {
		logs,
		title,
		loading = false,
		autoRefresh = true,
		autoScroll = true,
		onRefresh,
		onClear,
		onAutoRefreshChange,
		onAutoScrollChange,
		class: className = '',
		theme = 'dark'
	}: Props = $props();

	let dark = $derived(theme === 'dark');

	let logsRef: HTMLDivElement;
	let wordWrap = $state(true);
	let showLineNumbers = $state(typeof window !== 'undefined' && localStorage.getItem('dockhand-log-line-numbers') === 'true');
	let fontSize = $state(12);

	// RAF-based auto-scroll
	let scrollRafPending = false;
	// True once the user has scrolled up to read earlier output. Cleared again once
	// they scroll back within range of the end, at which point auto-scroll resumes.
	let userScrolledUp = $state(false);
	// Set for the duration of our own programmatic scrollTop write, so the 'scroll'
	// event it triggers isn't mistaken for the user scrolling. Without this, a fast
	// enough stream of new lines can grow scrollHeight again between the write and
	// the event firing, leaving a gap wide enough to look like the user scrolled up.
	let isAutoScrolling = false;
	// Tracks the previous value of the autoScroll prop, purely so the effect below can
	// tell a false -> true edge (a fresh run starting) apart from autoScroll simply
	// staying true across renders. Left unset here rather than seeded from `autoScroll`
	// directly -- reading a prop in a plain top-level initializer only captures its
	// value at that one point in time, which svelte-check flags (state_referenced_locally)
	// because it usually signals a bug. The effect below seeds it on its first run instead,
	// where reading `autoScroll` is tracked.
	let previousAutoScroll: boolean | undefined;

	// Search state
	let logSearchActive = $state(false);
	let logSearchQuery = $state('');
	let logSearchFilterMode = $state(typeof window !== 'undefined' && localStorage.getItem('dockhand-log-filter-mode') === 'true');
	let currentMatchIndex = $state(0);
	let matchCount = $state(0);
	let logSearchInputRef: HTMLInputElement;

	const fontSizeOptions = [10, 12, 14, 16];

	// Get terminal font family from theme preferences
	let terminalFontFamily = $derived(() => {
		const fontMeta = getMonospaceFont($themeStore.terminalFont);
		return fontMeta?.family || 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
	});

	// A fresh run starting (autoScroll going false -> true) lifts a scroll-up pause left
	// over from an earlier run -- otherwise scrolling up once during a deploy pauses
	// auto-scroll for every later run of the same page session, since nothing else ever
	// clears userScrolledUp.
	$effect(() => {
		if (previousAutoScroll !== undefined && shouldResetScrollPause(previousAutoScroll, autoScroll)) {
			userScrolledUp = false;
		}
		previousAutoScroll = autoScroll;
	});

	// Auto-scroll when logs change, unless the user scrolled up to read earlier output.
	$effect(() => {
		if (autoScroll && !userScrolledUp && logsRef && logs) {
			if (!scrollRafPending) {
				scrollRafPending = true;
				requestAnimationFrame(() => {
					if (logsRef) {
						isAutoScrolling = true;
						logsRef.scrollTop = logsRef.scrollHeight;
						// Let the 'scroll' event this write triggers reach handleLogScroll (and be
						// ignored there) before treating further events as user-initiated again.
						requestAnimationFrame(() => {
							isAutoScrolling = false;
						});
					}
					scrollRafPending = false;
				});
			}
		}
	});

	// Pause auto-scroll once the user scrolls up, resume once they scroll back down.
	function handleLogScroll() {
		if (isAutoScrolling || !logsRef) return;
		const { scrollTop, scrollHeight, clientHeight } = logsRef;
		userScrolledUp = !isScrolledToBottom(scrollTop, scrollHeight, clientHeight);
	}

	// Copy logs to clipboard
	async function copyLogs() {
		if (logs) {
			await copyToClipboard(stripAnsi(logs));
		}
	}

	// Download logs as txt file
	function downloadLogs() {
		if (logs) {
			const blob = new Blob([stripAnsi(logs)], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = downloadFileName(title);
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
		logSearchFilterMode = false;
		currentMatchIndex = 0;
		matchCount = 0;
	}

	function toggleSearchFilterMode() {
		logSearchFilterMode = !logSearchFilterMode;
		localStorage.setItem('dockhand-log-filter-mode', String(logSearchFilterMode));
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

	// Highlighted logs with search matches and ANSI color support
	let highlightedLogs = $derived(() => {
		let text = logs || '';
		if ($appSettings.formatLogTimestamps) {
			text = formatLogTimestamps(text);
		}

		const query = logSearchQuery.trim();

		// Filter lines before ANSI conversion (plain text matching)
		if (logSearchFilterMode && query) {
			const escapedForRegex = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const filterRegex = new RegExp(escapedForRegex, 'i');
			const lines = text.split('\n');
			text = lines.filter(line => filterRegex.test(line)).join('\n');
		}

		const withAnsi = ansiUp.ansi_to_html(text);
		if (!query) return withAnsi;

		const escapedForRegex = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const escapedQuery = escapedForRegex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

		// Split by HTML tags and only process text parts
		const parts = withAnsi.split(/(<[^>]*>)/);
		return parts.map(part => {
			if (part.startsWith('<')) return part;
			return part.replace(new RegExp(`(${escapedQuery})`, 'gi'), '<mark class="search-match">$1</mark>');
		}).join('');
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

<div class="flex flex-col rounded-lg border overflow-hidden {dark ? 'log-viewer-dark bg-zinc-950 border-zinc-800' : 'log-viewer-light bg-gray-50 border-gray-300'} {className}">
	<!-- Header bar -->
	<div class="flex items-center justify-between px-3 py-1.5 border-b shrink-0 {dark ? 'border-zinc-800 bg-zinc-900/50' : 'border-gray-300 bg-gray-100'}">
		<div class="flex items-center gap-2">
			{#if loading}
				<RefreshCw class="w-3 h-3 animate-spin {dark ? 'text-zinc-500' : 'text-gray-400'}" />
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<!-- Auto-refresh button -->
			<button
				onclick={() => onAutoRefreshChange?.(!autoRefresh)}
				class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors {autoRefresh ? (dark ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : dark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-300'}"
				title="Toggle auto-refresh"
			>
				<RefreshCw class="w-3 h-3" />
			</button>
			<!-- Auto-scroll button -->
			<button
				onclick={() => onAutoScrollChange?.(!autoScroll)}
				class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors {autoScroll ? (dark ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : dark ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-300'}"
				title="Toggle auto-scroll"
			>
				<ArrowDownToLine class="w-3 h-3" />
			</button>
			<!-- Font size -->
			<Select.Root type="single" value={String(fontSize)} onValueChange={(v) => fontSize = Number(v)}>
				<Select.Trigger class="h-6 w-16 text-xs px-1.5 {dark ? 'bg-zinc-800 border-zinc-700 text-zinc-300' : 'bg-white border-gray-300 text-gray-700'}">
					<Type class="w-3 h-3 mr-1 {dark ? 'text-zinc-400' : 'text-gray-400'}" />
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
				class="p-1 rounded transition-colors {wordWrap ? (dark ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'bg-amber-500/30 ring-1 ring-amber-600/50') : ''} {dark ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title="Toggle word wrap"
			>
				<WrapText class="w-3 h-3 transition-colors {wordWrap ? (dark ? 'text-amber-400' : 'text-amber-700') : dark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Line numbers -->
			<button
				onclick={() => { showLineNumbers = !showLineNumbers; localStorage.setItem('dockhand-log-line-numbers', String(showLineNumbers)); }}
				class="p-1 rounded transition-colors {showLineNumbers ? (dark ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'bg-amber-500/30 ring-1 ring-amber-600/50') : ''} {dark ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title={showLineNumbers ? 'Hide line numbers' : 'Show line numbers'}
			>
				<Hash class="w-3 h-3 transition-colors {showLineNumbers ? (dark ? 'text-amber-400' : 'text-amber-700') : dark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Search -->
			{#if logSearchActive}
				<div class="flex items-center gap-1 rounded px-1.5 py-0.5 {dark ? 'bg-zinc-800' : 'bg-gray-200'}">
					<Search class="w-3 h-3 {dark ? 'text-amber-400' : 'text-amber-700'}" />
					<input
						bind:this={logSearchInputRef}
						type="text"
						placeholder="Search..."
						bind:value={logSearchQuery}
						onkeydown={handleLogSearchKeydown}
						class="bg-transparent border-none outline-none text-xs w-20 {dark ? 'text-zinc-200 placeholder:text-zinc-500' : 'text-gray-800 placeholder:text-gray-400'}"
					/>
					<button
						onclick={toggleSearchFilterMode}
						class="p-0.5 rounded transition-colors {logSearchFilterMode ? (dark ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'bg-amber-500/30 ring-1 ring-amber-600/50') : dark ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}"
						title={logSearchFilterMode ? 'Show all lines (filter mode active)' : 'Hide non-matching lines'}
					>
						<Filter class="w-3 h-3 transition-colors {logSearchFilterMode ? (dark ? 'text-amber-400' : 'text-amber-700') : dark ? 'text-zinc-400' : 'text-gray-500'}" />
					</button>
					{#if matchCount > 0}
						<span class="text-xs {dark ? 'text-zinc-400' : 'text-gray-500'}">{currentMatchIndex + 1}/{matchCount}</span>
					{:else if logSearchQuery}
						<span class="text-xs {dark ? 'text-zinc-500' : 'text-gray-400'}">0/0</span>
					{/if}
					<button onclick={() => navigateMatch('prev')} class="p-0.5 rounded {dark ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Previous">
						<ChevronUp class="w-3 h-3 {dark ? 'text-zinc-400' : 'text-gray-500'}" />
					</button>
					<button onclick={() => navigateMatch('next')} class="p-0.5 rounded {dark ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Next">
						<ChevronDown class="w-3 h-3 {dark ? 'text-zinc-400' : 'text-gray-500'}" />
					</button>
					<button onclick={closeLogSearch} class="p-0.5 rounded {dark ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Close">
						<X class="w-3 h-3 {dark ? 'text-zinc-400' : 'text-gray-500'}" />
					</button>
				</div>
			{:else}
				<button
					onclick={toggleLogSearch}
					class="p-1 rounded transition-colors {dark ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
					title="Search logs"
				>
					<Search class="w-3 h-3 {dark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
				</button>
			{/if}
			<!-- Copy -->
			<button
				onclick={copyLogs}
				class="p-1 rounded transition-colors {dark ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title="Copy logs"
			>
				<Copy class="w-3 h-3 {dark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Download -->
			<button
				onclick={downloadLogs}
				class="p-1 rounded transition-colors {dark ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title="Download logs"
			>
				<Download class="w-3 h-3 {dark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Clear -->
			{#if onClear}
				<button
					onclick={() => onClear?.()}
					class="p-1 rounded transition-colors {dark ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
					title="Clear logs"
				>
					<Eraser class="w-3 h-3 {dark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
				</button>
			{/if}
			<!-- Refresh -->
			{#if onRefresh}
				<button
					onclick={() => onRefresh?.()}
					class="p-1 rounded transition-colors {dark ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
					title="Refresh logs"
				>
					<RefreshCw class="w-3 h-3 {dark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
				</button>
			{/if}
		</div>
	</div>

	<!-- Logs content -->
	<div bind:this={logsRef} onscroll={handleLogScroll} class="flex-1 overflow-auto p-4">
		{#if logs}
			<pre class="{dark ? 'text-zinc-50' : 'text-gray-900'} {wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'} {showLineNumbers ? 'show-line-numbers' : ''}" style="font-size: {fontSize}px; font-family: {terminalFontFamily()};">{@html wrapHtmlLines(highlightedLogs())}</pre>
		{:else if loading}
			<div class="flex items-center justify-center h-full {dark ? 'text-zinc-500' : 'text-gray-500'}">
				<RefreshCw class="w-5 h-5 animate-spin mr-2" />
				Loading logs...
			</div>
		{:else}
			<p class="text-sm {dark ? 'text-zinc-500' : 'text-gray-500'}">No logs available</p>
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

	/* The base .search-match rule above pairs a pale amber background with
	   near-white text (#fef3c7) -- fine against the dark log background this
	   component defaults to, but low-contrast once the panel switches to its
	   own light theme (see the `theme` prop). Scoped to .log-viewer-light so it
	   never touches the dark styling above or other components sharing the
	   (unscoped) .search-match class, such as LogsPanel. Higher specificity than
	   the base rule -- (0,2,0) vs (0,1,0) -- so it wins regardless of source order.
	   .current-match is left alone: its 0.8 background alpha already composites to
	   a near-solid amber against either page background, so the dark (#1a1a1a) text
	   it uses stays legible without a light-mode override. */
	:global(.log-viewer-light .search-match) {
		color: #78350f;
		box-shadow: 0 0 4px rgba(217, 119, 6, 0.35);
	}
</style>
