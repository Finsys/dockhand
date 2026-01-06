<script lang="ts">
	import { page } from '$app/stores';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { Button } from '$lib/components/ui/button';
	import { NoEnvironment } from '$lib/components/ui/empty-state';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { appendEnvParam, currentEnvironment, environments } from '$lib/stores/environment';
	import type { ContainerInfo } from '$lib/types';
	import {
		AlertCircle,
		ChevronDown,
		Copy,
		RefreshCw,
		Search,
		Terminal as TerminalIcon,
		Trash2,
		Unplug
	} from 'lucide-svelte';
	import { onDestroy, onMount } from 'svelte';
	import AttachTerminal from './AttachTerminal.svelte';

	// Track if we've handled the initial container from URL
	let initialContainerHandled = $state(false);

	let containers = $state<ContainerInfo[]>([]);
	let selectedContainer = $state<ContainerInfo | null>(null);
	let envId = $state<number | null>(null);

	// Terminal component reference
	let terminalComponent: ReturnType<typeof AttachTerminal> | undefined;
	let connected = $state(false);

	// Terminal font size
	let terminalFontSize = $state(14);

	const fontSizeOptions = [10, 12, 14, 16, 18];

	// Searchable dropdown state
	let searchQuery = $state('');
	let dropdownOpen = $state(false);

	// Validation state
	let validationError = $state<string | null>(null);

	// Subscribe to environment changes
	currentEnvironment.subscribe((env) => {
		envId = env?.id ?? null;
		if (env) {
			fetchContainers();
		}
	});

	// Filtered containers based on search and validity for attach
	let filteredContainers = $derived(() => {
		if (!searchQuery.trim()) return containers;
		const query = searchQuery.toLowerCase();
		return containers.filter(
			(c) => c.name.toLowerCase().includes(query) || c.image.toLowerCase().includes(query)
		);
	});

	// Check if a container can be attached to
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

	async function fetchContainers() {
		try {
			const response = await fetch(appendEnvParam('/api/containers', envId));
			const allContainers = await response.json();
			// Show all containers, but highlight which can be attached to
			containers = allContainers;

			// If selected container can no longer be attached to, clear selection
			if (selectedContainer && !canAttachToContainer(selectedContainer)) {
				clearSelection();
				validationError = getAttachValidationError(selectedContainer);
			}
		} catch (error) {
			console.error('Failed to fetch containers:', error);
		}
	}

	function selectContainer(container: ContainerInfo) {
		// Validate container can be attached to
		if (!canAttachToContainer(container)) {
			validationError = getAttachValidationError(container);
			return;
		}

		validationError = null;

		// Disconnect from previous container
		if (selectedContainer && terminalComponent) {
			terminalComponent.dispose();
		}
		selectedContainer = container;
		searchQuery = '';
		dropdownOpen = false;
	}

	function clearSelection() {
		if (terminalComponent) {
			terminalComponent.dispose();
		}
		selectedContainer = null;
		searchQuery = '';
		connected = false;
		validationError = null;
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
			const container = containers.find(
				(c) => c.id === urlContainerId || c.id.startsWith(urlContainerId)
			);
			if (container) {
				selectContainer(container);
			}
		}

		const containerInterval = setInterval(fetchContainers, 10000);

		// Poll connected state from terminal component
		const connectedPollInterval = setInterval(() => {
			if (terminalComponent) {
				connected = terminalComponent.getConnected();
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
	});
</script>

{#if $environments.length === 0 || !$currentEnvironment}
	<div class="flex flex-col flex-1 min-h-0 h-full">
		<PageHeader icon={TerminalIcon} title="Attach" class="h-9 mb-3" />
		<NoEnvironment />
	</div>
{:else}
	<div class="flex flex-col flex-1 min-h-0 h-full gap-3">
		<!-- Header with container selector -->
		<div class="flex items-center gap-4 flex-wrap">
			<PageHeader icon={TerminalIcon} title="Attach" />
			<div class="relative flex-1 max-w-md min-w-[200px]">
				<!-- Search input - always visible, shows selected container or placeholder -->
				<div class="relative">
					<Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
					<Input
						type="text"
						placeholder={selectedContainer
							? selectedContainer.name
							: 'Search running containers...'}
						bind:value={searchQuery}
						onfocus={handleInputFocus}
						onblur={handleInputBlur}
						onkeydown={handleInputKeydown}
						class="pl-10 pr-10 h-9 {selectedContainer && !searchQuery ? 'text-foreground' : ''}"
					/>
					<ChevronDown
						class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
					/>
				</div>

				<!-- Dropdown -->
				{#if dropdownOpen}
					<div
						class="absolute top-full left-0 right-0 mt-1 border rounded-md bg-popover shadow-lg z-50 max-h-64 overflow-auto"
					>
						{#if filteredContainers().length === 0}
							<div class="px-3 py-2 text-sm text-muted-foreground">
								{containers.length === 0 ? 'No containers' : 'No matches found'}
							</div>
						{:else}
							{#each filteredContainers() as container}
								{@const isAttachable = canAttachToContainer(container)}
								{@const errorMsg = getAttachValidationError(container)}
								<button
									type="button"
									onclick={() => selectContainer(container)}
									disabled={!isAttachable}
									class="w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed {selectedContainer?.id ===
									container.id
										? 'bg-muted'
										: ''}"
									title={errorMsg || ''}
								>
									<div class="flex-1 min-w-0">
										<span class="font-medium truncate block">{container.name}</span>
										<span class="text-muted-foreground text-xs truncate block"
											>{container.image}</span
										>
										{#if errorMsg}
											<span class="text-xs text-red-500 truncate block">{errorMsg}</span>
										{/if}
									</div>
									{#if selectedContainer?.id === container.id && isAttachable}
										<span class="ml-auto text-xs text-primary">connected</span>
									{/if}
								</button>
							{/each}
						{/if}
					</div>
				{/if}
			</div>

			{#if selectedContainer}
				<Button
					size="sm"
					variant="ghost"
					onclick={clearSelection}
					class="h-9 px-3 text-sm text-muted-foreground hover:text-foreground"
				>
					<Unplug class="w-4 h-4 mr-1.5" />
					Disconnect
				</Button>
			{/if}
		</div>

		<!-- Validation error message -->
		{#if validationError}
			<div
				class="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500 text-sm"
			>
				<AlertCircle class="w-4 h-4 flex-shrink-0" />
				<span>{validationError}</span>
			</div>
		{/if}

		<!-- Attach output - full height -->
		<div class="flex-1 min-h-0 border rounded-lg bg-zinc-950 overflow-hidden flex flex-col">
			{#if !selectedContainer}
				<div class="flex items-center justify-center h-full text-muted-foreground">
					<div class="text-center">
						<TerminalIcon class="w-12 h-12 mx-auto mb-3 opacity-50" />
						<p>Select a container to attach</p>
					</div>
				</div>
			{:else}
				<!-- Header bar inside black area -->
				<div
					class="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/50 shrink-0"
				>
					<div class="flex items-center gap-2">
						{#if connected}
							<span class="inline-flex items-center gap-1 text-xs text-green-500">
								<span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
								Attached
							</span>
						{:else}
							<span class="text-xs text-zinc-500">Detached</span>
						{/if}
					</div>
					<div class="flex items-center gap-3">
						<Select.Root
							type="single"
							value={String(terminalFontSize)}
							onValueChange={(v) => changeFontSize(Number(v))}
						>
							<Select.Trigger
								class="!h-5 !py-0 w-14 bg-zinc-800 border-zinc-700 text-xs text-zinc-300 px-1.5 [&_svg]:size-3"
							>
								<span>{terminalFontSize}px</span>
							</Select.Trigger>
							<Select.Content>
								{#each fontSizeOptions as size}
									<Select.Item
										value={String(size)}
										label="{size}px"
										class="pe-2 [&>span:first-child]:hidden">{size}px</Select.Item
									>
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
					{#key selectedContainer.id}
						<AttachTerminal
							bind:this={terminalComponent}
							containerId={selectedContainer.id}
							containerName={selectedContainer.name}
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
