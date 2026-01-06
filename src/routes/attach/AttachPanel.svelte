<script lang="ts">
	import { Copy, RefreshCw, Trash2, X } from 'lucide-svelte';
	import { onDestroy, onMount } from 'svelte';
	import AttachTerminal from './AttachTerminal.svelte';

	interface Props {
		containerId: string;
		containerName: string;
		visible: boolean;
		envId: number | null;
		fillHeight?: boolean;
		onClose: () => void;
	}

	let { containerId, containerName, visible, envId, fillHeight = false, onClose }: Props = $props();

	let attachComponent: ReturnType<typeof AttachTerminal>;
	let panelRef: HTMLDivElement;
	let connected = $state(false);

	// Font size options
	let fontSize = $state(13);
	const fontSizeOptions = [10, 12, 13, 14, 16];

	// Panel height with localStorage persistence
	const STORAGE_KEY = 'dockhand-attach-panel-height';
	const SETTINGS_STORAGE_KEY = 'dockhand-attach-settings';
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
			localStorage.setItem(
				SETTINGS_STORAGE_KEY,
				JSON.stringify({
					fontSize
				})
			);
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
		setTimeout(() => attachComponent?.fit(), 50);
	}

	// Poll connected state
	function pollConnected() {
		if (attachComponent) {
			connected = attachComponent.getConnected();
		}
	}

	onMount(() => {
		loadSettings();
		const pollInterval = setInterval(pollConnected, 500);
		return () => clearInterval(pollInterval);
	});

	onDestroy(() => {
		document.removeEventListener('mousemove', handleDrag);
		document.removeEventListener('mouseup', stopDrag);
	});
</script>

<div
	bind:this={panelRef}
	class="border-t {isDragging ? 'cursor-row-resize' : ''}"
	style={fillHeight ? 'height: 100%;' : `height: ${panelHeight}px;`}
>
	<div class="flex items-center justify-between h-9 px-3 py-1.5 border-b bg-muted/50 shrink-0">
		<div class="flex items-center gap-2 min-w-0 flex-1">
			<span class="text-xs font-medium truncate text-muted-foreground">Attach: {containerName}</span
			>
			{#if connected}
				<span class="inline-flex items-center gap-1 text-xs text-green-500 whitespace-nowrap">
					<span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
					Attached
				</span>
			{:else}
				<span class="text-xs text-zinc-500 whitespace-nowrap">Detached</span>
			{/if}
		</div>
		<div class="flex items-center gap-2 shrink-0">
			<button
				onclick={() => attachComponent?.copyOutput()}
				title="Copy output"
				class="p-1 rounded hover:bg-background transition-colors"
			>
				<Copy class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
			</button>
			<button
				onclick={() => attachComponent?.clear()}
				title="Clear"
				class="p-1 rounded hover:bg-background transition-colors"
			>
				<Trash2 class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
			</button>
			<button
				onclick={() => attachComponent?.reconnect()}
				title="Reconnect"
				class="p-1 rounded hover:bg-background transition-colors"
			>
				<RefreshCw class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
			</button>
			<button
				onclick={onClose}
				title="Close"
				class="p-1 rounded hover:bg-background transition-colors"
			>
				<X class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
			</button>
		</div>
	</div>

	{#if !fillHeight}
		<div
			class="h-1 bg-border hover:bg-primary/30 cursor-row-resize transition-colors"
			onmousedown={startDrag}
		></div>
	{/if}

	<div class="flex-1 min-h-0 overflow-hidden">
		<AttachTerminal bind:this={attachComponent} {containerId} {containerName} {envId} {fontSize} />
	</div>
</div>

<style>
	:global(.attach-terminal-container) {
		height: 100%;
	}
</style>
