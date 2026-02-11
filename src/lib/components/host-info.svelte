<script lang="ts">
	import { onMount } from 'svelte';
	import { Cpu, MemoryStick, Box, Globe, ChevronDown, Check, HardDrive, Clock, Wifi, WifiOff, Route, UndoDot, Icon, AlertCircle, Loader2 } from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import { Button } from '$lib/components/ui/button';
	import { currentEnvironment, environments, type Environment } from '$lib/stores/environment';
	import { sseConnected } from '$lib/stores/events';
	import { getIconComponent } from '$lib/utils/icons';
	import { toast } from 'svelte-sonner';
	import { themeStore, type FontSize } from '$lib/stores/theme';
	import { formatTime } from '$lib/stores/settings';

	// Font size scaling for header
	let fontSize = $state<FontSize>('normal');
	themeStore.subscribe(prefs => fontSize = prefs.fontSize);

	// Derive text and icon size classes based on font size
	const textSizeClass = $derived(() => {
		switch (fontSize) {
			case 'small': return 'text-xs';
			case 'normal': return 'text-xs';
			case 'medium': return 'text-sm';
			case 'large': return 'text-sm';
			case 'xlarge': return 'text-base';
			default: return 'text-xs';
		}
	});

	const iconSizeClass = $derived(() => {
		switch (fontSize) {
			case 'small': return 'h-3 w-3';
			case 'normal': return 'h-3 w-3';
			case 'medium': return 'h-3.5 w-3.5';
			case 'large': return 'h-4 w-4';
			case 'xlarge': return 'h-4 w-4';
			default: return 'h-3 w-3';
		}
	});

	const iconSizeLargeClass = $derived(() => {
		switch (fontSize) {
			case 'small': return 'h-3.5 w-3.5';
			case 'normal': return 'h-3.5 w-3.5';
			case 'medium': return 'h-4 w-4';
			case 'large': return 'h-5 w-5';
			case 'xlarge': return 'h-5 w-5';
			default: return 'h-3.5 w-3.5';
		}
	});

	interface HostInfo {
		hostname: string;
		ipAddress: string;
		platform: string;
		arch: string;
		cpus: number;
		totalMemory: number;
		freeMemory: number;
		uptime: number;
		dockerVersion: string;
		dockerContainers: number;
		dockerContainersRunning: number;
		dockerImages: number;
		environment: Environment & { icon?: string; connectionType?: string; hawserVersion?: string };
	}

	interface DiskUsageInfo {
		LayersSize: number;
		Images: any[];
		Containers: any[];
		Volumes: any[];
		BuildCache: any[];
	}

	let hostInfo = $state<HostInfo | null>(null);
	let diskUsage = $state<DiskUsageInfo | null>(null);
	let diskUsageLoading = $state(false);
	let envAbortController: AbortController | null = null; // Aborts ALL requests when switching envs
	let showDropdown = $state(false);
	let currentEnvId = $state<number | null>(null);
	let lastUpdated = $state<Date>(new Date());
	let isConnected = $state(false);
	let initializedFromStore = false;
	let switchingEnvId = $state<number | null>(null); // Track which env is being switched to
	let offlineEnvIds = $state<Set<number>>(new Set()); // Track offline environments

	// Abort all pending requests for current environment
	function abortPendingRequests() {
		if (envAbortController) {
			envAbortController.abort();
			envAbortController = null;
		}
	}

	// Reactive environment list from store
	let envList = $derived($environments);

	sseConnected.subscribe(v => isConnected = v);

	// Subscribe to the store and react to changes (including from command palette)
	currentEnvironment.subscribe(env => {
		if (env) {
			// Only update if different to avoid loops and unnecessary fetches
			// Use Number() for type-safe comparison
			if (Number(env.id) !== Number(currentEnvId)) {
				currentEnvId = env.id;
				// Fetch new host info for the changed environment
				if (initializedFromStore) {
					fetchHostInfo();
					fetchDiskUsage();
				}
			}
			initializedFromStore = true;
		} else if (!env && envList.length > 0 && currentEnvId === null) {
			// Set current env to first if not restored from store
			currentEnvId = envList[0].id;
		}
	});

	// Watch for when current environment is deleted, all environments removed, or no env selected
	// IMPORTANT: Don't clear state when envList is empty during initial load - wait for environments to load first
	$effect(() => {
		// Skip if environments haven't loaded yet - the store subscription will handle initial setup
		if (envList.length === 0) return;

		if (currentEnvId === null) {
			// No environment selected - select first one
			currentEnvId = envList[0].id;
			fetchHostInfo();
			fetchDiskUsage();
		} else {
			// Use Number() for type-safe comparison in case of string/number mismatch
			const stillExists = envList.find((e: Environment) => Number(e.id) === Number(currentEnvId));
			if (!stillExists) {
				// Current environment was deleted - select first one
				currentEnvId = envList[0].id;
				fetchHostInfo();
				fetchDiskUsage();
			}
		}
	});

	async function fetchHostInfo() {
		// Skip if no environment selected or no abort controller
		if (!currentEnvId || !envAbortController) return;

		try {
			const url = `/api/host?env=${currentEnvId}`;
			const response = await fetch(url, { signal: envAbortController.signal });
			if (response.ok) {
				hostInfo = await response.json();
				lastUpdated = new Date();
				if (hostInfo?.environment) {
					currentEnvId = hostInfo.environment.id;
					// Update the store
					currentEnvironment.set({
						id: hostInfo.environment.id,
						name: hostInfo.environment.name,
						highlightChanges: hostInfo.environment.highlightChanges ?? true
					});
				}
			}
		} catch (error) {
			// Ignore abort errors
			if (error instanceof Error && error.name !== 'AbortError') {
				console.error('Failed to fetch host info:', error);
			}
		}
	}

	async function fetchDiskUsage() {
		// Skip if no environment selected or no abort controller
		if (!currentEnvId || !envAbortController) return;

		diskUsage = null;
		diskUsageLoading = true;

		try {
			const url = `/api/system/disk?env=${currentEnvId}`;
			const response = await fetch(url, { signal: envAbortController.signal });
			if (response.ok) {
				const data = await response.json();
				diskUsage = data.diskUsage;
			}
		} catch (error) {
			// Ignore abort errors
			if (error instanceof Error && error.name !== 'AbortError') {
				console.error('Failed to fetch disk usage:', error);
			}
			diskUsage = null;
		} finally {
			diskUsageLoading = false;
		}
	}

	// Calculate total disk usage
	let totalDiskUsage = $derived(() => {
		if (!diskUsage) return 0;
		return (diskUsage.LayersSize || 0) +
			(diskUsage.Volumes?.reduce((sum: number, v: any) => sum + (v.UsageData?.Size || 0), 0) || 0);
	});

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	}

	async function switchEnvironment(envId: number) {
		// Don't switch if already on this environment
		if (Number(envId) === Number(currentEnvId)) {
			showDropdown = false;
			return;
		}

		// Don't switch if already switching
		if (switchingEnvId !== null) {
			return;
		}

		// IMMEDIATELY abort all pending requests for current environment
		abortPendingRequests();

		// Clear stale data immediately for instant UI feedback
		diskUsage = null;
		diskUsageLoading = false;

		const targetEnv = envList.find((e: Environment) => Number(e.id) === Number(envId));
		const envName = targetEnv?.name || `Environment ${envId}`;

		// Mark as switching and create new abort controller
		switchingEnvId = envId;
		showDropdown = false;
		envAbortController = new AbortController();

		try {
			// Try to connect to the new environment first
			const url = `/api/host?env=${envId}`;
			const response = await fetch(url, { signal: envAbortController.signal });

			if (!response.ok) {
				offlineEnvIds.add(envId);
				offlineEnvIds = new Set(offlineEnvIds);
				toast.error(`Cannot switch to "${envName}" - environment is offline`);
				return;
			}

			const newHostInfo = await response.json();

			if (newHostInfo.error) {
				offlineEnvIds.add(envId);
				offlineEnvIds = new Set(offlineEnvIds);
				toast.error(`Cannot switch to "${envName}" - ${newHostInfo.error}`);
				return;
			}

			// Environment is online, proceed with switch
			offlineEnvIds.delete(envId);
			offlineEnvIds = new Set(offlineEnvIds);
			currentEnvId = envId;
			hostInfo = newHostInfo;
			lastUpdated = new Date();

			// Fetch disk usage (non-blocking, uses shared abort controller)
			fetchDiskUsage();

			// Update the store
			if (newHostInfo.environment) {
				currentEnvironment.set({
					id: newHostInfo.environment.id,
					name: newHostInfo.environment.name,
					highlightChanges: newHostInfo.environment.highlightChanges ?? true
				});
			}
		} catch (error) {
			// Ignore abort errors
			if (error instanceof Error && error.name === 'AbortError') {
				return;
			}
			offlineEnvIds.add(envId);
			offlineEnvIds = new Set(offlineEnvIds);
			toast.error(`Cannot switch to "${envName}" - connection failed`);
		} finally {
			switchingEnvId = null;
		}
	}

	function formatMemory(bytes: number): string {
		const gb = bytes / (1024 * 1024 * 1024);
		return `${gb.toFixed(1)} GB`;
	}

	function formatUptime(seconds: number): string {
		const days = Math.floor(seconds / 86400);
		const hours = Math.floor((seconds % 86400) / 3600);
		if (days > 0) {
			return `${days}d ${hours}h`;
		}
		return `${hours}h`;
	}

	let memoryPercent = $derived(
		hostInfo ? ((hostInfo.totalMemory - hostInfo.freeMemory) / hostInfo.totalMemory) * 100 : 0
	);

	function handleClickOutside(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (!target.closest('.env-dropdown')) {
			showDropdown = false;
		}
	}

	onMount(() => {
		// Create initial abort controller
		envAbortController = new AbortController();
		fetchHostInfo();
		fetchDiskUsage();
		// No polling - only fetch on mount and environment switch
		document.addEventListener('click', handleClickOutside);
		return () => {
			abortPendingRequests(); // Abort on destroy
			document.removeEventListener('click', handleClickOutside);
		};
	});

</script>

<div class="flex items-center gap-3 min-w-0 {textSizeClass()} text-muted-foreground">
	<!-- Environment Selector - always show -->
	<div class="relative env-dropdown">
		<button
			onclick={() => (showDropdown = !showDropdown)}
			class="flex items-center gap-1.5 -ml-1 px-1 py-1 rounded-md hover:bg-muted transition-colors cursor-pointer"
		>
			{#if hostInfo?.environment && Number(hostInfo.environment.id) === Number(currentEnvId)}
				{@const EnvIcon = getIconComponent(hostInfo.environment.icon || 'globe')}
				<EnvIcon class="{iconSizeLargeClass()} text-primary" />
				<span class="font-medium text-foreground">{hostInfo.environment.name}</span>
			{:else if currentEnvId && envList.length > 0}
				{@const currentEnv = envList.find(e => Number(e.id) === Number(currentEnvId))}
				{#if currentEnv}
					{@const EnvIcon = getIconComponent(currentEnv.icon || 'globe')}
					<EnvIcon class="{iconSizeLargeClass()} text-primary" />
					<span class="font-medium text-foreground">{currentEnv.name}</span>
				{:else}
					<Globe class="{iconSizeLargeClass()} text-muted-foreground" />
					<span class="font-medium text-foreground">Select environment</span>
				{/if}
			{:else}
				<Globe class="{iconSizeLargeClass()} text-muted-foreground" />
				<span class="font-medium text-foreground">No environments</span>
			{/if}
			<ChevronDown class="{iconSizeClass()}" />
		</button>

		{#if showDropdown && envList.length > 0}
			<div class="absolute top-full left-0 mt-1 min-w-56 w-max max-w-80 bg-popover border rounded-md shadow-lg z-50">
				<div class="py-1">
					{#each envList as env (env.id)}
						{@const EnvIcon = getIconComponent(env.icon || 'globe')}
						{@const isOffline = offlineEnvIds.has(env.id)}
						{@const isSwitching = switchingEnvId === env.id}
						<button
							onclick={() => switchEnvironment(env.id)}
							disabled={isSwitching}
							class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer disabled:cursor-wait disabled:opacity-70"
							class:opacity-60={isOffline && !isSwitching}
						>
							{#if isSwitching}
								<Loader2 class="{iconSizeLargeClass()} text-muted-foreground shrink-0 animate-spin" />
							{:else if isOffline}
								<WifiOff class="{iconSizeLargeClass()} text-destructive shrink-0" />
							{:else}
								<EnvIcon class="{iconSizeLargeClass()} text-muted-foreground shrink-0" />
							{/if}
							<span class="flex-1 whitespace-nowrap" class:text-muted-foreground={isOffline}>{env.name}</span>
							{#if isOffline && !isSwitching}
								<span class="text-xs text-destructive">offline</span>
							{:else if Number(env.id) === Number(currentEnvId)}
								<Check class="{iconSizeLargeClass()} text-primary shrink-0" />
							{/if}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	{#if hostInfo}
		<span class="text-border">|</span>

		<!-- Platform/OS -->
		<span class="hidden md:inline">{hostInfo.platform} {hostInfo.arch}</span>

		<span class="hidden md:inline text-border">|</span>

		<!-- Docker version -->
		<span class="hidden md:inline">Docker {hostInfo.dockerVersion}</span>

		<span class="hidden md:inline text-border">|</span>

		<!-- Connection type -->
		<div class="hidden md:flex items-center gap-1">
			{#if hostInfo.environment?.connectionType === 'hawser-standard'}
				<Route class="{iconSizeClass()}" />
				<span>Hawser (standard){hostInfo.environment.hawserVersion ? ` ${hostInfo.environment.hawserVersion}` : ''}</span>
			{:else if hostInfo.environment?.connectionType === 'hawser-edge'}
				<UndoDot class="{iconSizeClass()}" />
				<span>Hawser (edge){hostInfo.environment.hawserVersion ? ` ${hostInfo.environment.hawserVersion}` : ''}</span>
			{:else}
				<Icon iconNode={whale} class="{iconSizeClass()}" />
				<span>Socket</span>
			{/if}
		</div>

		<span class="hidden md:inline text-border">|</span>

		<!-- CPU cores -->
		{#if hostInfo.cpus > 0}
			<span class="hidden lg:inline">{hostInfo.cpus} cores</span>
			<span class="hidden lg:inline text-border">|</span>
		{/if}

		<!-- Memory -->
		{#if hostInfo.totalMemory > 0}
			<span class="hidden lg:inline">{formatBytes(hostInfo.totalMemory)} RAM</span>
			<span class="hidden lg:inline text-border">|</span>
		{/if}

		<!-- Disk usage - only show when data is available (hide on timeout/error) -->
		{#if diskUsage && !diskUsageLoading}
			<div class="hidden xl:flex items-center gap-1">
				<HardDrive class="{iconSizeClass()}" />
				<span>{formatBytes(totalDiskUsage())}</span>
			</div>
			<span class="hidden xl:inline text-border">|</span>
		{/if}

		<!-- Uptime - hidden for direct remote connections without Hawser -->
		{#if hostInfo.uptime > 0}
			<div class="hidden xl:flex items-center gap-1">
				<Clock class="{iconSizeClass()}" />
				<span>{formatUptime(hostInfo.uptime)}</span>
			</div>
			<span class="hidden xl:inline text-border">|</span>
		{/if}

		<!-- Live indicator with timestamp -->
		<div
			class="flex items-center gap-2 {isConnected ? 'text-emerald-500' : 'text-muted-foreground'}"
			title={isConnected ? 'Live updates connected' : 'Live updates disconnected'}
		>
			<span class="text-muted-foreground">{formatTime(lastUpdated, { includeSeconds: true })}</span>
			{#if isConnected}
				<Wifi class="{iconSizeLargeClass()}" />
				<span class="font-medium">Live</span>
			{:else}
				<WifiOff class="{iconSizeLargeClass()}" />
			{/if}
		</div>
	{/if}
</div>
