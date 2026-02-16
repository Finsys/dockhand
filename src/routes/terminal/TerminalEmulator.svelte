<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { RefreshCw, Copy, Trash2, Type } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as Select from '$lib/components/ui/select';

	// Dynamic imports for browser-only xterm
	let Terminal: any;
	let FitAddon: any;
	let WebLinksAddon: any;
	let xtermLoaded = $state(false);

	interface Props {
		containerId: string;
		containerName: string;
		shell: string;
		user: string;
		envId: number | null;
		class?: string;
	}

	let { containerId, containerName, shell, user, envId, class: className = '' }: Props = $props();

	// Single session for this terminal instance
	let terminal: any = null;
	let fitAddon: any = null;
	let ws: WebSocket | null = null;
	let sessionInitialized = $state(false);

	let terminalRef: HTMLDivElement;
	let connected = $state(false);
	let error = $state<string | null>(null);

	// Font size options
	let fontSize = $state(13);
	const fontSizeOptions = [10, 12, 13, 14, 16];

	// Clear terminal
	function clearTerminal() {
		if (terminal) {
			terminal.clear();
			terminal.focus();
		}
	}

	// Copy terminal output
	async function copyOutput() {
		if (terminal) {
			const buffer = terminal.buffer.active;
			let text = '';
			for (let i = 0; i < buffer.length; i++) {
				const line = buffer.getLine(i);
				if (line) {
					text += line.translateToString(true) + '\n';
				}
			}
			await copyToClipboard(text.trim());
			terminal.focus();
		}
	}

	// Update font size
	function updateFontSize(newSize: number) {
		fontSize = newSize;
		if (terminal) {
			terminal.options.fontSize = newSize;
			fitAddon?.fit();
		}
	}

	function initTerminal() {
		if (!terminalRef || !xtermLoaded) return;

		// If we already have a terminal, just re-attach it
		if (terminal && sessionInitialized) {
			terminal.open(terminalRef);
			fitAddon?.fit();
			terminal.focus();
			return;
		}

		// Create new terminal
		terminal = new Terminal({
			cursorBlink: true,
			fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			fontSize: fontSize,
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
				clearTerminal();
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

		sessionInitialized = true;

		// Connect to container
		connect();
	}

	function connect() {
		if (!terminal) return;

		error = null;
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		let wsUrl = `${protocol}//${window.location.host}/api/containers/${containerId}/exec?shell=${encodeURIComponent(shell)}&user=${encodeURIComponent(user)}`;
		if (envId) {
			wsUrl += `&envId=${envId}`;
		}

		terminal.writeln(`\x1b[90mConnecting to ${containerName}...\x1b[0m`);
		terminal.writeln(`\x1b[90mShell: ${shell}, User: ${user || 'default'}\x1b[0m`);
		terminal.writeln('');

		ws = new WebSocket(wsUrl);

		ws.onopen = () => {
			connected = true;
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
					terminal?.writeln('\x1b[90m\r\nSession ended.\x1b[0m');
					connected = false;
				}
			} catch (e) {
				terminal?.write(event.data);
			}
		};

		ws.onerror = () => {
			error = 'Connection error';
			terminal?.writeln('\x1b[31mConnection error\x1b[0m');
		};

		ws.onclose = () => {
			connected = false;
			terminal?.writeln('\x1b[90mDisconnected.\x1b[0m');
		};
	}

	function reconnect() {
		if (ws) {
			ws.close();
			ws = null;
		}
		connected = false;
		terminal?.writeln('\x1b[90m\r\nReconnecting...\x1b[0m');
		connect();
	}

	// Handle window resize
	function handleResize() {
		if (fitAddon && terminal) {
			fitAddon.fit();
		}
	}

	// Initialize terminal when DOM is ready
	$effect(() => {
		if (xtermLoaded && terminalRef && !sessionInitialized) {
			setTimeout(() => {
				initTerminal();
			}, 50);
		}
	});

	// Fit terminal on mount
	$effect(() => {
		if (sessionInitialized && fitAddon && terminal) {
			setTimeout(() => {
				fitAddon?.fit();
				terminal?.focus();
			}, 50);
		}
	});

	onMount(async () => {
		window.addEventListener('resize', handleResize);

		// Dynamically load xterm modules
		const xtermModule = await import('@xterm/xterm');
		const fitModule = await import('@xterm/addon-fit');
		const webLinksModule = await import('@xterm/addon-web-links');

		Terminal = xtermModule.Terminal || xtermModule.default?.Terminal;
		FitAddon = fitModule.FitAddon || fitModule.default?.FitAddon;
		WebLinksAddon = webLinksModule.WebLinksAddon || webLinksModule.default?.WebLinksAddon;

		await import('@xterm/xterm/css/xterm.css');
		xtermLoaded = true;
	});

	onDestroy(() => {
		window.removeEventListener('resize', handleResize);
		// Clean up
		if (ws) ws.close();
		if (terminal) terminal.dispose();
	});
</script>

<div class="flex flex-col bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden {className}">
	<!-- Header bar -->
	<div class="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
		<div class="flex items-center gap-2">
			<span class="text-xs text-zinc-400">Terminal:</span>
			<span class="text-xs text-zinc-200 font-medium">{containerName}</span>
			{#if connected}
				<span class="inline-flex items-center gap-1 text-xs text-green-500">
					<span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
					Connected
				</span>
			{:else}
				<span class="text-xs text-zinc-500">Disconnected</span>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<!-- Font size -->
			<Select.Root type="single" value={String(fontSize)} onValueChange={(v) => updateFontSize(Number(v))}>
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
			<!-- Clear -->
			<button
				onclick={clearTerminal}
				class="p-1 rounded hover:bg-zinc-800 transition-colors"
				title="Clear terminal (Ctrl+L)"
			>
				<Trash2 class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
			</button>
			<!-- Copy -->
			<button
				onclick={copyOutput}
				class="p-1 rounded hover:bg-zinc-800 transition-colors"
				title="Copy output"
			>
				<Copy class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
			</button>
			<!-- Reconnect -->
			{#if !connected}
				<button
					onclick={reconnect}
					class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400 hover:bg-amber-500/30 transition-colors"
					title="Reconnect"
				>
					<RefreshCw class="w-3 h-3" />
				</button>
			{/if}
		</div>
	</div>

	<!-- Terminal content -->
	<div class="flex-1 overflow-hidden p-1">
		<div bind:this={terminalRef} class="h-full w-full"></div>
	</div>
</div>

<style>
	:global(.xterm) {
		height: 100%;
		padding: 4px;
	}

	:global(.xterm-viewport) {
		overflow-y: auto !important;
	}
</style>
