<svelte:head>
	<title>Terminal - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Search, ChevronDown, Terminal as TerminalIcon, Unplug, RefreshCw, Trash2, Copy, Shell, User, Loader2, AlertCircle } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import type { ContainerInfo } from '$lib/types';
	import { currentEnvironment, environments, appendEnvParam } from '$lib/stores/environment';
	import Terminal from './Terminal.svelte';
	import { NoEnvironment } from '$lib/components/ui/empty-state';
	import { detectShells, getBestShell, hasAvailableShell, USER_OPTIONS, type ShellInfo, type ShellDetectionResult } from '$lib/utils/shell-detection';

	// Track if we've handled the initial container from URL
	let initialContainerHandled = $state(false);

	let containers = $state<ContainerInfo[]>([]);
	let selectedContainer = $state<ContainerInfo | null>(null);
	let envId = $state<number | null>(null);

	// Terminal component reference
	let terminalComponent: ReturnType<typeof Terminal> | undefined;
	let connected = $state(false);

	// Shell detection state
	let shellDetection = $state<ShellDetectionResult | null>(null);
	let detectingShells = $state(false);

	// Shell/user options
	let selectedShell = $state('/bin/bash');
	let selectedUser = $state('root');
	let terminalFontSize = $state(14);

	// Track previous shell/user for reconnection
	let prevShell = $state('/bin/bash');
	let prevUser = $state('root');

	const fontSizeOptions = [10, 12, 14, 16, 18];

	// Searchable dropdown state
	let searchQuery = $state('');
	let dropdownOpen = $state(false);

	// Derived: check if selected shell is available
	const selectedShellAvailable = $derived(
		!shellDetection || shellDetection.shells.includes(selectedShell)
	);

	// Derived: check if any shell is available
	const anyShellAvailable = $derived(
		!shellDetection || hasAvailableShell(shellDetection)
	);

	// Polling intervals - module scope for cleanup in onDestroy
	let containerInterval: ReturnType<typeof setInterval> | null = null;
	let connectedPollInterval: ReturnType<typeof setInterval> | null = null;

	// Subscribe to environment changes
	currentEnvironment.subscribe((env) => {
		envId = env?.id ?? null;
		if (env) {
			fetchContainers();
		}
	});

	// Filtered containers based on search
	let filteredContainers = $derived(() => {
		if (!searchQuery.trim()) return containers;
		const query = searchQuery.toLowerCase();
		return containers.filter(c =>
			c.name.toLowerCase().includes(query) ||
			c.image.toLowerCase().includes(query)
		);
	});

	async function fetchContainers() {
		try {
			const response = await fetch(appendEnvParam('/api/containers', envId));
			const allContainers = await response.json();
			// Only show running containers
			containers = allContainers.filter((c: ContainerInfo) => c.state === 'running');

			// If selected container is no longer running, clear selection
			if (selectedContainer && !containers.find((c) => c.id === selectedContainer?.id)) {
				clearSelection();
			}
		} catch (error) {
			console.error('Failed to fetch containers:', error);
		}
	}

	async function selectContainer(container: ContainerInfo) {
		// Disconnect from previous container
		if (selectedContainer && terminalComponent) {
			terminalComponent.dispose();
		}
		selectedContainer = container;
		searchQuery = '';
		dropdownOpen = false;

		// Detect available shells
		detectingShells = true;
		shellDetection = null;
		try {
			shellDetection = await detectShells(container.id, envId);

			// Auto-select best available shell if current is not available
			const bestShell = getBestShell(shellDetection, selectedShell);
			if (bestShell && bestShell !== selectedShell) {
				selectedShell = bestShell;
			}
		} catch (error) {
			console.error('Failed to detect shells:', error);
		} finally {
			detectingShells = false;
		}
	}

	function clearSelection() {
		if (terminalComponent) {
			terminalComponent.dispose();
		}
		selectedContainer = null;
		searchQuery = '';
		connected = false;
		shellDetection = null;
	}

	function handleInputFocus() {
		dropdownOpen = true;
	}

	function handleInputBlur(e: FocusEvent) {
		setTimeout(() => {
			dropdownOpen = false;
		}, 200);
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			const filtered = filteredContainers();
			if (filtered.length > 0) {
				selectContainer(filtered[0]);
			}
		}
	}

	// Watch for shell/user changes while connected and trigger reconnect
	$effect(() => {
		if (selectedContainer && connected && terminalComponent) {
			if (selectedShell !== prevShell || selectedUser !== prevUser) {
				// Reconnect with new shell/user
				terminalComponent.reconnect();
			}
		}
		prevShell = selectedShell;
		prevUser = selectedUser;
	});

	// Change font size
	function changeFontSize(newSize: number) {
		terminalFontSize = newSize;
		terminalComponent?.setFontSize(newSize);
	}

	// Handle window resize
	function handleResize() {
		terminalComponent?.fit();
	}

	onMount(async () => {
		await fetchContainers();

		// Check for container ID in URL query parameter
		const urlContainerId = $page.url.searchParams.get('container');
		if (urlContainerId && !initialContainerHandled) {
			initialContainerHandled = true;
			const container = containers.find(c => c.id === urlContainerId || c.id.startsWith(urlContainerId));
			if (container) {
				selectContainer(container);
			}
		}

		containerInterval = setInterval(fetchContainers, 10000);

		// Poll connected state from terminal component
		connectedPollInterval = setInterval(() => {
			if (terminalComponent) {
				connected = terminalComponent.getConnected();
			}
		}, 500);

		window.addEventListener('resize', handleResize);
		// Note: In Svelte 5, cleanup must be in onDestroy, not returned from onMount
	});

	onDestroy(() => {
		if (containerInterval) {
			clearInterval(containerInterval);
			containerInterval = null;
		}
		if (connectedPollInterval) {
			clearInterval(connectedPollInterval);
			connectedPollInterval = null;
		}
		window.removeEventListener('resize', handleResize);
		terminalComponent?.dispose();
	});
</script>

{#if $environments.length === 0 || !$currentEnvironment}
	<div class="flex flex-col flex-1 min-h-0 h-full">
		<PageHeader icon={TerminalIcon} title="Shell" class="h-9 mb-3" />
		<NoEnvironment />
	</div>
{:else}
<div class="flex flex-col flex-1 min-h-0 h-full gap-3">
	<!-- Header with container selector -->
	<div class="flex items-center gap-4 flex-wrap">
		<PageHeader icon={TerminalIcon} title="Shell" />
		<div class="relative flex-1 max-w-md min-w-[200px]">
			<!-- Search input - always visible, shows selected container or placeholder -->
			<div class="relative">
				<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
				<Input
					type="text"
					placeholder={selectedContainer ? selectedContainer.name : "Search running containers..."}
					bind:value={searchQuery}
					onfocus={handleInputFocus}
					onblur={handleInputBlur}
					onkeydown={handleInputKeydown}
					class="pl-10 pr-10 h-9 {selectedContainer && !searchQuery ? 'text-foreground' : ''}"
				/>
				<ChevronDown class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
			</div>

			<!-- Dropdown -->
			{#if dropdownOpen}
				<div class="absolute top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg z-50 max-h-64 overflow-auto">
					{#if filteredContainers().length === 0}
						<div class="px-3 py-2 text-sm text-muted-foreground">
							{containers.length === 0 ? 'No running containers' : 'No matches found'}
						</div>
					{:else}
						{#each filteredContainers() as container}
							<button
								type="button"
								onclick={() => selectContainer(container)}
								class="w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2 {selectedContainer?.id === container.id ? 'bg-muted' : ''}"
							>
								<span class="font-medium truncate">{container.name}</span>
								<span class="text-muted-foreground text-xs truncate">({container.image})</span>
								{#if selectedContainer?.id === container.id}
									<span class="ml-auto text-xs text-primary">connected</span>
								{/if}
							</button>
						{/each}
					{/if}
				</div>
			{/if}
		</div>

		{#if selectedContainer}
			<Button size="sm" variant="ghost" onclick={clearSelection} class="h-9 px-3 text-sm text-muted-foreground hover:text-foreground">
				<Unplug class="w-4 h-4 mr-1.5" />
				Disconnect
			</Button>
		{/if}

		<!-- Shell selector - always visible -->
		<div class="flex items-center gap-2">
			<Label class="text-sm text-muted-foreground">Shell:</Label>
			{#if detectingShells}
				<div class="h-9 w-36 flex items-center justify-center border rounded-md bg-muted/50">
					<Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
				</div>
			{:else}
				<Select.Root type="single" bind:value={selectedShell}>
					<Select.Trigger class="h-9 w-44" disabled={!anyShellAvailable}>
						<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
						<span class={!selectedShellAvailable ? 'text-muted-foreground line-through' : ''}>
							{shellDetection?.allShells.find(o => o.path === selectedShell)?.label ||
							 (selectedShell === '/bin/bash' ? 'Bash' :
							  selectedShell === '/bin/sh' ? 'Shell (sh)' :
							  selectedShell === '/bin/zsh' ? 'Zsh' :
							  selectedShell === '/bin/ash' ? 'Ash (Alpine)' : 'Select')}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#if shellDetection}
							{#each shellDetection.allShells as option}
								<Select.Item
									value={option.path}
									label={option.label}
									disabled={!option.available}
								>
									<Shell class="w-4 h-4 mr-2 {option.available ? 'text-green-500' : 'text-muted-foreground/40'}" />
									<span class={option.available ? 'text-foreground' : 'text-muted-foreground/60'}>
										{option.label}
										{#if !option.available}
											<span class="text-xs ml-1">(unavailable)</span>
										{/if}
									</span>
								</Select.Item>
							{/each}
						{:else}
							<Select.Item value="/bin/bash" label="Bash">
								<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
								Bash
							</Select.Item>
							<Select.Item value="/bin/sh" label="Shell (sh)">
								<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
								Shell (sh)
							</Select.Item>
							<Select.Item value="/bin/zsh" label="Zsh">
								<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
								Zsh
							</Select.Item>
							<Select.Item value="/bin/ash" label="Ash (Alpine)">
								<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
								Ash (Alpine)
							</Select.Item>
						{/if}
					</Select.Content>
				</Select.Root>
			{/if}
		</div>

		<!-- User selector - always visible -->
		<div class="flex items-center gap-2">
			<Label class="text-sm text-muted-foreground">User:</Label>
			<Select.Root type="single" bind:value={selectedUser}>
				<Select.Trigger class="h-9 w-48">
					<User class="w-4 h-4 mr-2 text-muted-foreground" />
					<span>{USER_OPTIONS.find(o => o.value === selectedUser)?.label || 'Select'}</span>
				</Select.Trigger>
				<Select.Content>
					{#each USER_OPTIONS as option}
						<Select.Item value={option.value} label={option.label}>
							<User class="w-4 h-4 mr-2 text-muted-foreground" />
							{option.label}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
	</div>

	<!-- Shell output - full height -->
	<div class="flex-1 min-h-0 border rounded-lg bg-zinc-950 overflow-hidden flex flex-col">
		{#if !selectedContainer}
			<div class="flex items-center justify-center h-full text-muted-foreground">
				<div class="text-center">
					<TerminalIcon class="w-12 h-12 mx-auto mb-3 opacity-50" />
					<p>Select a container to open shell</p>
				</div>
			</div>
		{:else if detectingShells}
			<div class="flex items-center justify-center h-full text-muted-foreground">
				<div class="text-center">
					<Loader2 class="w-12 h-12 mx-auto mb-3 opacity-50 animate-spin" />
					<p>Detecting available shells...</p>
				</div>
			</div>
		{:else if !anyShellAvailable}
			<div class="flex items-center justify-center h-full text-muted-foreground">
				<div class="text-center">
					<AlertCircle class="w-12 h-12 mx-auto mb-3 opacity-50 text-amber-500" />
					<p class="font-medium text-amber-500">No shell available in this container</p>
					<p class="text-sm mt-2">This container may not have a shell installed.</p>
					<p class="text-xs mt-1 text-muted-foreground/70">
						Containers built from scratch or distroless images often don't include shells.
					</p>
				</div>
			</div>
		{:else}
			<!-- Header bar inside black area -->
			<div class="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
				<div class="flex items-center gap-2">
					{#if connected}
						<span class="inline-flex items-center gap-1 text-xs text-green-500">
							<span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
							Connected
						</span>
					{:else}
						<span class="text-xs text-zinc-500">Disconnected</span>
					{/if}
				</div>
				<div class="flex items-center gap-3">
					<Select.Root type="single" value={String(terminalFontSize)} onValueChange={(v) => changeFontSize(Number(v))}>
						<Select.Trigger class="!h-5 !py-0 w-14 bg-zinc-800 border-zinc-700 text-xs text-zinc-300 px-1.5 [&_svg]:size-3">
							<span>{terminalFontSize}px</span>
						</Select.Trigger>
						<Select.Content>
							{#each fontSizeOptions as size}
								<Select.Item value={String(size)} label="{size}px" class="pe-2 [&>span:first-child]:hidden">{size}px</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<button
						onclick={() => terminalComponent?.copyOutput()}
						class="p-1 rounded hover:bg-zinc-800 transition-colors"
						title="Copy output"
					>
						<Copy class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
					</button>
					<button
						onclick={() => terminalComponent?.clear()}
						class="p-1 rounded hover:bg-zinc-800 transition-colors"
						title="Clear (Cmd+L)"
					>
						<Trash2 class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
					</button>
					<button
						onclick={() => terminalComponent?.reconnect()}
						class="p-1 rounded hover:bg-zinc-800 transition-colors"
						title="Reconnect"
					>
						<RefreshCw class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
					</button>
				</div>
			</div>
			<div class="flex-1 min-h-0 w-full">
				{#key `${selectedContainer.id}-${selectedShell}-${selectedUser}`}
					<Terminal
						bind:this={terminalComponent}
						containerId={selectedContainer.id}
						containerName={selectedContainer.name}
						shell={selectedShell}
						user={selectedUser}
						{envId}
						fontSize={terminalFontSize}
					/>
				{/key}
			</div>
		{/if}
	</div>
</div>
{/if}

<style>
	:global(.xterm) {
		height: 100%;
		padding: 8px;
	}

	:global(.xterm-viewport) {
		overflow-y: auto !important;
	}
</style>
