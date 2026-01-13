<script lang="ts">
	import { page } from '$app/stores';
	import { appendEnvParam, currentEnvironment } from '$lib/stores/environment';
	import type { ContainerInfo } from '$lib/types';
	import { Terminal as TerminalIcon } from 'lucide-svelte';
	import { onDestroy, onMount } from 'svelte';

	// Dynamic imports for browser-only xterm
	let Terminal: any;
	let FitAddon: any;
	let WebLinksAddon: any;
	let xtermLoaded = $state(false);

	let terminalRef = $state<HTMLDivElement | undefined>();
	let terminal = $state<any>(null);
	let fitAddon = $state<any>(null);
	let ws = $state<WebSocket | null>(null);
	let connected = $state(false);
	let error = $state<string | null>(null);
	let containerName = $state('');
	let containerValid = $state(false);
	let validationError = $state<string | null>(null);
	let envId = $state<number | null>(null);
	let containerInfo = $state<ContainerInfo | null>(null);

	// Get params from URL
	let containerId = $derived($page.params.id);
	let name = $derived($page.url.searchParams.get('name') || 'Container');

	// Subscribe to environment changes
	currentEnvironment.subscribe((env) => {
		envId = env?.id ?? null;
		if (env) {
			validateContainer();
		}
	});

	// Check if container can be attached to
	function canAttachToContainer(container: ContainerInfo): boolean {
		// Container must be running
		if (container.state !== 'running') {
			return false;
		}
		return true;
	}

	// Get validation error message for a container
	function getAttachValidationError(container: ContainerInfo): string | null {
		if (container.state !== 'running') {
			return `Container is ${container.state} (must be running)`;
		}
		return null;
	}

	async function validateContainer() {
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}`, envId));
			if (!response.ok) {
				validationError = 'Container not found';
				containerValid = false;
				return;
			}

			const container = await response.json();
			containerInfo = container;

			if (!canAttachToContainer(container)) {
				validationError = getAttachValidationError(container);
				containerValid = false;
			} else {
				validationError = null;
				containerValid = true;
			}
		} catch (err) {
			console.error('Failed to validate container:', err);
			validationError = 'Failed to validate container';
			containerValid = false;
		}
	}

	function initTerminal() {
		if (!terminalRef || terminal || !xtermLoaded) return;

		// Validate container before initializing terminal
		if (!containerValid || !containerInfo) {
			return;
		}

		containerName = containerInfo.name || name;

		terminal = new Terminal({
			cursorBlink: true,
			fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			fontSize: 14,
			theme: {
				background: '#0c0c0c',
				foreground: '#cccccc',
				cursor: '#ffffff',
				cursorAccent: '#000000',
				selectionBackground: '#264f78',
				black: '#0c0c0c',
				red: '#c50f1f',
				green: '#13a10e',
				yellow: '#c19c00',
				blue: '#0037da',
				magenta: '#881798',
				cyan: '#3a96dd',
				white: '#cccccc',
				brightBlack: '#767676',
				brightRed: '#e74856',
				brightGreen: '#16c60c',
				brightYellow: '#f9f1a5',
				brightBlue: '#3b78ff',
				brightMagenta: '#b4009e',
				brightCyan: '#61d6d6',
				brightWhite: '#f2f2f2'
			}
		});

		fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.loadAddon(new WebLinksAddon());

		terminal.open(terminalRef);
		fitAddon.fit();

		// Handle Ctrl+L to clear terminal
		terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
				e.preventDefault();
				terminal?.clear();
				return false;
			}
			return true;
		});

		// Handle terminal input
		terminal.onData((data: string) => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'input', data }));
			}
		});

		// Handle resize
		terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'resize', cols, rows }));
			}
		});

		// Connect to container
		connect();
	}

	function connect() {
		if (!terminal || !containerValid) return;

		error = null;
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const isDev = import.meta.env.DEV;
		const wsHost = window.location.hostname;
		const portPart = isDev ? ':5174' : window.location.port ? `:${window.location.port}` : '';
		let wsUrl = `${protocol}//${wsHost}${portPart}/api/containers/${containerId}/attach`;
		if (envId) {
			wsUrl += `?envId=${envId}`;
		}

		terminal.writeln(`\x1b[90mAttaching to ${containerName}...\x1b[0m`);
		terminal.writeln(`\x1b[90mContainer: ${containerInfo?.image || 'unknown'}\x1b[0m`);
		terminal.writeln('');

		ws = new WebSocket(wsUrl);

		ws.onopen = () => {
			connected = true;
			document.title = `Attach - ${containerName}`;
			terminal?.focus();
			// Send initial resize
			if (fitAddon && terminal) {
				const dims = fitAddon.proposeDimensions();
				if (dims) {
					ws?.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
				}
			}
		};

		ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data);
				if (msg.type === 'output') {
					terminal?.write(msg.data);
				} else if (msg.type === 'error') {
					error = msg.message;
					terminal?.writeln(`\x1b[31mError: ${msg.message}\x1b[0m`);
				} else if (msg.type === 'exit') {
					terminal?.writeln('\x1b[90m\r\nAttachment ended.\x1b[0m');
					connected = false;
				}
			} catch (e) {
				terminal?.write(event.data);
			}
		};

		ws.onerror = (e) => {
			console.error('WebSocket error:', e);
			error = 'Connection error';
			terminal?.writeln('\x1b[31mConnection error\x1b[0m');
		};

		ws.onclose = () => {
			connected = false;
			terminal?.writeln('\x1b[90mDetached.\x1b[0m');
		};
	}

	function disconnect() {
		if (ws) {
			ws.close();
			ws = null;
		}
	}

	function cleanup() {
		disconnect();
		if (terminal) {
			terminal.dispose();
			terminal = null;
		}
		fitAddon = null;
	}

	// Handle window resize
	function handleResize() {
		if (fitAddon && terminal) {
			fitAddon.fit();
		}
	}

	onMount(async () => {
		window.addEventListener('resize', handleResize);

		// Validate container immediately
		await validateContainer();

		// Dynamically load xterm modules (browser only)
		const xtermModule = await import('@xterm/xterm');
		const fitModule = await import('@xterm/addon-fit');
		const webLinksModule = await import('@xterm/addon-web-links');

		// Handle both ESM and CommonJS exports
		Terminal = xtermModule.Terminal || xtermModule.default?.Terminal;
		FitAddon = fitModule.FitAddon || fitModule.default?.FitAddon;
		WebLinksAddon = webLinksModule.WebLinksAddon || webLinksModule.default?.WebLinksAddon;

		// Load CSS
		await import('@xterm/xterm/css/xterm.css');
		xtermLoaded = true;

		// Initialize terminal after xterm is loaded
		setTimeout(() => {
			initTerminal();
		}, 100);
	});

	onDestroy(() => {
		window.removeEventListener('resize', handleResize);
		cleanup();
	});
</script>

<svelte:head>
	<title>Attach - {containerName || 'Loading...'}</title>
</svelte:head>

<div class="h-screen w-screen flex flex-col bg-[#0c0c0c]">
	<!-- Header -->
	<div
		class="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800 shrink-0"
	>
		<div class="flex items-center gap-2">
			<TerminalIcon class="w-4 h-4 text-zinc-400" />
			<span class="text-sm text-zinc-200 font-medium">{containerName || containerId}</span>
			{#if containerValid}
				{#if connected}
					<span class="inline-flex items-center gap-1 text-xs text-green-500">
						<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
						Attached
					</span>
				{:else}
					<span class="text-xs text-zinc-500">Connecting...</span>
				{/if}
			{:else if validationError}
				<span class="text-xs text-red-500">{validationError}</span>
			{:else}
				<span class="text-xs text-zinc-500">Validating...</span>
			{/if}
		</div>
		<div class="flex items-center gap-2 text-xs text-zinc-500">
			<span>Attach Mode</span>
		</div>
	</div>

	<!-- Terminal or Error message -->
	<div class="flex-1 p-2 overflow-hidden flex flex-col">
		{#if validationError}
			<div class="flex items-center justify-center h-full">
				<div class="text-center">
					<TerminalIcon class="w-12 h-12 mx-auto mb-3 opacity-50 text-red-500" />
					<p class="text-zinc-400 mb-2">{validationError}</p>
					<p class="text-zinc-600 text-sm">
						Go back to <a href="/attach" class="text-blue-500 hover:text-blue-400">attach</a> page
					</p>
				</div>
			</div>
		{:else if xtermLoaded && containerValid}
			<div bind:this={terminalRef} class="h-full w-full"></div>
		{:else}
			<div class="h-full w-full flex items-center justify-center">
				<span class="text-zinc-500">Loading...</span>
			</div>
		{/if}
	</div>
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		overflow: hidden;
	}

	:global(.xterm) {
		height: 100%;
		padding: 8px;
	}

	:global(.xterm-viewport) {
		overflow-y: auto !important;
	}
</style>
