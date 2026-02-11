<script lang="ts">
	import { tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { ArrowBigRight, Settings2, Shield, Loader2, Download, CheckCircle2, XCircle, ShieldCheck, ShieldAlert, ShieldX, AlertTriangle, X, Play } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { currentEnvironment } from '$lib/stores/environment';
	import { focusFirstInput } from '$lib/utils';
	import PullTab from '$lib/components/PullTab.svelte';
	import ScanTab from '$lib/components/ScanTab.svelte';
	import type { ScanResult } from '$lib/components/ScanTab.svelte';
	import ContainerSettingsTab from './ContainerSettingsTab.svelte';
	import type { VulnerabilityCriteria } from '$lib/components/VulnerabilityCriteriaSelector.svelte';

	// Parse shell command respecting quotes
	function parseShellCommand(cmd: string): string[] {
		const args: string[] = [];
		let current = '';
		let inQuotes = false;
		let quoteChar = '';

		for (let i = 0; i < cmd.length; i++) {
			const char = cmd[i];

			if ((char === '"' || char === "'") && !inQuotes) {
				inQuotes = true;
				quoteChar = char;
			} else if (char === quoteChar && inQuotes) {
				inQuotes = false;
				quoteChar = '';
			} else if (char === ' ' && !inQuotes) {
				if (current) {
					args.push(current);
					current = '';
				}
			} else {
				current += char;
			}
		}

		if (current) {
			args.push(current);
		}

		return args;
	}

	interface ConfigSet {
		id: number;
		name: string;
		description?: string;
		envVars?: { key: string; value: string }[];
		labels?: { key: string; value: string }[];
		ports?: { hostPort: string; containerPort: string; protocol: string }[];
		volumes?: { hostPath: string; containerPath: string; mode: string }[];
		networkMode: string;
		restartPolicy: string;
	}


	interface Props {
		open: boolean;
		onClose?: () => void;
		onSuccess?: () => void;
		prefilledImage?: string;
		skipPullTab?: boolean;
		autoPull?: boolean;
	}

	let { open = $bindable(), onClose, onSuccess, prefilledImage, skipPullTab = false, autoPull = false }: Props = $props();

	// Track if we've already auto-pulled for this modal session
	let hasAutoPulled = $state(false);

	// Tab state - start on settings if skipping pull tab
	let activeTab = $state<'pull' | 'scan' | 'container'>(skipPullTab ? 'container' : 'pull');

	// Config sets
	let configSets = $state<ConfigSet[]>([]);
	let selectedConfigSetId = $state<string>('');

	// Form state
	let name = $state('');
	let image = $state('');
	let command = $state('');
	let restartPolicy = $state('no');
	let restartMaxRetries = $state<number | ''>('');
	let networkMode = $state('bridge');
	let startAfterCreate = $state(true);

	// Port mappings
	let portMappings = $state<{ hostPort: string; containerPort: string; protocol: string }[]>([
		{ hostPort: '', containerPort: '', protocol: 'tcp' }
	]);

	// Volume mappings
	let volumeMappings = $state<{ hostPath: string; containerPath: string; mode: string }[]>([
		{ hostPath: '', containerPath: '', mode: 'rw' }
	]);

	// Environment variables
	let envVars = $state<{ key: string; value: string }[]>([{ key: '', value: '' }]);

	// Labels
	let labels = $state<{ key: string; value: string }[]>([{ key: '', value: '' }]);

	// Networks
	interface DockerNetwork {
		id: string;
		name: string;
		driver: string;
	}
	let availableNetworks = $state<DockerNetwork[]>([]);
	let selectedNetworks = $state<string[]>([]);

	// Auto-update settings
	let autoUpdateEnabled = $state(false);
	let autoUpdateCronExpression = $state('0 3 * * *');
	let vulnerabilityCriteria = $state<VulnerabilityCriteria>('never');


	// User/Group
	let containerUser = $state('');

	// Privileged mode
	let privilegedMode = $state(false);

	// Healthcheck settings
	let healthcheckEnabled = $state(false);
	let healthcheckCommand = $state('');
	let healthcheckInterval = $state(30);
	let healthcheckTimeout = $state(30);
	let healthcheckRetries = $state(3);
	let healthcheckStartPeriod = $state(0);

	// Resource limits
	let memoryLimit = $state('');
	let memoryReservation = $state('');
	let cpuShares = $state('');
	let nanoCpus = $state('');
	let cpuQuota = $state('');
	let cpuPeriod = $state('');

	// Capabilities
	let capAdd = $state<string[]>([]);
	let capDrop = $state<string[]>([]);

	// Devices
	let deviceMappings = $state<{ hostPath: string; containerPath: string; permissions: string }[]>([]);

	// DNS settings
	let dnsServers = $state<string[]>([]);
	let dnsSearch = $state<string[]>([]);
	let dnsOptions = $state<string[]>([]);

	// Security options
	let securityOptions = $state<string[]>([]);

	// Ulimits
	let ulimits = $state<{ name: string; soft: string; hard: string }[]>([]);

	// GPU settings
	let gpuEnabled = $state(false);
	let gpuMode = $state<'all' | 'count' | 'specific'>('all');
	let gpuCount = $state(1);
	let gpuDeviceIds = $state<string[]>([]);
	let gpuDriver = $state('');
	let gpuCapabilities = $state<string[]>(['gpu']);
	let runtime = $state('');

	let loading = $state(false);
	let errors = $state<{ name?: string; image?: string }>({});

	// Component refs
	let pullTabRef: PullTab | undefined;
	let scanTabRef: ScanTab | undefined;

	// Pull & Scan status (tracked via component callbacks)
	let pullStatus = $state<'idle' | 'pulling' | 'complete' | 'error'>('idle');
	let pullStarted = $state(false);
	let scanStatus = $state<'idle' | 'scanning' | 'complete' | 'error'>('idle');
	let scanStarted = $state(false);
	let scanResults = $state<ScanResult[]>([]);

	// Scanner settings - scanning is enabled if a scanner is configured
	let envHasScanning = $state(false);

	// Fetch config sets and networks when modal opens
	$effect(() => {
		if (open) {
			fetchConfigSets();
			fetchNetworks();
			fetchScannerSettings();
		}
	});

	// Track previous open state to detect when modal opens
	let wasOpen = $state(false);

	$effect(() => {
		if (open && !wasOpen) {
			// Modal just opened - reset state
			pullStatus = 'idle';
			pullStarted = !skipPullTab;
			scanStatus = 'idle';
			scanStarted = false;
			scanResults = [];
			hasAutoPulled = false;
			autoSwitchedToScan = false;
			autoSwitchedToContainer = false;
			activeTab = skipPullTab ? 'container' : 'pull';

			// Reset components
			pullTabRef?.reset();
			scanTabRef?.reset();

			// Set image from prefilledImage if provided
			if (prefilledImage) {
				image = prefilledImage;
			}
		}
		wasOpen = open;
	});

	// Auto-pull when autoPull is true and modal opens with an image
	$effect(() => {
		if (autoPull && open && prefilledImage && !hasAutoPulled && pullStatus === 'idle') {
			hasAutoPulled = true;
			// Small delay to ensure component is mounted
			setTimeout(() => pullTabRef?.startPull(), 100);
		}
	});

	// Track auto-switch state to prevent re-triggering when user manually clicks tabs
	let autoSwitchedToScan = $state(false);
	let autoSwitchedToContainer = $state(false);

	// Handle pull completion
	function handlePullComplete() {
		pullStatus = 'complete';
		// Auto-start scan if enabled
		if (envHasScanning && !autoSwitchedToScan) {
			autoSwitchedToScan = true;
			scanStarted = true;
			activeTab = 'scan';
			// Start scan with small delay for tab switch
			setTimeout(() => scanTabRef?.startScan(), 100);
		} else if (!envHasScanning && !autoSwitchedToContainer) {
			// Go to container tab if no scan
			autoSwitchedToContainer = true;
			activeTab = 'container';
		}
	}

	function handlePullError(error: string) {
		pullStatus = 'error';
	}

	function handlePullStatusChange(status: 'idle' | 'pulling' | 'complete' | 'error') {
		pullStatus = status;
	}

	function handleScanComplete(results: ScanResult[]) {
		scanStatus = 'complete';
		scanResults = results;
		// Auto-switch to container tab
		if (!autoSwitchedToContainer) {
			autoSwitchedToContainer = true;
			activeTab = 'container';
		}
	}

	function handleScanError(error: string) {
		scanStatus = 'error';
	}

	function handleScanStatusChange(status: 'idle' | 'scanning' | 'complete' | 'error') {
		scanStatus = status;
	}

	async function fetchNetworks() {
		try {
			const envParam = $currentEnvironment ? `?env=${$currentEnvironment.id}` : '';
			const response = await fetch(`/api/networks${envParam}`);
			if (response.ok) {
				availableNetworks = await response.json();
			}
		} catch (err) {
			console.error('Failed to fetch networks:', err);
		}
	}

	async function fetchConfigSets() {
		try {
			const response = await fetch('/api/config-sets');
			if (response.ok) {
				configSets = await response.json();
			}
		} catch (err) {
			console.error('Failed to fetch config sets:', err);
		}
	}

	async function fetchScannerSettings() {
		try {
			const envId = $currentEnvironment?.id;
			const url = envId ? `/api/settings/scanner?env=${envId}&settingsOnly=true` : '/api/settings/scanner?settingsOnly=true';
			const response = await fetch(url);
			if (response.ok) {
				const data = await response.json();
				const scanner = data.settings?.scanner ?? 'none';
				// Scanning is enabled if a scanner is configured
				envHasScanning = scanner !== 'none';
			}
		} catch (err) {
			console.error('Failed to fetch scanner settings:', err);
		}
	}


	function parseMemory(value: string): number | undefined {
		if (!value) return undefined;
		const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?b?)?$/);
		if (!match) return undefined;
		const num = parseFloat(match[1]);
		const unit = match[2] || '';
		switch (unit) {
			case 'k': case 'kb': return Math.floor(num * 1024);
			case 'm': case 'mb': return Math.floor(num * 1024 * 1024);
			case 'g': case 'gb': return Math.floor(num * 1024 * 1024 * 1024);
			case 't': case 'tb': return Math.floor(num * 1024 * 1024 * 1024 * 1024);
			default: return Math.floor(num);
		}
	}

	function parseNanoCpus(value: string): number | undefined {
		if (!value) return undefined;
		const num = parseFloat(value);
		if (isNaN(num)) return undefined;
		return Math.floor(num * 1e9);
	}

	async function handleSubmit(e: Event) {
		e.preventDefault();
		errors = {};

		let hasErrors = false;
		if (!name.trim()) {
			errors.name = 'Container name is required';
			hasErrors = true;
		}

		if (!image.trim()) {
			errors.image = 'Image name is required';
			hasErrors = true;
		}

		if (hasErrors) {
			return;
		}

		loading = true;

		try {
			const ports: any = {};
			portMappings
				.filter((p) => p.containerPort && p.hostPort)
				.forEach((p) => {
					const key = `${p.containerPort}/${p.protocol}`;
					ports[key] = { HostPort: String(p.hostPort) };
				});

			const volumeBinds = volumeMappings
				.filter((v) => v.hostPath && v.containerPath)
				.map((v) => `${v.hostPath}:${v.containerPath}:${v.mode}`);

			const env = envVars
				.filter((e) => e.key && e.value)
				.map((e) => `${e.key}=${e.value}`);

			const labelsObj: any = {};
			labels
				.filter((l) => l.key && l.value)
				.forEach((l) => {
					labelsObj[l.key] = l.value;
				});

			const cmd = command.trim() ? parseShellCommand(command.trim()) : undefined;

			let healthcheck: any = undefined;
			if (healthcheckEnabled && healthcheckCommand.trim()) {
				healthcheck = {
					test: ['CMD-SHELL', healthcheckCommand.trim()],
					interval: healthcheckInterval * 1e9,
					timeout: healthcheckTimeout * 1e9,
					retries: healthcheckRetries,
					startPeriod: healthcheckStartPeriod * 1e9
				};
			}

			const devices = deviceMappings
				.filter(d => d.hostPath && d.containerPath)
				.map(d => ({
					hostPath: d.hostPath,
					containerPath: d.containerPath,
					permissions: d.permissions || 'rwm'
				}));

			const ulimitsArray = ulimits
				.filter(u => u.name && u.soft && u.hard)
				.map(u => ({
					name: u.name,
					soft: parseInt(u.soft) || 0,
					hard: parseInt(u.hard) || 0
				}));

			let deviceRequests: any[] | undefined = undefined;
			if (gpuEnabled) {
				const dr: any = {
					capabilities: gpuCapabilities.length > 0 ? [gpuCapabilities] : [['gpu']],
					driver: gpuDriver || undefined
				};
				if (gpuMode === 'all') {
					dr.count = -1;
				} else if (gpuMode === 'count') {
					dr.count = gpuCount || 1;
				} else {
					dr.count = 0;
					dr.deviceIDs = gpuDeviceIds.filter(id => id.trim());
				}
				deviceRequests = [dr];
			}

			const payload = {
				name: name.trim(),
				image: image.trim(),
				ports: Object.keys(ports).length > 0 ? ports : undefined,
				volumeBinds: volumeBinds.length > 0 ? volumeBinds : undefined,
				env: env.length > 0 ? env : undefined,
				labels: Object.keys(labelsObj).length > 0 ? labelsObj : undefined,
				cmd,
				restartPolicy,
				restartMaxRetries: restartPolicy === 'on-failure' && restartMaxRetries !== '' ? Number(restartMaxRetries) : undefined,
				networkMode,
				networks: selectedNetworks.length > 0 ? selectedNetworks : undefined,
				startAfterCreate,
				user: containerUser.trim() || undefined,
				privileged: privilegedMode || undefined,
				healthcheck,
				memory: parseMemory(memoryLimit),
				memoryReservation: parseMemory(memoryReservation),
				cpuShares: cpuShares ? parseInt(cpuShares) : undefined,
				nanoCpus: parseNanoCpus(nanoCpus),
				cpuQuota: cpuQuota ? parseInt(cpuQuota) : undefined,
				cpuPeriod: cpuPeriod ? parseInt(cpuPeriod) : undefined,
				capAdd: capAdd.length > 0 ? capAdd : undefined,
				capDrop: capDrop.length > 0 ? capDrop : undefined,
				devices: devices.length > 0 ? devices : undefined,
				deviceRequests,
				runtime: runtime || undefined,
				dns: dnsServers.length > 0 ? dnsServers : undefined,
				dnsSearch: dnsSearch.length > 0 ? dnsSearch : undefined,
				dnsOptions: dnsOptions.length > 0 ? dnsOptions : undefined,
				securityOpt: securityOptions.length > 0 ? securityOptions : undefined,
				ulimits: ulimitsArray.length > 0 ? ulimitsArray : undefined
			};

			const envParam = $currentEnvironment ? `?env=${$currentEnvironment.id}` : '';
			const response = await fetch(`/api/containers${envParam}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});

			const result = await response.json();

			if (!response.ok) {
				let errorMsg = result.error || 'Failed to create container';
				if (result.details) {
					errorMsg += ': ' + result.details;
				}
				toast.error(errorMsg);
				return;
			}

			if (autoUpdateEnabled) {
				try {
					const envParam = $currentEnvironment ? `?env=${$currentEnvironment.id}` : '';
					await fetch(`/api/auto-update/${encodeURIComponent(name.trim())}${envParam}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							enabled: autoUpdateEnabled,
							cronExpression: autoUpdateCronExpression,
							vulnerabilityCriteria: vulnerabilityCriteria
						})
					});
				} catch (err) {
					console.error('Failed to save auto-update settings:', err);
				}
			}

			if (result.imagePulled) {
				toast.success(`Container created (image ${image.trim()} was pulled automatically)`);
			} else {
				toast.success('Container created successfully');
			}

			open = false;
			resetForm();
			onSuccess?.();
			onClose?.();
		} catch (err) {
			toast.error('Failed to create container: ' + String(err));
		} finally {
			loading = false;
		}
	}

	function resetForm() {
		name = '';
		image = '';
		command = '';
		restartPolicy = 'no';
		restartMaxRetries = '';
		networkMode = 'bridge';
		startAfterCreate = true;
		portMappings = [{ hostPort: '', containerPort: '', protocol: 'tcp' }];
		volumeMappings = [{ hostPath: '', containerPath: '', mode: 'rw' }];
		envVars = [{ key: '', value: '' }];
		labels = [{ key: '', value: '' }];
		selectedNetworks = [];
		autoUpdateEnabled = false;
		autoUpdateCronExpression = '0 3 * * *';
		vulnerabilityCriteria = 'never';
		errors = {};
		selectedConfigSetId = '';
		containerUser = '';
		privilegedMode = false;
		healthcheckEnabled = false;
		healthcheckCommand = '';
		healthcheckInterval = 30;
		healthcheckTimeout = 30;
		healthcheckRetries = 3;
		healthcheckStartPeriod = 0;
		memoryLimit = '';
		memoryReservation = '';
		cpuShares = '';
		nanoCpus = '';
		cpuQuota = '';
		cpuPeriod = '';
		capAdd = [];
		capDrop = [];
		deviceMappings = [];
		dnsServers = [];
		dnsSearch = [];
		dnsOptions = [];
		securityOptions = [];
		ulimits = [];
		gpuEnabled = false;
		gpuMode = 'all';
		gpuCount = 1;
		gpuDeviceIds = [];
		gpuDriver = '';
		gpuCapabilities = ['gpu'];
		runtime = '';
		// Reset pull/scan state
		activeTab = skipPullTab ? 'container' : 'pull';
		pullStatus = 'idle';
		pullStarted = false;
		scanStatus = 'idle';
		scanStarted = false;
		scanResults = [];
		hasAutoPulled = false;
		autoSwitchedToScan = false;
		autoSwitchedToContainer = false;
		// Reset components
		pullTabRef?.reset();
		scanTabRef?.reset();
	}

	function handleClose() {
		open = false;
		resetForm();
		onClose?.();
	}

	const totalVulnerabilities = $derived(
		scanResults.reduce((total, r) => total + r.vulnerabilities.length, 0)
	);

	const hasCriticalOrHigh = $derived(
		scanResults.some(r => r.summary.critical > 0 || r.summary.high > 0)
	);

	const isPulling = $derived(pullStatus === 'pulling');
	const isScanning = $derived(scanStatus === 'scanning');
	const imageReady = $derived(pullStatus === 'complete');
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => isOpen && focusFirstInput()}>
	<Dialog.Content class="max-w-4xl w-full h-[85vh] p-0 flex flex-col overflow-hidden !zoom-in-0 !zoom-out-0" showCloseButton={false}>
		<Dialog.Header class="px-5 py-4 border-b bg-muted/30 shrink-0 sticky top-0 z-10">
			<Dialog.Title class="text-base font-semibold">Create new container</Dialog.Title>
			<button
				type="button"
				onclick={handleClose}
				disabled={loading || isPulling || isScanning}
				class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-30"
			>
				<X class="h-4 w-4" />
				<span class="sr-only">Close</span>
			</button>
		</Dialog.Header>

		<!-- Tabs (hidden when skipPullTab) -->
		{#if !skipPullTab}
		<div class="flex items-center border-b shrink-0 px-5 bg-muted/10">
			<!-- Pull Tab -->
			<button
				class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-2 {activeTab === 'pull' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => activeTab = 'pull'}
			>
				<Download class="w-4 h-4" />
				Pull
				{#if pullStatus === 'complete'}
					<CheckCircle2 class="w-3.5 h-3.5 text-green-500" />
				{:else if pullStatus === 'pulling'}
					<Loader2 class="w-3.5 h-3.5 animate-spin" />
				{:else if pullStatus === 'error'}
					<XCircle class="w-3.5 h-3.5 text-red-500" />
				{/if}
			</button>
			{#if envHasScanning}
				<ArrowBigRight class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
				<!-- Scan Tab -->
				<button
					class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-2 {activeTab === 'scan' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => activeTab = 'scan'}
					disabled={pullStatus === 'idle' || pullStatus === 'pulling'}
				>
					<Shield class="w-4 h-4" />
					Scan
					{#if scanStatus === 'complete' && scanResults.length > 0}
						{#if hasCriticalOrHigh}
							<ShieldX class="w-3.5 h-3.5 text-red-500" />
						{:else if totalVulnerabilities > 0}
							<ShieldAlert class="w-3.5 h-3.5 text-yellow-500" />
						{:else}
							<ShieldCheck class="w-3.5 h-3.5 text-green-500" />
						{/if}
					{:else if scanStatus === 'scanning'}
						<Loader2 class="w-3.5 h-3.5 animate-spin" />
					{/if}
				</button>
			{/if}
			<ArrowBigRight class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
			<!-- Container Tab -->
			<button
				class="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-2 {activeTab === 'container' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => activeTab = 'container'}
			>
				<Settings2 class="w-4 h-4" />
				Container
			</button>
		</div>
		{/if}

		<!-- Tab Content -->
		<!-- Pull Tab - using PullTab component -->
		<div class="px-5 py-4 flex-1 min-h-0 flex flex-col" class:hidden={activeTab !== 'pull'}>
			<PullTab
				bind:this={pullTabRef}
				imageName={image}
				envId={$currentEnvironment?.id}
				showImageInput={!autoPull}
				autoStart={pullStarted && pullStatus === 'idle' && !!prefilledImage}
				onComplete={handlePullComplete}
				onError={handlePullError}
				onStatusChange={handlePullStatusChange}
				onImageChange={(newImage) => image = newImage}
			/>
		</div>

		<!-- Scan Tab - using ScanTab component -->
		<div class="px-5 py-4 flex-1 min-h-0 flex flex-col" class:hidden={activeTab !== 'scan'}>
			{#if envHasScanning}
				<ScanTab
					bind:this={scanTabRef}
					imageName={image}
					envId={$currentEnvironment?.id}
					autoStart={scanStarted && scanStatus === 'idle'}
					onComplete={handleScanComplete}
					onError={handleScanError}
					onStatusChange={handleScanStatusChange}
				/>
			{:else}
				<!-- Scanning disabled -->
				<div class="flex-1 flex items-center justify-center">
					<div class="text-center">
						<Shield class="w-12 h-12 text-muted-foreground/50 mx-auto mb-2" />
						<p class="text-sm text-muted-foreground">Vulnerability scanning is disabled for this environment.</p>
						<p class="text-xs text-muted-foreground mt-1">Enable it in Settings -> Environments to scan images.</p>
					</div>
				</div>
			{/if}
		</div>

		<!-- Container Settings Tab -->
		<div class="px-5 py-4 flex-1 overflow-y-auto" class:hidden={activeTab !== 'container'}>
			<ContainerSettingsTab
				mode="create"
				bind:name
				bind:image
				bind:command
				bind:restartPolicy
				bind:restartMaxRetries
				bind:networkMode
				bind:startAfterCreate
				bind:portMappings
				bind:volumeMappings
				bind:envVars
				bind:labels
				{availableNetworks}
				bind:selectedNetworks
				bind:containerUser
				bind:privilegedMode
				bind:healthcheckEnabled
				bind:healthcheckCommand
				bind:healthcheckInterval
				bind:healthcheckTimeout
				bind:healthcheckRetries
				bind:healthcheckStartPeriod
				bind:memoryLimit
				bind:memoryReservation
				bind:cpuShares
				bind:nanoCpus
				bind:cpuQuota
				bind:cpuPeriod
				bind:capAdd
				bind:capDrop
				bind:securityOptions
				bind:deviceMappings
				bind:gpuEnabled
				bind:gpuMode
				bind:gpuCount
				bind:gpuDeviceIds
				bind:gpuDriver
				bind:gpuCapabilities
				bind:runtime
				bind:dnsServers
				bind:dnsSearch
				bind:dnsOptions
				bind:ulimits
				bind:autoUpdateEnabled
				bind:autoUpdateCronExpression
				bind:vulnerabilityCriteria
				{configSets}
				bind:selectedConfigSetId
				bind:errors
				imageSummary={{
					isPulling,
					isScanning,
					imageReady,
					scanResults,
					totalVulnerabilities,
					hasCriticalOrHigh
				}}
			/>
		</div>

		<div class="flex justify-between gap-2 px-5 py-3 border-t bg-muted/30 shrink-0">
			<div>
				{#if activeTab === 'container' && hasCriticalOrHigh}
					<div class="flex items-center gap-2 text-amber-600 text-xs">
						<AlertTriangle class="w-4 h-4" />
						<span>Critical/high vulnerabilities found in image</span>
					</div>
				{/if}
			</div>
			<div class="flex gap-2">
				<Button type="button" variant="outline" onclick={handleClose} disabled={loading || isPulling || isScanning}>
					Cancel
				</Button>
				<Button type="button" disabled={loading || isPulling || isScanning || activeTab !== 'container'} onclick={handleSubmit}>
					{#if loading}
						<Loader2 class="w-4 h-4 animate-spin" />
						Creating...
					{:else}
						<Play class="w-4 h-4" />
						Create container
					{/if}
				</Button>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
