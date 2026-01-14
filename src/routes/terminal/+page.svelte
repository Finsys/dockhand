<script lang="ts">
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import { NoEnvironment } from '$lib/components/ui/empty-state';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { appendEnvParam, currentEnvironment, environments } from '$lib/stores/environment';
	import type { ContainerInfo } from '$lib/types';
	import { ChevronDown, Copy, RefreshCw, Search, Shell, Terminal as TerminalIcon, Trash2, Unplug, User, Zap } from 'lucide-svelte';
	import { onDestroy, onMount } from 'svelte';
	import AttachTerminal from '../attach/AttachTerminal.svelte';
	import Terminal from './Terminal.svelte';

	// Track if we've handled the initial container from URL
	let initialContainerHandled = $state(false);

	// Mode toggle
	let mode = $state<'exec' | 'attach'>('exec');

	let containers = $state<ContainerInfo[]>([]);
	let selectedContainer = $state<ContainerInfo | null>(null);
	let envId = $state<number | null>(null);

	// Terminal component reference
	let terminalComponent: ReturnType<typeof Terminal> | undefined;
	let attachComponent: ReturnType<typeof AttachTerminal> | undefined;
	let connected = $state(false);

	// Shell/user options
	let selectedShell = $state('/bin/bash');
	let selectedUser = $state('root');
	let terminalFontSize = $state(14);

	const shellOptions = [
		{ value: '/bin/bash', label: 'Bash' },
		{ value: '/bin/sh', label: 'Shell (sh)' },
		{ value: '/bin/zsh', label: 'Zsh' },
		{ value: '/bin/ash', label: 'Ash (Alpine)' }
	];

	const userOptions = [
		{ value: 'root', label: 'root' },
		{ value: 'nobody', label: 'nobody' },
		{ value: '', label: 'Container default' }
	];

	const fontSizeOptions = [10, 12, 14, 16, 18];

	// Searchable dropdown state
	let searchQuery = $state('');
	let dropdownOpen = $state(false);

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
		return containers.filter((c) => c.name.toLowerCase().includes(query) || c.image.toLowerCase().includes(query));
	});

	async function fetchContainers() {
		try {
			const response = await fetch(appendEnvParam('/api/containers', envId));
			const allContainers = await response.json();
			// In exec mode, only show running containers
			// In attach mode, only show running containers that are attachable
			if (mode === 'attach') {
				containers = allContainers.filter((c: ContainerInfo) => c.state === 'running' && c.attachable);
			} else {
				containers = allContainers.filter((c: ContainerInfo) => c.state === 'running');
			}

			// If selected container is no longer valid, clear selection
			if (selectedContainer && !containers.find((c) => c.id === selectedContainer?.id)) {
				clearSelection();
			}
		} catch (error) {
			console.error('Failed to fetch containers:', error);
		}
	}

	function selectContainer(container: ContainerInfo) {
		// If already selected, do nothing
		if (selectedContainer && selectedContainer.id === container.id) {
			dropdownOpen = false;
			return;
		}

		// Disconnect from previous container
		if (selectedContainer) {
			if (mode === 'exec' && terminalComponent) {
				terminalComponent.dispose();
				terminalComponent = undefined;
			} else if (mode === 'attach' && attachComponent) {
				attachComponent.dispose();
			}
		}
		selectedContainer = container;
		searchQuery = '';
		dropdownOpen = false;
	}

	function clearSelection() {
		if (mode === 'exec' && terminalComponent) {
			terminalComponent.dispose();
			terminalComponent = undefined;
		} else if (mode === 'attach' && attachComponent) {
			attachComponent.dispose();
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

	// Change font size
	function changeFontSize(newSize: number) {
		terminalFontSize = newSize;
		if (mode === 'exec') {
			terminalComponent?.setFontSize(newSize);
		} else if (mode === 'attach') {
			attachComponent?.setFontSize(newSize);
		}
	}

	// Handle window resize
	function handleResize() {
		if (mode === 'exec') {
			terminalComponent?.fit();
		} else if (mode === 'attach') {
			attachComponent?.fit();
		}
	}

	onMount(async () => {
		await fetchContainers();

		// Check for container ID in URL query parameter
		const urlContainerId = $page.url.searchParams.get('container');
		if (urlContainerId && !initialContainerHandled) {
			initialContainerHandled = true;
			const container = containers.find((c) => c.id === urlContainerId || c.id.startsWith(urlContainerId));
			if (container) {
				selectContainer(container);
			}
		}

		const containerInterval = setInterval(fetchContainers, 10000);

		// Poll connected state from terminal component
		const connectedPollInterval = setInterval(() => {
			if (mode === 'exec' && terminalComponent) {
				connected = terminalComponent.getConnected();
			} else if (mode === 'attach' && attachComponent) {
				connected = attachComponent.getConnected();
			}
		}, 500);

		window.addEventListener('resize', handleResize);

		return () => {
			clearInterval(containerInterval);
			clearInterval(connectedPollInterval);
		};
	});

	onDestroy(() => {
		window.removeEventListener('resize', handleResize);
		terminalComponent?.dispose();
		attachComponent?.dispose();
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
			<div class="flex items-center gap-3">
				<PageHeader icon={TerminalIcon} title="Terminal" />
				<div class="flex items-center rounded-lg bg-muted p-1">
					<Button
						size="sm"
						variant="ghost"
						onclick={() => {
							mode = 'exec';
							clearSelection();
							fetchContainers();
						}}
						class="h-7 px-2.5 text-xs rounded gap-1.5 {mode === 'exec' ? 'text-foreground bg-accent/50' : 'text-muted-foreground hover:text-foreground'}"
					>
						<Shell class="w-3.5 h-3.5" />
						<span>Exec</span>
					</Button>
					<div class="w-px h-4 bg-border"></div>
					<Button
						size="sm"
						variant="ghost"
						onclick={() => {
							mode = 'attach';
							clearSelection();
							fetchContainers();
						}}
						class="h-7 px-2.5 text-xs rounded gap-1.5 {mode === 'attach' ? 'text-foreground bg-accent/50' : 'text-muted-foreground hover:text-foreground'}"
					>
						<Zap class="w-3.5 h-3.5" />
						<span>Attach</span>
					</Button>
				</div>
			</div>
			<div class="relative flex-1 max-w-md min-w-50">
				<!-- Search input - always visible, shows selected container or placeholder -->
				<div class="relative">
					<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
					<Input
						type="text"
						placeholder={selectedContainer ? selectedContainer.name : mode === 'exec' ? 'Search running containers...' : 'Search containers...'}
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
								{containers.length === 0 ? (mode === 'exec' ? 'No running containers' : 'No containers') : 'No matches found'}
							</div>
						{:else}
							{#each filteredContainers() as container}
								<button type="button" onclick={() => selectContainer(container)} class="w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2 {selectedContainer?.id === container.id ? 'bg-muted' : ''}">
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

			{#if !selectedContainer}
				{#if mode === 'exec'}
					<div class="flex items-center gap-2">
						<Label class="text-sm text-muted-foreground">Shell:</Label>
						<Select.Root type="single" bind:value={selectedShell}>
							<Select.Trigger class="h-9 w-36">
								<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
								<span>{shellOptions.find((o) => o.value === selectedShell)?.label || 'Select'}</span>
							</Select.Trigger>
							<Select.Content>
								{#each shellOptions as option}
									<Select.Item value={option.value} label={option.label}>
										<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
										{option.label}
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="flex items-center gap-2">
						<Label class="text-sm text-muted-foreground">User:</Label>
						<Select.Root type="single" bind:value={selectedUser}>
							<Select.Trigger class="h-9 w-40">
								<User class="w-4 h-4 mr-2 text-muted-foreground" />
								<span>{userOptions.find((o) => o.value === selectedUser)?.label || 'Select'}</span>
							</Select.Trigger>
							<Select.Content>
								{#each userOptions as option}
									<Select.Item value={option.value} label={option.label}>
										<User class="w-4 h-4 mr-2 text-muted-foreground" />
										{option.label}
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				{/if}
			{/if}
		</div>

		<!-- Shell output - full height -->
		<div class="flex-1 min-h-0 border rounded-lg bg-zinc-950 overflow-hidden flex flex-col">
			{#if !selectedContainer}
				<div class="flex items-center justify-center h-full text-muted-foreground">
					<div class="text-center">
						<TerminalIcon class="w-12 h-12 mx-auto mb-3 opacity-50" />
						<p>Select a container to {mode === 'exec' ? 'open shell' : 'attach'}</p>
					</div>
				</div>
			{:else}
				<!-- Header bar inside black area -->
				<div class="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/50 shrink-0">
					<div class="flex items-center gap-2">
						{#if connected}
							<span class="inline-flex items-center gap-1 text-xs text-green-500">
								<span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
								{mode === 'exec' ? 'Connected' : 'Attached'}
							</span>
						{:else}
							<span class="text-xs text-zinc-500">{mode === 'exec' ? 'Disconnected' : 'Detached'}</span>
						{/if}
					</div>
					<div class="flex items-center gap-3">
						<Select.Root type="single" value={String(terminalFontSize)} onValueChange={(v) => changeFontSize(Number(v))}>
							<Select.Trigger class="h-5! py-0! w-14 bg-zinc-800 border-zinc-700 text-xs text-zinc-300 px-1.5 [&_svg]:size-3">
								<span>{terminalFontSize}px</span>
							</Select.Trigger>
							<Select.Content>
								{#each fontSizeOptions as size}
									<Select.Item value={String(size)} label="{size}px" class="pe-2 [&>span:first-child]:hidden">{size}px</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						<button
							onclick={() => {
								if (mode === 'exec') terminalComponent?.copyOutput();
								else attachComponent?.copyOutput();
							}}
							class="p-1 rounded hover:bg-zinc-800 transition-colors"
							title="Copy output"
						>
							<Copy class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
						</button>
						<button
							onclick={() => {
								if (mode === 'exec') terminalComponent?.clear();
								else attachComponent?.clear();
							}}
							class="p-1 rounded hover:bg-zinc-800 transition-colors"
							title="Clear (Cmd+L)"
						>
							<Trash2 class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
						</button>
						<button
							onclick={() => {
								if (mode === 'exec') terminalComponent?.reconnect();
								else attachComponent?.reconnect();
							}}
							class="p-1 rounded hover:bg-zinc-800 transition-colors"
							title="Reconnect"
						>
							<RefreshCw class="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
						</button>
					</div>
				</div>
				<div class="flex-1 min-h-0 w-full">
					{#key `${selectedContainer.id}-${mode}`}
						{#if mode === 'exec'}
							<Terminal bind:this={terminalComponent} containerId={selectedContainer.id} containerName={selectedContainer.name} shell={selectedShell} user={selectedUser} {envId} fontSize={terminalFontSize} />
						{:else if mode === 'attach'}
							<AttachTerminal bind:this={attachComponent} containerId={selectedContainer.id} containerName={selectedContainer.name} {envId} fontSize={terminalFontSize} />
						{/if}
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
