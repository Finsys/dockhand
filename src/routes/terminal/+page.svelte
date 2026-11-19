<svelte:head>
	<title>{m.terminal_page_title()} - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Search, ChevronDown, Terminal as TerminalIcon, Unplug, RefreshCw, Trash2, Copy, Shell, Loader2, AlertCircle } from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import ContainerIcon from '$lib/components/ContainerIcon.svelte';
	import type { ContainerInfo, TerminalMode } from '$lib/types';
	import { currentEnvironment, environments, appendEnvParam } from '$lib/stores/environment';
	import Terminal from './Terminal.svelte';
	import { NoEnvironment } from '$lib/components/ui/empty-state';
	import ShellUserPicker from './ShellUserPicker.svelte';
	import { m } from '$lib/paraglide/messages.js';

	// Track if we've handled the initial container from URL
	let initialContainerHandled = $state(false);

	let containers = $state<ContainerInfo[]>([]);
	let selectedContainer = $state<ContainerInfo | null>(null);
	let envId = $state<number | null>(null);

	// Terminal component reference
	let terminalComponent: ReturnType<typeof Terminal> | undefined;
	let connected = $state(false);

	// Detection state is owned by ShellUserPicker and surfaced here for the output-area
	// empty states (detecting / no shell available).
	let terminalDetecting = $state(false);
	let terminalAnyShell = $state(true);

	let terminalMode = $state<TerminalMode>('exec');
	let selectedShell = $state('/bin/bash');
	let terminalFontSize = $state(14);

	const fontSizeOptions = [10, 12, 14, 16, 18];

	// Searchable dropdown state
	let searchQuery = $state('');
	let dropdownOpen = $state(false);

	// Polling intervals - module scope for cleanup in onDestroy
	let containerInterval: ReturnType<typeof setInterval> | null = null;
	let connectedPollInterval: ReturnType<typeof setInterval> | null = null;

	// Subscribe to environment changes
	const unsubscribeEnv = currentEnvironment.subscribe((env) => {
		envId = env?.id ?? null;
		if (env) {
			fetchContainers();
		}
	});

	// React to the ?container= URL param CHANGING while already mounted (e.g. a
	// cross-host jump from the command palette). onMount only matches the URL once,
	// so a later navigation to a container - possibly on another host, hence keyed on
	// `containers` too - is handled here once its list has loaded.
	let lastHandledUrlContainer: string | null = null;
	$effect(() => {
		const urlContainerId = $page.url.searchParams.get('container');
		const list = containers;
		if (!urlContainerId || urlContainerId === lastHandledUrlContainer) return;
		const container = list.find(c => c.id === urlContainerId || c.id.startsWith(urlContainerId));
		if (!container) return;
		lastHandledUrlContainer = urlContainerId;
		if (selectedContainer?.id === container.id) return;
		selectContainer(container);
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
		// Shell detection and saved-user restore happen in ShellUserPicker, keyed on
		// the new container id.
	}

	function clearSelection() {
		if (terminalComponent) {
			terminalComponent.dispose();
		}
		selectedContainer = null;
		searchQuery = '';
		connected = false;
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

	// Committed user, driven by ShellUserPicker (which persists it per container).
	let committedUser = $state('root');

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
		if ($page.url.searchParams.get('mode') === 'attach') {
			terminalMode = 'attach';
		}
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
		unsubscribeEnv();
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
		<PageHeader icon={TerminalIcon} title={m.nav_shell()} class="h-9 mb-3" />
		<NoEnvironment />
	</div>
{:else}
<div class="flex flex-col flex-1 min-h-0 h-full gap-3">
	<!-- Header with container selector -->
	<div class="flex items-center gap-4 flex-wrap">
		<PageHeader icon={TerminalIcon} title={m.nav_shell()} />
		<div class="relative flex-1 max-w-md min-w-[200px]">
			<!-- Search input - always visible, shows selected container or placeholder -->
			<div class="relative">
				<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
				<Input
					type="text"
					placeholder={selectedContainer ? selectedContainer.name : m.terminal_search_placeholder()}
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
							{containers.length === 0 ? m.terminal_no_running_containers() : m.terminal_no_matches()}
						</div>
					{:else}
						{#each filteredContainers() as container}
							<button
								type="button"
								onclick={() => selectContainer(container)}
								class="w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2 {selectedContainer?.id === container.id ? 'bg-muted' : ''}"
							>
								<ContainerIcon image={container.image} name={container.name} class="w-3.5 h-3.5" fallbackClass="text-green-500" showFallbackWhenOff />
								<span class="font-medium truncate">{container.name}</span>
								<span class="text-muted-foreground text-xs truncate">({container.image})</span>
								{#if selectedContainer?.id === container.id}
									<span class="ml-auto text-xs text-primary">{m.terminal_container_connected()}</span>
								{/if}
							</button>
						{/each}
					{/if}
				</div>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<Label class="text-sm text-muted-foreground">{m.terminal_mode_label()}</Label>
			<Select.Root type="single" value={terminalMode} onValueChange={(value) => terminalMode = value as TerminalMode}>
				<Select.Trigger class="h-9 w-48">
					{#if terminalMode === 'attach'}
						<Unplug class="w-4 h-4 mr-2 text-muted-foreground" />
						<span>{m.containers_list_terminal_attach()}</span>
					{:else}
						<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
						<span>{m.containers_list_terminal_exec()}</span>
					{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="exec" label={m.containers_list_terminal_exec()}>
						<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
						{m.containers_list_terminal_exec()}
					</Select.Item>
					<Select.Item value="attach" label={m.containers_list_terminal_attach()}>
						<Unplug class="w-4 h-4 mr-2 text-muted-foreground" />
						{m.containers_list_terminal_attach()}
					</Select.Item>
				</Select.Content>
			</Select.Root>
		</div>

		{#if selectedContainer}
			<Button size="sm" variant="ghost" onclick={clearSelection} class="h-9 px-3 text-sm text-muted-foreground hover:text-foreground">
				<Unplug class="w-4 h-4 mr-1.5" />
				{m.terminal_disconnect()}
			</Button>
		{/if}

		<!-- Shell + user selectors (exec mode), shared with the inspect-modal terminal. -->
		{#if terminalMode === 'exec' && selectedContainer}
			<ShellUserPicker
				containerId={selectedContainer.id}
				{envId}
				bind:shell={selectedShell}
				bind:user={committedUser}
				mode={terminalMode}
				bind:detecting={terminalDetecting}
				bind:anyShellAvailable={terminalAnyShell}
				onChange={() => { if (connected && terminalComponent) terminalComponent.reconnect(); }}
			/>
		{/if}
	</div>

	<!-- Shell output - full height -->
	<div class="flex-1 min-h-0 border rounded-lg bg-zinc-950 overflow-hidden flex flex-col">
		{#if !selectedContainer}
			<div class="flex items-center justify-center h-full text-muted-foreground">
				<div class="text-center">
					<TerminalIcon class="w-12 h-12 mx-auto mb-3 opacity-50" />
					<p>{m.terminal_select_container()}</p>
				</div>
			</div>
		{:else if terminalMode === 'exec' && terminalDetecting}
			<div class="flex items-center justify-center h-full text-muted-foreground">
				<div class="text-center">
					<Loader2 class="w-12 h-12 mx-auto mb-3 opacity-50 animate-spin" />
					<p>{m.containers_terminal_detecting_shells()}</p>
				</div>
			</div>
		{:else if terminalMode === 'exec' && !terminalAnyShell}
			<div class="flex items-center justify-center h-full text-muted-foreground">
				<div class="text-center">
					<AlertCircle class="w-12 h-12 mx-auto mb-3 opacity-50 text-amber-500" />
					<p class="font-medium text-amber-500">{m.terminal_no_shell_in_container()}</p>
					<p class="text-sm mt-2">{m.terminal_no_shell_installed()}</p>
					<p class="text-xs mt-1 text-muted-foreground/70">
						{m.containers_terminal_no_shell_hint()}
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
							{m.containers_terminal_connected()}
						</span>
					{:else}
						<span class="text-xs text-zinc-500">{m.terminal_status_disconnected()}</span>
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
						title={m.terminal_copy_output()}
					>
						<Copy class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
					</button>
					<button
						onclick={() => terminalComponent?.clear()}
						class="p-1 rounded hover:bg-zinc-800 transition-colors"
						title={m.terminal_clear_shortcut()}
					>
						<Trash2 class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
					</button>
					<button
						onclick={() => terminalComponent?.reconnect()}
						class="p-1 rounded hover:bg-zinc-800 transition-colors"
						title={m.terminal_reconnect()}
					>
						<RefreshCw class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
					</button>
				</div>
			</div>
			<div class="flex-1 min-h-0 w-full">
				{#key `${selectedContainer.id}-${terminalMode}-${terminalMode === 'exec' ? selectedShell : ''}-${terminalMode === 'exec' ? committedUser : ''}`}
					<Terminal
						bind:this={terminalComponent}
						containerId={selectedContainer.id}
						containerName={selectedContainer.name}
						shell={selectedShell}
						user={committedUser}
						mode={terminalMode}
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
