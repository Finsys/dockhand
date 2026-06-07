<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { X, GripHorizontal, RefreshCw, Copy, Download, WrapText, ArrowDownToLine, Search, ChevronUp, ChevronDown, Sun, Moon, Wifi, WifiOff, Pause, Play, Eraser, Filter, Clock, Tag, Hash } from 'lucide-svelte';
	import LogTimeRangeFilter from './LogTimeRangeFilter.svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as Select from '$lib/components/ui/select';
	import { appSettings, formatLogTimestamps } from '$lib/stores/settings';
	import { themeStore } from '$lib/stores/theme';
	import { getMonospaceFont } from '$lib/themes';
	import { parseLines, renderLineHtml, type LogEntry } from '$lib/utils/log-entry';

	interface Props {
		containerId: string;
		containerName: string;
		visible: boolean;
		envId: number | null;
		fillHeight?: boolean;
		showCloseButton?: boolean;
		onClose: () => void;
	}

	let { containerId, containerName, visible, envId, fillHeight = false, showCloseButton = true, onClose }: Props = $props();

	let logs = $state<LogEntry[]>([]);
	let loading = $state(false);
	let logsRef: HTMLDivElement;
	let panelRef: HTMLDivElement;
	let autoScroll = $state(true);
	let wordWrap = $state(true);
	let fontSize = $state(12);
	let showTimestamps = $state(typeof localStorage !== 'undefined' ? localStorage.getItem('dockhand-log-timestamps') !== 'false' : true);
	let showContainerName = $state(typeof localStorage !== 'undefined' ? localStorage.getItem('dockhand-log-container-name') !== 'false' : true);
	let showLineNumbers = $state(false);

	function renderTimestamp(ts: string | undefined): string {
		if (!ts) return '';
		if ($appSettings.formatLogTimestamps) {
			return formatLogTimestamps(ts + ' ').trimEnd();
		}
		return ts;
	}

	// SSE Streaming state
	let streamingEnabled = $state(true);
	let isConnected = $state(false);
	let connectionError = $state<string | null>(null);
	let eventSource: EventSource | null = null;
	let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempts = $state(0);
	const MAX_RECONNECT_ATTEMPTS = 5;
	const RECONNECT_DELAY = 3000;
	const OFFLINE_POLL_INTERVAL = 5000; // Check every 5 seconds when offline
	let offlinePollingInterval: ReturnType<typeof setInterval> | null = null;

	// SSE batching — collect parsed entries (and a carryover for split-across-chunk
	// lines) and flush via microtask to coalesce a burst of "log" events into one
	// state update. Compaction (slice to last MAX_LINES) runs at 2x cap.
	let pendingEntries: LogEntry[] = [];
	let streamCarryover = '';
	let flushScheduled = false;
	const COMPACT_FACTOR = 2;

	// RAF-based auto-scroll
	let scrollRafPending = false;

	// Search state
	let logSearchActive = $state(false);
	let logSearchQuery = $state('');
	let logSearchFilterMode = $state(false);
	let currentMatchIndex = $state(0);
	let matchCount = $state(0);
	let logSearchInputRef: HTMLInputElement | undefined;

	const fontSizeOptions = [10, 12, 14, 16];
	// Capped at 1000 — larger initial replays freeze the browser since rendering
	// isn't virtualized.
	const tailOptions = [
		{ value: '100', label: '100' },
		{ value: '500', label: '500' },
		{ value: '1000', label: '1K' }
	];
	const VALID_TAIL_VALUES = new Set(tailOptions.map(o => o.value));

	// Tail count and time range filter
	let tailCount = $state('500');
	let sinceDate = $state('');
	let sinceTime = $state('');
	let untilDate = $state('');
	let untilTime = $state('');
	function getTimestamp(date: string, time: string, defaultTime: string): string {
		if (!date) return '';
		const dateStr = time ? `${date}T${time}` : `${date}T${defaultTime}`;
		const ts = Math.floor(new Date(dateStr).getTime() / 1000);
		return isNaN(ts) ? '' : String(ts);
	}

	function getSinceParam(): string {
		return getTimestamp(sinceDate, sinceTime, '00:00:00');
	}

	function getUntilParam(): string {
		return getTimestamp(untilDate, untilTime, '23:59:59');
	}

	function reloadLogs() {
		logs = [];
		pendingEntries = [];
		streamCarryover = '';
		if (streamingEnabled && containerId && visible) {
			loading = true;
			startStreaming();
		} else {
			fetchLogs();
		}
	}

	// Get terminal font family from theme preferences
	let terminalFontFamily = $derived(() => {
		const fontMeta = getMonospaceFont($themeStore.terminalFont);
		return fontMeta?.family || 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
	});

	// Panel height with localStorage persistence
	const STORAGE_KEY = 'dockhand-logs-panel-height';
	const SETTINGS_STORAGE_KEY = 'dockhand-logs-settings';
	const DEFAULT_HEIGHT = 240;
	const MIN_HEIGHT = 150;
	const MAX_HEIGHT = 600;

	let panelHeight = $state(DEFAULT_HEIGHT);
	let isDragging = $state(false);
	let darkMode = $state(true);

	// Load all saved settings from localStorage
	function loadSettings() {
		if (typeof window !== 'undefined') {
			// Load panel height
			const savedHeight = localStorage.getItem(STORAGE_KEY);
			if (savedHeight) {
				const h = parseInt(savedHeight);
				if (!isNaN(h) && h >= MIN_HEIGHT && h <= MAX_HEIGHT) {
					panelHeight = h;
				}
			}
			// Load other settings
			const savedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
			if (savedSettings) {
				try {
					const settings = JSON.parse(savedSettings);
					if (settings.darkMode !== undefined) darkMode = settings.darkMode;
					if (settings.wordWrap !== undefined) wordWrap = settings.wordWrap;
					if (settings.fontSize !== undefined) fontSize = settings.fontSize;
					if (settings.autoScroll !== undefined) autoScroll = settings.autoScroll;
					if (settings.streamingEnabled !== undefined) streamingEnabled = settings.streamingEnabled;
					if (settings.logSearchFilterMode !== undefined) logSearchFilterMode = settings.logSearchFilterMode;
					// Old saved value may be '5000'/'10000'/'all' — snap down to a supported option.
				if (settings.tailCount !== undefined) {
					tailCount = VALID_TAIL_VALUES.has(settings.tailCount) ? settings.tailCount : '1000';
				}
					if (settings.showLineNumbers !== undefined) showLineNumbers = settings.showLineNumbers;
				} catch {
					// Ignore parse errors
				}
			}
		}
	}

	// Save settings to localStorage
	function saveSettings() {
		if (typeof window !== 'undefined') {
			localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
				darkMode,
				wordWrap,
				fontSize,
				autoScroll,
				streamingEnabled,
				logSearchFilterMode,
				tailCount,
				showLineNumbers
			}));
		}
	}

	// Toggle theme
	function toggleTheme() {
		darkMode = !darkMode;
		saveSettings();
	}

	// Save height to localStorage
	function saveHeight() {
		if (typeof window !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, String(panelHeight));
		}
	}

	// Drag handle functionality
	function startDrag(e: MouseEvent) {
		e.preventDefault();
		isDragging = true;
		document.addEventListener('mousemove', handleDrag);
		document.addEventListener('mouseup', stopDrag);
	}

	function handleDrag(e: MouseEvent) {
		if (!isDragging || !panelRef) return;
		const newHeight = window.innerHeight - e.clientY;
		panelHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, newHeight));
	}

	function stopDrag() {
		isDragging = false;
		document.removeEventListener('mousemove', handleDrag);
		document.removeEventListener('mouseup', stopDrag);
		saveHeight();
	}

	function appendEnvParam(url: string, envId: number | null): string {
		if (!envId) return url;
		const separator = url.includes('?') ? '&' : '?';
		return `${url}${separator}env=${envId}`;
	}

	// Schedule a microtask flush — coalesces multiple SSE log events arriving in
	// the same tick. queueMicrotask is preferred over setTimeout(0) because it
	// runs before the next paint, so autoscroll lands in the same frame.
	function scheduleFlush() {
		if (flushScheduled) return;
		flushScheduled = true;
		queueMicrotask(flushLogs);
	}

	function flushLogs() {
		flushScheduled = false;
		if (pendingEntries.length === 0) return;
		const maxLines = $appSettings.logMaxLines;
		// If the incoming batch alone exceeds the cap (initial tail replay with
		// a big `tail=` value), trim it BEFORE concatenating. Otherwise we'd
		// briefly grow the buffer to logs.length + pendingEntries.length entries
		// — for tail=5000 that means 5000 DOM nodes appear in one frame.
		const incoming = pendingEntries.length > maxLines
			? pendingEntries.slice(pendingEntries.length - maxLines)
			: pendingEntries;
		// 2x soft cap on the retained buffer to amortize slice cost across flushes.
		const next = logs.length + incoming.length <= maxLines * COMPACT_FACTOR
			? [...logs, ...incoming]
			: [...logs.slice(Math.max(0, logs.length + incoming.length - maxLines)), ...incoming];
		logs = next;
		pendingEntries = [];
		scrollToBottom();
	}

	// Threshold (px) for "still at the bottom". Wheel events and momentum scrolling
	// can land a few px off — keep it generous enough to feel sticky.
	const BOTTOM_STICKINESS_PX = 40;
	// Suppress the scroll listener while WE are writing scrollTop. Without this,
	// our own programmatic scroll fires the handler, sees distanceFromBottom≈0,
	// and re-enables autoScroll the moment the user paused it.
	let programmaticScroll = false;

	async function scrollToBottom() {
		if (!autoScroll || !logsRef || scrollRafPending) return;
		scrollRafPending = true;
		await tick();
		requestAnimationFrame(() => {
			if (logsRef) {
				programmaticScroll = true;
				logsRef.scrollTop = logsRef.scrollHeight;
				// Clear the flag on the next frame so user-initiated scroll after
				// our write is treated as user input.
				requestAnimationFrame(() => { programmaticScroll = false; });
			}
			scrollRafPending = false;
		});
	}

	// Auto-disable auto-scroll when the user scrolls up; re-enable when they
	// return to the bottom. Lets the user read history without fighting the stream.
	function handleLogsScroll() {
		if (programmaticScroll || !logsRef) return;
		const distance = logsRef.scrollHeight - logsRef.scrollTop - logsRef.clientHeight;
		const atBottom = distance < BOTTOM_STICKINESS_PX;
		if (atBottom && !autoScroll) {
			autoScroll = true;
			saveSettings();
		} else if (!atBottom && autoScroll) {
			autoScroll = false;
			saveSettings();
		}
	}

	// Start SSE streaming for logs
	function startStreaming() {
		if (!containerId || !streamingEnabled) return;
		stopStreaming(false); // Don't reset reconnect attempts

		connectionError = null;
		const currentContainerId = containerId; // Capture for closure

		try {
			const since = getSinceParam();
			const until = getUntilParam();
			const url = appendEnvParam(`/api/containers/${currentContainerId}/logs/stream?tail=${tailCount}${since ? `&since=${since}` : ''}${until ? `&until=${until}` : ''}`, envId);
			eventSource = new EventSource(url);

			eventSource.addEventListener('connected', () => {
				isConnected = true;
				loading = false;
				connectionError = null;
				reconnectAttempts = 0; // Reset on successful connection
				stopOfflinePolling(); // Stop polling since we're connected
			});

			eventSource.addEventListener('log', (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.text) {
						// Parse incoming text into discrete LogEntry items. A streaming chunk
						// may begin/end mid-line; streamCarryover preserves the partial tail
						// across chunks so we don't split a line in the middle.
						const { entries, carryover } = parseLines(data.text, streamCarryover);
						streamCarryover = carryover;
						if (entries.length > 0) {
							pendingEntries.push(...entries);
							scheduleFlush();
						}
					}
				} catch {
					// Ignore parse errors
				}
			});

			eventSource.addEventListener('error', (event: Event) => {
				try {
					const data = JSON.parse((event as MessageEvent).data);
					connectionError = data.error || 'Connection error';
				} catch {
					connectionError = 'Connection error';
				}
				handleStreamError();
			});

			eventSource.addEventListener('end', () => {
				// Container stopped or stream ended normally
				// Close EventSource immediately to prevent onerror from firing
				if (eventSource) {
					eventSource.close();
					eventSource = null;
				}
				isConnected = false;
				connectionError = null;

				// Fetch historical logs to get any final output
				fetchLogs();

				// Start polling for container restart
				startOfflinePolling();
			});

			eventSource.onerror = () => {
				// EventSource error - could be network issue, server down, etc.
				// Skip if EventSource was already closed (e.g., by 'end' event handler)
				if (!eventSource) return;
				handleStreamError();
			};
		} catch (error) {
			console.error('Failed to start streaming:', error);
			connectionError = 'Failed to start streaming';
			isConnected = false;
			loading = false;
		}
	}

	// Handle stream errors with reconnection logic
	function handleStreamError() {
		isConnected = false;
		loading = false;

		// Close the broken connection
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}

		// Don't reconnect if streaming is disabled or no container selected
		if (!streamingEnabled || !containerId || !visible) return;

		// Check if we should attempt reconnection
		if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
			reconnectAttempts++;
			connectionError = `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;

			// Clear any existing reconnect timeout
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
			}

			// Schedule reconnection
			reconnectTimeout = setTimeout(() => {
				if (streamingEnabled && containerId && visible) {
					loading = true;
					startStreaming();
				}
			}, RECONNECT_DELAY);
		} else {
			// Max attempts reached - fall back to one-time log fetch
			connectionError = null;
			fetchLogs();
		}
	}

	// Manual retry connection
	function retryConnection() {
		reconnectAttempts = 0;
		connectionError = null;
		logs = [];
		streamCarryover = '';
		loading = true;
		startStreaming();
	}

	// Stop SSE streaming
	function stopStreaming(resetAttempts = true) {
		// Flush any buffered text before stopping
		flushLogs();
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
			reconnectTimeout = null;
		}
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		stopOfflinePolling();
		isConnected = false;
		if (resetAttempts) {
			reconnectAttempts = 0;
			connectionError = null;
		}
	}

	// Offline polling - periodically try to reconnect when container restarts
	function startOfflinePolling() {
		stopOfflinePolling(); // Clear any existing interval
		if (!streamingEnabled || !containerId || !visible) return;

		offlinePollingInterval = setInterval(async () => {
			// Try to reconnect
			if (!isConnected && !eventSource && streamingEnabled && visible) {
				reconnectAttempts = 0;
				loading = true;
				startStreaming();
			}
		}, OFFLINE_POLL_INTERVAL);
	}

	function stopOfflinePolling() {
		if (offlinePollingInterval) {
			clearInterval(offlinePollingInterval);
			offlinePollingInterval = null;
		}
	}

	// Toggle streaming on/off
	function toggleStreaming() {
		streamingEnabled = !streamingEnabled;
		saveSettings();
		if (streamingEnabled && containerId && visible) {
			logs = [];
			streamCarryover = '';
			reconnectAttempts = 0;
			connectionError = null;
			loading = true;
			startStreaming();
		} else {
			stopStreaming();
		}
	}

	// Handle tab visibility changes (e.g., user switches back from another tab)
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible' && visible && streamingEnabled && containerId) {
			// Tab became visible - check and restore connection

			// Clear any pending reconnection timer
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
				reconnectTimeout = null;
			}

			// Reset reconnection counter for fresh attempts
			reconnectAttempts = 0;
			connectionError = null;

			// Reconnect if EventSource is closed or in error state
			if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
				loading = true;
				startStreaming();
			}
		}
	}

	// Errors aren't log content — surface them via connectionError so the panel
	// can show them outside the LogEntry stream.
	async function fetchLogs() {
		if (!containerId) return;
		loading = true;
		connectionError = null;
		try {
			const since = getSinceParam();
			const until = getUntilParam();
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}/logs?tail=${tailCount}${since ? `&since=${since}` : ''}${until ? `&until=${until}` : ''}`, envId));
			const data = await response.json();
			if (!response.ok) {
				connectionError = `Failed to fetch logs: ${data.error || response.statusText}`;
				logs = [];
				return;
			}
			const { entries } = parseLines(data.logs || '');
			logs = entries;
			scrollToBottom();
		} catch (error) {
			console.error('Failed to fetch logs:', error);
			connectionError = `Failed to fetch logs: ${error instanceof Error ? error.message : 'Unknown error'}`;
			logs = [];
		} finally {
			loading = false;
		}
	}

	function handleClose() {
		stopStreaming();
		logs = [];
		streamCarryover = '';
		onClose();
	}

	// Toggle auto-scroll
	function toggleAutoScroll() {
		autoScroll = !autoScroll;
		saveSettings();
	}

	// Toggle word wrap
	function toggleWordWrap() {
		wordWrap = !wordWrap;
		saveSettings();
	}

	// Update font size
	function updateFontSize(newSize: number) {
		fontSize = newSize;
		saveSettings();
	}

	// Serialize the current buffer to plain text. Honors the timestamp toggle so
	// users get what they see on screen.
	function logsToText(): string {
		return logs
			.map(e => (showTimestamps && e.timestamp ? `${e.timestamp} ${e.text}` : e.text))
			.join('\n');
	}

	async function copyLogs() {
		if (logs.length > 0) {
			await copyToClipboard(logsToText());
		}
	}

	function downloadLogs() {
		if (logs.length > 0 && containerName) {
			const blob = new Blob([logsToText()], { type: 'text/plain' });
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

	// Clear logs buffer
	function clearLogs() {
		logs = [];
		pendingEntries = [];
		streamCarryover = '';
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
		saveSettings();
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

	// Filter pass — array op, not regex over a string. Empty query short-circuits.
	let filteredLogs = $derived.by(() => {
		const query = logSearchQuery.trim();
		if (!logSearchFilterMode || !query) return logs;
		const q = query.toLowerCase();
		return logs.filter(e => e.text.toLowerCase().includes(q));
	});

	// Update match count after render. Track filteredLogs + query so this re-runs
	// when the displayed buffer or the search input changes.
	$effect(() => {
		filteredLogs;
		logSearchQuery;
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

	// Start streaming when container changes and is visible
	$effect(() => {
		if (containerId && visible && streamingEnabled) {
			logs = [];
			streamCarryover = '';
			loading = true;
			reconnectAttempts = 0;
			connectionError = null;
			startStreaming();
		}
	});

	// Clean up when not visible
	$effect(() => {
		if (!visible) {
			stopStreaming();
		}
	});

	onMount(() => {
		loadSettings();
		// Listen for tab visibility changes to reconnect when user returns
		document.addEventListener('visibilitychange', handleVisibilityChange);
		// Chrome 77+ Page Lifecycle API - fires when frozen tab is resumed
		document.addEventListener('resume', handleVisibilityChange);
	});

	onDestroy(() => {
		// Clean up document event listeners in case destroyed mid-drag
		document.removeEventListener('mousemove', handleDrag);
		document.removeEventListener('mouseup', stopDrag);
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		document.removeEventListener('resume', handleVisibilityChange);
		// Flush pending text and clean up timers
		flushLogs();
		stopStreaming();
	});
</script>

<!-- Always keep mounted, use display:none to hide while preserving content -->
<div
	bind:this={panelRef}
	class="border rounded-lg flex flex-col w-full transition-colors {darkMode ? 'bg-zinc-950 border-zinc-800' : 'bg-gray-50 border-gray-300'}"
	class:hidden={!visible}
	class:h-full={fillHeight}
	style="{fillHeight ? '' : `height: ${panelHeight}px;`}"
>
	<!-- Drag handle -->
	<div
		role="separator"
		aria-orientation="horizontal"
		class="h-2 cursor-ns-resize flex items-center justify-center transition-colors rounded-t-lg {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-200'}"
		onmousedown={startDrag}
	>
		<GripHorizontal class="w-8 h-4 {darkMode ? 'text-zinc-600' : 'text-gray-400'}" />
	</div>

	<!-- Header -->
	<div class="flex items-center justify-between px-3 py-1.5 border-b transition-colors {darkMode ? 'border-zinc-800 bg-zinc-900/50' : 'border-gray-300 bg-gray-100'}">
		<div class="flex items-center gap-2 min-w-[120px]">
			<!-- Connection status indicator -->
			{#if streamingEnabled}
				{#if isConnected}
					<div class="flex items-center gap-1.5 transition-opacity duration-300" title="Connected - Live streaming">
						<Wifi class="w-3.5 h-3.5 text-green-500" />
						<span class="text-xs text-green-500 font-medium">Live</span>
					</div>
				{:else if loading}
					<div class="flex items-center gap-1.5 transition-opacity duration-300" title="Connecting...">
						<RefreshCw class="w-3.5 h-3.5 animate-spin {darkMode ? 'text-amber-500' : 'text-amber-600'}" />
						<span class="text-xs {darkMode ? 'text-amber-500' : 'text-amber-600'}">Connecting...</span>
					</div>
				{:else if connectionError}
					<button
						onclick={retryConnection}
						class="flex items-center gap-1.5 transition-opacity duration-300 hover:opacity-80"
						title={connectionError}
					>
						<WifiOff class="w-3.5 h-3.5 {darkMode ? 'text-zinc-500' : 'text-gray-400'}" />
						<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">Disconnected</span>
					</button>
				{:else}
					<button
						onclick={retryConnection}
						class="flex items-center gap-1.5 transition-opacity duration-300 hover:opacity-80"
						title="Click to reconnect"
					>
						<WifiOff class="w-3.5 h-3.5 {darkMode ? 'text-zinc-500' : 'text-gray-400'}" />
						<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">Offline</span>
					</button>
				{/if}
			{:else}
				<div class="flex items-center gap-1.5 transition-opacity duration-300" title="Streaming paused">
					<Pause class="w-3.5 h-3.5 {darkMode ? 'text-zinc-500' : 'text-gray-400'}" />
					<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">Paused</span>
				</div>
			{/if}
			<span class="text-xs {darkMode ? 'text-zinc-400' : 'text-gray-500'}">|</span>
			<span class="text-xs font-medium {darkMode ? 'text-zinc-200' : 'text-gray-800'} truncate max-w-[150px]" title={containerName}>{containerName}</span>
		</div>
		<div class="flex items-center gap-2">
			<!-- Streaming toggle -->
			<button
				onclick={toggleStreaming}
				class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors {streamingEnabled ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-300'}"
				title={streamingEnabled ? 'Pause live streaming' : 'Resume live streaming'}
			>
				{#if streamingEnabled}
					<Pause class="w-3 h-3" />
				{:else}
					<Play class="w-3 h-3" />
				{/if}
			</button>
			<!-- Tail lines selector -->
			<Select.Root type="single" value={tailCount} onValueChange={(v) => { tailCount = v; saveSettings(); reloadLogs(); }}>
				<Select.Trigger size="sm" class="!h-auto !py-0.5 w-[52px] text-xs px-1.5 {darkMode ? 'bg-zinc-800 border-zinc-700 text-zinc-300' : 'bg-white border-gray-300 text-gray-700'} [&_svg]:size-3" title="Number of log lines to load">
					<span>{tailOptions.find(o => o.value === tailCount)?.label ?? tailCount}</span>
				</Select.Trigger>
				<Select.Content>
					{#each tailOptions as opt}
						<Select.Item value={opt.value} label={opt.label}>{opt.label} lines</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<!-- Time range filter -->
			<LogTimeRangeFilter
				bind:sinceDate
				bind:sinceTime
				bind:untilDate
				bind:untilTime
				{darkMode}
				onApply={reloadLogs}
				onClear={reloadLogs}
			/>
			<!-- Auto-scroll button -->
			<button
				onclick={toggleAutoScroll}
				class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors {autoScroll ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400' : 'bg-amber-500/30 ring-1 ring-amber-600/50 text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-300'}"
				title="Toggle auto-scroll"
			>
				<ArrowDownToLine class="w-3 h-3" />
			</button>
			<!-- Font size -->
			<Select.Root type="single" value={String(fontSize)} onValueChange={(v) => updateFontSize(Number(v))}>
				<Select.Trigger size="sm" class="!h-auto !py-0.5 w-14 text-xs px-1.5 {darkMode ? 'bg-zinc-800 border-zinc-700 text-zinc-300' : 'bg-white border-gray-300 text-gray-700'} [&_svg]:size-3">
					<span>{fontSize}px</span>
				</Select.Trigger>
				<Select.Content>
					{#each fontSizeOptions as size}
						<Select.Item value={String(size)} label="{size}px">{size}px</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<!-- Word wrap -->
			<button
				onclick={toggleWordWrap}
				class="p-1 rounded transition-colors {wordWrap ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'bg-amber-500/30 ring-1 ring-amber-600/50') : ''} {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title="Toggle word wrap"
			>
				<WrapText class="w-3 h-3 transition-colors {wordWrap ? (darkMode ? 'text-amber-400' : 'text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Timestamps toggle -->
			<button
				onclick={() => { showTimestamps = !showTimestamps; localStorage.setItem('dockhand-log-timestamps', String(showTimestamps)); }}
				class="p-1 rounded transition-colors {showTimestamps ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'bg-amber-500/30 ring-1 ring-amber-600/50') : ''} {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title={showTimestamps ? 'Hide timestamps' : 'Show timestamps'}
			>
				<Clock class="w-3 h-3 transition-colors {showTimestamps ? (darkMode ? 'text-amber-400' : 'text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Container name toggle -->
			<button
				onclick={() => { showContainerName = !showContainerName; localStorage.setItem('dockhand-log-container-name', String(showContainerName)); }}
				class="p-1 rounded transition-colors {showContainerName ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'bg-amber-500/30 ring-1 ring-amber-600/50') : ''} {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title={showContainerName ? 'Hide container name prefix' : 'Show container name prefix'}
			>
				<Tag class="w-3 h-3 transition-colors {showContainerName ? (darkMode ? 'text-amber-400' : 'text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Line numbers -->
			<button
				onclick={() => { showLineNumbers = !showLineNumbers; saveSettings(); }}
				class="p-1 rounded transition-colors {showLineNumbers ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'bg-amber-500/30 ring-1 ring-amber-600/50') : ''} {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title={showLineNumbers ? 'Hide line numbers' : 'Show line numbers'}
			>
				<Hash class="w-3 h-3 transition-colors {showLineNumbers ? (darkMode ? 'text-amber-400' : 'text-amber-700') : darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Theme toggle -->
			<button
				onclick={toggleTheme}
				class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
			>
				{#if darkMode}
					<Sun class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
				{:else}
					<Moon class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
				{/if}
			</button>
			<!-- Search -->
			{#if logSearchActive}
				<div class="flex items-center gap-1 rounded px-1.5 py-0.5 {darkMode ? 'bg-zinc-800' : 'bg-gray-200'}">
					<Search class="w-3 h-3 text-amber-400" />
					<input
						bind:this={logSearchInputRef}
						type="text"
						placeholder="Search..."
						bind:value={logSearchQuery}
						onkeydown={handleLogSearchKeydown}
						class="bg-transparent border-none outline-none text-xs w-20 {darkMode ? 'text-zinc-200 placeholder:text-zinc-500' : 'text-gray-800 placeholder:text-gray-400'}"
					/>
					<button
						onclick={toggleSearchFilterMode}
						class="p-0.5 rounded transition-colors {logSearchFilterMode ? (darkMode ? 'bg-amber-500/20 ring-1 ring-amber-500/50' : 'bg-amber-500/30 ring-1 ring-amber-600/50') : darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}"
						title={logSearchFilterMode ? 'Show all lines (filter mode active)' : 'Hide non-matching lines'}
					>
						<Filter class="w-3 h-3 transition-colors {logSearchFilterMode ? (darkMode ? 'text-amber-400' : 'text-amber-700') : darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
					</button>
					{#if matchCount > 0}
						<span class="text-xs {darkMode ? 'text-zinc-400' : 'text-gray-500'}">{currentMatchIndex + 1}/{matchCount}</span>
					{:else if logSearchQuery}
						<span class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-400'}">0/0</span>
					{/if}
					<button onclick={() => navigateMatch('prev')} class="p-0.5 rounded {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Previous">
						<ChevronUp class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
					</button>
					<button onclick={() => navigateMatch('next')} class="p-0.5 rounded {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Next">
						<ChevronDown class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
					</button>
					<button onclick={closeLogSearch} class="p-0.5 rounded {darkMode ? 'hover:bg-zinc-700' : 'hover:bg-gray-300'}" title="Close">
						<X class="w-3 h-3 {darkMode ? 'text-zinc-400' : 'text-gray-500'}" />
					</button>
				</div>
			{:else}
				<button
					onclick={toggleLogSearch}
					class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
					title="Search logs"
				>
					<Search class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
				</button>
			{/if}
			<!-- Copy -->
			<button
				onclick={copyLogs}
				class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title="Copy logs"
			>
				<Copy class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Download -->
			<button
				onclick={downloadLogs}
				class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title="Download logs"
			>
				<Download class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Clear -->
			<button
				onclick={clearLogs}
				class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title="Clear logs"
			>
				<Eraser class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Refresh -->
			<button
				onclick={fetchLogs}
				class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
				title="Refresh logs"
			>
				<RefreshCw class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
			</button>
			<!-- Close -->
			{#if showCloseButton}
				<button
					onclick={handleClose}
					class="p-1 rounded transition-colors {darkMode ? 'hover:bg-zinc-800' : 'hover:bg-gray-300'}"
					title="Close logs"
				>
					<X class="w-3 h-3 {darkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-500 hover:text-gray-700'}" />
				</button>
			{/if}
		</div>
	</div>

	<!-- Logs content -->
	<div bind:this={logsRef} onscroll={handleLogsScroll} class="flex-1 overflow-auto p-3">
		{#if logs.length > 0}
			<pre class="logs-fade-in {wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'} {showLineNumbers ? 'show-line-numbers' : ''} {darkMode ? 'text-zinc-50' : 'text-gray-900'}" style="font-size: {fontSize}px; font-family: {terminalFontFamily()};">{#each filteredLogs as e (e.id)}<div class="log-line">{#if showTimestamps && e.timestamp}<span class="log-ts">{renderTimestamp(e.timestamp)}</span>{' '}{/if}{#if showContainerName && containerName}<span class="log-cname">[{containerName}]</span>{' '}{/if}<span>{@html renderLineHtml(e, logSearchQuery.trim())}</span></div>{/each}</pre>
		{:else if loading}
			<p class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-500'}">Connecting to log stream...</p>
		{:else}
			<p class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-500'}">No logs available</p>
		{/if}
	</div>
</div>

<style>
	:global(.log-ts) {
		color: rgb(113, 113, 122);
	}
	:global(.log-cname) {
		color: rgb(161, 161, 170);
	}
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

	/* Fade-in animation for logs */
	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.logs-fade-in {
		animation: fadeIn 0.3s ease-out;
	}
</style>
