<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { X, GripHorizontal, RefreshCw, Copy, Download, WrapText, ArrowDownToLine, Search, ChevronUp, ChevronDown, Sun, Moon, Wifi, WifiOff, Pause, Play } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as Select from '$lib/components/ui/select';
	import { appSettings } from '$lib/stores/settings';
	import { themeStore } from '$lib/stores/theme';
	import { getMonospaceFont } from '$lib/themes';

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

	let logs = $state('');
	let loading = $state(false);
	let logsRef: HTMLDivElement;
	let panelRef: HTMLDivElement;
	let autoScroll = $state(true);
	let wordWrap = $state(true);
	let fontSize = $state(12);

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

	// Search state
	let logSearchActive = $state(false);
	let logSearchQuery = $state('');
	let currentMatchIndex = $state(0);
	let matchCount = $state(0);
	let logSearchInputRef: HTMLInputElement | undefined;

	const fontSizeOptions = [10, 12, 14, 16];

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
				streamingEnabled
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

	// Start SSE streaming for logs
	function startStreaming() {
		if (!containerId || !streamingEnabled) return;
		stopStreaming(false); // Don't reset reconnect attempts

		connectionError = null;
		const currentContainerId = containerId; // Capture for closure

		try {
			const url = appendEnvParam(`/api/containers/${currentContainerId}/logs/stream?tail=500`, envId);
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
						// Add container name prefix to each line if available
						let text = data.text;
						if (data.containerName) {
							// Split by lines, prefix each non-empty line, rejoin
							const lines = text.split('\n');
							text = lines.map((line: string, i: number) => {
								// Don't prefix empty lines at the end
								if (line === '' && i === lines.length - 1) return line;
								if (line === '') return line;
								return `[${data.containerName}] ${line}`;
							}).join('\n');
						}
						logs += text;

						// Apply log buffer size limit (convert KB to characters, roughly 1 char = 1 byte)
						const maxSize = $appSettings.logBufferSizeKb * 1024;
						if (logs.length > maxSize) {
							// Truncate from the beginning, keeping 80% of max size
							logs = logs.substring(logs.length - Math.floor(maxSize * 0.8));
						}

						// Auto-scroll to bottom
						if (autoScroll && logsRef) {
							setTimeout(() => {
								logsRef.scrollTop = logsRef.scrollHeight;
							}, 50);
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
		logs = '';
		loading = true;
		startStreaming();
	}

	// Stop SSE streaming
	function stopStreaming(resetAttempts = true) {
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
			logs = ''; // Clear logs and start fresh stream
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

	// Fallback fetch logs (for manual refresh or when streaming unavailable)
	async function fetchLogs() {
		if (!containerId) return;
		loading = true;
		connectionError = null;
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}/logs?tail=500`, envId));
			const data = await response.json();
			if (!response.ok) {
				logs = `Failed to fetch logs: ${data.error || response.statusText}`;
				return;
			}
			logs = data.logs || '';
			// Auto-scroll to bottom
			if (autoScroll && logsRef) {
				setTimeout(() => {
					logsRef.scrollTop = logsRef.scrollHeight;
				}, 50);
			}
		} catch (error) {
			console.error('Failed to fetch logs:', error);
			logs = `Failed to fetch logs: ${error instanceof Error ? error.message : 'Unknown error'}`;
		} finally {
			loading = false;
		}
	}

	function handleClose() {
		stopStreaming();
		logs = '';
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

	// ANSI color code to CSS class mapping
	const ansiColorMap: Record<string, string> = {
		'30': 'ansi-black',
		'31': 'ansi-red',
		'32': 'ansi-green',
		'33': 'ansi-yellow',
		'34': 'ansi-blue',
		'35': 'ansi-magenta',
		'36': 'ansi-cyan',
		'37': 'ansi-white',
		'90': 'ansi-bright-black',
		'91': 'ansi-bright-red',
		'92': 'ansi-bright-green',
		'93': 'ansi-bright-yellow',
		'94': 'ansi-bright-blue',
		'95': 'ansi-bright-magenta',
		'96': 'ansi-bright-cyan',
		'97': 'ansi-bright-white',
		'40': 'ansi-bg-black',
		'41': 'ansi-bg-red',
		'42': 'ansi-bg-green',
		'43': 'ansi-bg-yellow',
		'44': 'ansi-bg-blue',
		'45': 'ansi-bg-magenta',
		'46': 'ansi-bg-cyan',
		'47': 'ansi-bg-white',
		'1': 'ansi-bold',
		'2': 'ansi-dim',
		'3': 'ansi-italic',
		'4': 'ansi-underline',
	};

	// Convert ANSI escape codes to HTML spans with CSS classes
	function ansiToHtml(text: string): string {
		// Strip control characters
		let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1A]/g, '');

		// Escape HTML
		let escaped = escapeHtml(cleaned);

		// Match ANSI escape sequences
		const ansiRegex = /\x1b\[([0-9;]*)m/g;

		let result = '';
		let lastIndex = 0;
		let openSpans = 0;
		let match;

		while ((match = ansiRegex.exec(escaped)) !== null) {
			result += escaped.slice(lastIndex, match.index);
			lastIndex = ansiRegex.lastIndex;

			const codes = match[1].split(';').filter(c => c !== '');

			for (const code of codes) {
				if (code === '0' || code === '39' || code === '49' || code === '') {
					while (openSpans > 0) {
						result += '</span>';
						openSpans--;
					}
				} else if (ansiColorMap[code]) {
					result += `<span class="${ansiColorMap[code]}">`;
					openSpans++;
				}
			}
		}

		result += escaped.slice(lastIndex);

		while (openSpans > 0) {
			result += '</span>';
			openSpans--;
		}

		return result;
	}

	// Highlighted logs with search matches and ANSI color support
	let highlightedLogs = $derived(() => {
		const withAnsi = ansiToHtml(logs || '');
		if (!logSearchQuery.trim()) return withAnsi;

		const query = logSearchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const escapedQuery = escapeHtml(query);

		// Split by HTML tags and only process text parts
		const parts = withAnsi.split(/(<[^>]*>)/);
		const highlighted = parts.map(part => {
			if (part.startsWith('<')) return part;
			const regex = new RegExp(`(${escapedQuery})`, 'gi');
			return part.replace(regex, '<mark class="search-match">$1</mark>');
		}).join('');

		return highlighted;
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

	// Start streaming when container changes and is visible
	$effect(() => {
		if (containerId && visible && streamingEnabled) {
			logs = ''; // Clear previous logs
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
				<Select.Trigger size="sm" class="!h-5 !py-0 w-14 text-xs px-1.5 {darkMode ? 'bg-zinc-800 border-zinc-700 text-zinc-300' : 'bg-white border-gray-300 text-gray-700'} [&_svg]:size-3">
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
	<div bind:this={logsRef} class="flex-1 overflow-auto p-3">
		{#if logs}
			<pre class="logs-fade-in {wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'} {darkMode ? 'text-zinc-50' : 'text-gray-900'}" style="font-size: {fontSize}px; font-family: {terminalFontFamily()};">{@html highlightedLogs()}</pre>
		{:else if loading}
			<p class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-500'}">Connecting to log stream...</p>
		{:else}
			<p class="text-xs {darkMode ? 'text-zinc-500' : 'text-gray-500'}">No logs available</p>
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

	/* ANSI color classes - foreground colors */
	:global(.ansi-black) { color: #3f3f46; }
	:global(.ansi-red) { color: #ef4444; }
	:global(.ansi-green) { color: #22c55e; }
	:global(.ansi-yellow) { color: #eab308; }
	:global(.ansi-blue) { color: #3b82f6; }
	:global(.ansi-magenta) { color: #d946ef; }
	:global(.ansi-cyan) { color: #06b6d4; }
	:global(.ansi-white) { color: #e4e4e7; }

	/* Bright foreground colors */
	:global(.ansi-bright-black) { color: #71717a; }
	:global(.ansi-bright-red) { color: #f87171; }
	:global(.ansi-bright-green) { color: #4ade80; }
	:global(.ansi-bright-yellow) { color: #facc15; }
	:global(.ansi-bright-blue) { color: #60a5fa; }
	:global(.ansi-bright-magenta) { color: #e879f9; }
	:global(.ansi-bright-cyan) { color: #22d3ee; }
	:global(.ansi-bright-white) { color: #fafafa; }

	/* Background colors */
	:global(.ansi-bg-black) { background-color: #18181b; }
	:global(.ansi-bg-red) { background-color: #dc2626; }
	:global(.ansi-bg-green) { background-color: #16a34a; }
	:global(.ansi-bg-yellow) { background-color: #ca8a04; }
	:global(.ansi-bg-blue) { background-color: #2563eb; }
	:global(.ansi-bg-magenta) { background-color: #c026d3; }
	:global(.ansi-bg-cyan) { background-color: #0891b2; }
	:global(.ansi-bg-white) { background-color: #d4d4d8; }

	/* Text styles */
	:global(.ansi-bold) { font-weight: bold; }
	:global(.ansi-dim) { opacity: 0.7; }
	:global(.ansi-italic) { font-style: italic; }
	:global(.ansi-underline) { text-decoration: underline; }

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
