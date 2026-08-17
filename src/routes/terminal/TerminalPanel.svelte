<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { X, GripHorizontal, RefreshCw, Copy, Trash2 } from 'lucide-svelte';
	import * as Select from '$lib/components/ui/select';
	import type { TerminalMode } from '$lib/types';
	import Terminal from './Terminal.svelte';

	interface Props {
		containerId: string;
		containerName: string;
		shell: string;
		user: string;
		mode?: TerminalMode;
		visible: boolean;
		envId: number | null;
		fillHeight?: boolean;
		onClose: () => void;
	}

	let { containerId, containerName, shell, user, mode = 'exec', visible, envId, fillHeight = false, onClose }: Props = $props();

	let terminalComponent: ReturnType<typeof Terminal>;
	let panelRef: HTMLDivElement;
	let connected = $state(false);

	// Font size options
	let fontSize = $state(13);
	const fontSizeOptions = [10, 12, 13, 14, 16];

	// Panel height with localStorage persistence
	const STORAGE_KEY = 'dockhand-terminal-panel-height';
	const SETTINGS_STORAGE_KEY = 'dockhand-terminal-settings';
	const DEFAULT_HEIGHT = 300;
	const MIN_HEIGHT = 150;
	const MAX_HEIGHT = 600;

	let panelHeight = $state(DEFAULT_HEIGHT);
	let isDragging = $state(false);

	// Load saved settings from localStorage
	function loadSettings() {
		if (typeof window !== 'undefined') {
			// Load height
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
					if (settings.fontSize !== undefined && fontSizeOptions.includes(settings.fontSize)) {
						fontSize = settings.fontSize;
					}
				} catch {
					// ignore parsing errors
				}
			}
		}
	}

	// Save height to localStorage
	function saveHeight() {
		if (typeof window !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, String(panelHeight));
		}
	}

	// Save settings to localStorage
	function saveSettings() {
		if (typeof window !== 'undefined') {
			localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
				fontSize
			}));
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
		// Fit terminal after resize
		setTimeout(() => terminalComponent?.fit(), 50);
	}

	// Update font size
	function updateFontSize(newSize: number) {
		fontSize = newSize;
		terminalComponent?.setFontSize(newSize);
		saveSettings();
	}

	function handleClose() {
		terminalComponent?.dispose();
		connected = false;
		onClose();
	}

	// Poll connected state from terminal component
	$effect(() => {
		if (terminalComponent) {
			const interval = setInterval(() => {
				connected = terminalComponent.getConnected();
			}, 500);
			return () => clearInterval(interval);
		}
	});

	// Fit terminal and focus when becoming visible
	$effect(() => {
		if (visible && terminalComponent) {
			setTimeout(() => {
				terminalComponent?.fit();
				terminalComponent?.focus();
			}, 50);
		}
	});

	onMount(() => {
		loadSettings();
	});

	onDestroy(() => {
		// Clean up drag listeners if component destroyed while dragging
		document.removeEventListener('mousemove', handleDrag);
		document.removeEventListener('mouseup', stopDrag);
	});
</script>

<!-- Always keep mounted, use fixed off-screen to hide while preserving xterm dimensions -->
<div
	bind:this={panelRef}
	class="border rounded-lg bg-zinc-950 flex flex-col w-full"
	class:fixed={!visible}
	class:invisible={!visible}
	class:pointer-events-none={!visible}
	class:h-full={fillHeight}
	style="{fillHeight ? '' : `height: ${panelHeight}px;`} {!visible ? 'left: -9999px;' : ''}"
>
	<!-- Drag handle -->
	<div
		role="separator"
		aria-orientation="horizontal"
		class="h-2 cursor-ns-resize flex items-center justify-center hover:bg-zinc-800 transition-colors rounded-t-lg"
		onmousedown={startDrag}
	>
		<GripHorizontal class="w-8 h-4 text-zinc-600" />
	</div>

	<!-- Header -->
	<div class="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/50">
		<div class="flex items-center gap-2">
			<span class="text-xs text-zinc-400">{mode === 'attach' ? 'Attach:' : 'Terminal:'}</span>
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
				<Select.Trigger size="sm" class="!h-5 !py-0 w-14 bg-zinc-800 border-zinc-700 text-xs text-zinc-300 px-1.5 [&_svg]:size-3">
					<span>{fontSize}px</span>
				</Select.Trigger>
				<Select.Content>
					{#each fontSizeOptions as size}
						<Select.Item value={String(size)} label="{size}px" class="pe-2 [&>span:first-child]:hidden">{size}px</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<!-- Clear -->
			<button
				onclick={() => terminalComponent?.clear()}
				class="p-1 rounded hover:bg-zinc-800 transition-colors"
				title="Clear terminal (Ctrl+L)"
			>
				<Trash2 class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
			</button>
			<!-- Copy -->
			<button
				onclick={() => terminalComponent?.copyOutput()}
				class="p-1 rounded hover:bg-zinc-800 transition-colors"
				title="Copy output"
			>
				<Copy class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
			</button>
			<!-- Reconnect -->
			{#if !connected}
				<button
					onclick={() => terminalComponent?.reconnect()}
					class="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-amber-500/20 ring-1 ring-amber-500/50 text-amber-400 hover:bg-amber-500/30 transition-colors"
					title="Reconnect"
				>
					<RefreshCw class="w-3 h-3" />
				</button>
			{/if}
			<!-- Close -->
			<button
				onclick={handleClose}
				class="p-1 rounded hover:bg-zinc-800 transition-colors"
				title="Close terminal"
			>
				<X class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
			</button>
		</div>
	</div>

	<!-- Terminal content -->
	<div class="flex-1 overflow-hidden p-1">
		{#key `${containerId}-${mode}-${shell}-${user}`}
			<Terminal
				bind:this={terminalComponent}
				{containerId}
				{containerName}
				{shell}
				{user}
				{mode}
				{envId}
				{fontSize}
			/>
		{/key}
	</div>
</div>
