<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { themeStore } from '$lib/stores/theme';
	import { getMonospaceFont } from '$lib/themes';

	// Dynamic imports for browser-only xterm
	let TerminalClass: any;
	let FitAddon: any;
	let WebLinksAddon: any;
	let xtermLoaded = $state(false);

	interface Props {
		containerId: string;
		containerName: string;
		shell: string;
		user: string;
		envId: number | null;
		fontSize?: number;
		autoConnect?: boolean;
	}

	let { containerId, containerName, shell, user, envId, fontSize = 13, autoConnect = true }: Props = $props();

	let terminal: any = null;
	let fitAddon: any = null;
	let ws: WebSocket | null = null;
	let terminalRef: HTMLDivElement;

	let connected = $state(false);
	let error = $state<string | null>(null);

	// Expose these via bindable props
	export function getConnected() { return connected; }
	export function getError() { return error; }

	export function clear() {
		terminal?.clear();
		terminal?.focus();
	}

	export function focus() {
		terminal?.focus();
	}

	export function fit() {
		fitAddon?.fit();
	}

	export async function copyOutput(): Promise<string> {
		if (!terminal) return '';
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
		return text.trim();
	}

	export function setFontSize(size: number) {
		if (terminal) {
			terminal.options.fontSize = size;
			fitAddon?.fit();
		}
	}

	export function reconnect() {
		if (ws) {
			ws.close();
			ws = null;
		}
		connected = false;
		terminal?.writeln('\x1b[90m\r\nReconnecting...\x1b[0m');
		connect();
	}

	export function disconnect() {
		if (ws) {
			ws.close();
			ws = null;
		}
		connected = false;
	}

	export function dispose() {
		if (ws) ws.close();
		if (terminal) terminal.dispose();
		ws = null;
		terminal = null;
		fitAddon = null;
	}

	function getTerminalFontFamily(): string {
		const fontMeta = getMonospaceFont($themeStore.terminalFont);
		return fontMeta?.family || 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
	}

	function initTerminal() {
		if (!terminalRef || !xtermLoaded || terminal) return;

		terminal = new TerminalClass({
			cursorBlink: true,
			fontFamily: getTerminalFontFamily(),
			fontSize,
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
				clear();
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

		if (autoConnect) {
			connect();
		}
	}

	function connect() {
		if (!terminal) return;

		error = null;
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsHost = window.location.hostname;
		// In dev mode (vite), connect directly to the WS server on port 5174
		// In production, connect to the same port as the app
		const isDev = import.meta.env.DEV;
		const portPart = isDev ? ':5174' : (window.location.port ? `:${window.location.port}` : '');
		let wsUrl = `${protocol}//${wsHost}${portPart}/api/containers/${containerId}/exec?shell=${encodeURIComponent(shell)}&user=${encodeURIComponent(user)}`;
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
			} catch {
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

	function handleResize() {
		fitAddon?.fit();
	}

	$effect(() => {
		if (xtermLoaded && terminalRef && !terminal) {
			setTimeout(initTerminal, 50);
		}
	});

	// Update font when terminal font preference changes
	$effect(() => {
		if (terminal && $themeStore.terminalFont) {
			const fontFamily = getTerminalFontFamily();
			terminal.options.fontFamily = fontFamily;
			fitAddon?.fit();
		}
	});

	onMount(async () => {
		window.addEventListener('resize', handleResize);

		const xtermModule = await import('@xterm/xterm');
		const fitModule = await import('@xterm/addon-fit');
		const webLinksModule = await import('@xterm/addon-web-links');

		TerminalClass = xtermModule.Terminal || xtermModule.default?.Terminal;
		FitAddon = fitModule.FitAddon || fitModule.default?.FitAddon;
		WebLinksAddon = webLinksModule.WebLinksAddon || webLinksModule.default?.WebLinksAddon;

		await import('@xterm/xterm/css/xterm.css');
		xtermLoaded = true;
	});

	onDestroy(() => {
		window.removeEventListener('resize', handleResize);
		dispose();
	});
</script>

<div bind:this={terminalRef} class="h-full w-full terminal-container"></div>

<style>
	.terminal-container :global(.xterm) {
		height: 100%;
		padding: 4px;
	}

	.terminal-container :global(.xterm-viewport) {
		overflow-y: auto !important;
	}
</style>
