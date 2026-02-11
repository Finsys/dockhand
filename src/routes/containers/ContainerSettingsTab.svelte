<script lang="ts">
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { TogglePill, ToggleGroup } from '$lib/components/ui/toggle-pill';
	import { Plus, Trash2, Settings2, RefreshCw, Network, X, Ban, RotateCw, AlertTriangle, PauseCircle, Share2, Server, CircleOff, ChevronDown, ChevronRight, Cpu, Shield, HeartPulse, Wifi, HardDrive, Lock, Loader2, CheckCircle2, Package, Gpu } from 'lucide-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import AutoUpdateSettings from './AutoUpdateSettings.svelte';
	import type { VulnerabilityCriteria } from '$lib/components/VulnerabilityCriteriaSelector.svelte';
	import type { SystemContainerType } from '$lib/types';

	// Detect system containers (must match server-side logic in update-utils.ts)
	function detectSystemContainer(imageName: string): SystemContainerType | null {
		const lower = imageName.toLowerCase();
		if (lower.includes('fnsys/dockhand')) return 'dockhand';
		if (lower.includes('finsys/hawser') || lower.includes('ghcr.io/finsys/hawser')) return 'hawser';
		return null;
	}

	// Protocol options for ports
	const protocolOptions = [
		{ value: 'tcp', label: 'TCP' },
		{ value: 'udp', label: 'UDP' }
	];

	// Mode options for volumes
	const volumeModeOptions = [
		{ value: 'rw', label: 'RW' },
		{ value: 'ro', label: 'RO' }
	];

	const commonCapabilities = [
		'SYS_ADMIN', 'SYS_PTRACE', 'SYS_RAWIO', 'NET_ADMIN', 'NET_RAW', 'IPC_LOCK',
		'SYS_TIME', 'SYS_RESOURCE', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP',
		'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID',
		'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'AUDIT_CONTROL'
	];

	const commonUlimits = ['nofile', 'nproc', 'core', 'memlock', 'stack', 'cpu', 'fsize', 'locks'];

	const commonGpuCapabilities = ['gpu', 'compute', 'utility', 'graphics', 'video', 'display'];

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

	interface DockerNetwork {
		id: string;
		name: string;
		driver: string;
	}

	interface Props {
		mode: 'create' | 'edit';
		// Basic settings
		name: string;
		image: string;
		command: string;
		restartPolicy: string;
		restartMaxRetries: number | '';
		networkMode: string;
		startAfterCreate?: boolean;
		repullImage?: boolean;
		// Port mappings
		portMappings: { hostPort: string; containerPort: string; protocol: string }[];
		// Volume mappings
		volumeMappings: { hostPath: string; containerPath: string; mode: string }[];
		// Environment variables
		envVars: { key: string; value: string }[];
		// Labels
		labels: { key: string; value: string }[];
		// Networks
		availableNetworks: DockerNetwork[];
		selectedNetworks: string[];
		// User/Group
		containerUser: string;
		// Privileged mode
		privilegedMode: boolean;
		// Healthcheck settings
		healthcheckEnabled: boolean;
		healthcheckCommand: string;
		healthcheckInterval: number;
		healthcheckTimeout: number;
		healthcheckRetries: number;
		healthcheckStartPeriod: number;
		// Resource limits
		memoryLimit: string;
		memoryReservation: string;
		cpuShares: string;
		nanoCpus: string;
		cpuQuota: string;
		cpuPeriod: string;
		// Capabilities
		capAdd: string[];
		capDrop: string[];
		// Security options
		securityOptions: string[];
		// Devices
		deviceMappings: { hostPath: string; containerPath: string; permissions: string }[];
		// GPU settings
		gpuEnabled: boolean;
		gpuMode: 'all' | 'count' | 'specific';
		gpuCount: number;
		gpuDeviceIds: string[];
		gpuDriver: string;
		gpuCapabilities: string[];
		runtime: string;
		// DNS settings
		dnsServers: string[];
		dnsSearch: string[];
		dnsOptions: string[];
		// Ulimits
		ulimits: { name: string; soft: string; hard: string }[];
		// Auto-update
		autoUpdateEnabled: boolean;
		autoUpdateCronExpression: string;
		vulnerabilityCriteria: VulnerabilityCriteria;
		// Config sets
		configSets: ConfigSet[];
		selectedConfigSetId: string;
		// Errors
		errors: { name?: string; image?: string };
		// Create mode specific
		imageSummary?: {
			isPulling: boolean;
			isScanning: boolean;
			imageReady: boolean;
			scanResults?: { summary: { critical: number; high: number } }[];
			totalVulnerabilities?: number;
			hasCriticalOrHigh?: boolean;
		};
	}

	let {
		mode,
		name = $bindable(),
		image = $bindable(),
		command = $bindable(),
		restartPolicy = $bindable(),
		restartMaxRetries = $bindable(),
		networkMode = $bindable(),
		startAfterCreate = $bindable(true),
		repullImage = $bindable(true),
		portMappings = $bindable(),
		volumeMappings = $bindable(),
		envVars = $bindable(),
		labels = $bindable(),
		availableNetworks,
		selectedNetworks = $bindable(),
		containerUser = $bindable(),
		privilegedMode = $bindable(),
		healthcheckEnabled = $bindable(),
		healthcheckCommand = $bindable(),
		healthcheckInterval = $bindable(),
		healthcheckTimeout = $bindable(),
		healthcheckRetries = $bindable(),
		healthcheckStartPeriod = $bindable(),
		memoryLimit = $bindable(),
		memoryReservation = $bindable(),
		cpuShares = $bindable(),
		nanoCpus = $bindable(),
		cpuQuota = $bindable(),
		cpuPeriod = $bindable(),
		capAdd = $bindable(),
		capDrop = $bindable(),
		securityOptions = $bindable(),
		deviceMappings = $bindable(),
		gpuEnabled = $bindable(),
		gpuMode = $bindable(),
		gpuCount = $bindable(),
		gpuDeviceIds = $bindable(),
		gpuDriver = $bindable(),
		gpuCapabilities = $bindable(),
		runtime = $bindable(),
		dnsServers = $bindable(),
		dnsSearch = $bindable(),
		dnsOptions = $bindable(),
		ulimits = $bindable(),
		autoUpdateEnabled = $bindable(),
		autoUpdateCronExpression = $bindable(),
		vulnerabilityCriteria = $bindable(),
		configSets,
		selectedConfigSetId = $bindable(),
		errors = $bindable(),
		imageSummary
	}: Props = $props();

	// Collapsible sections state
	let showResources = $state(false);
	let showSecurity = $state(false);
	let showHealth = $state(false);
	let showDns = $state(false);
	let showDevices = $state(false);
	let showGpu = $state(false);
	let showUlimits = $state(false);

	// DNS input fields
	let dnsInput = $state('');
	let dnsSearchInput = $state('');
	let dnsOptionInput = $state('');

	// Security options input
	let securityOptionInput = $state('');

	// GPU device ID input
	let gpuDeviceIdInput = $state('');
	let customRuntimeInput = $state('');

	// Helper functions for form
	function addPortMapping() {
		portMappings = [...portMappings, { hostPort: '', containerPort: '', protocol: 'tcp' }];
	}

	function removePortMapping(index: number) {
		portMappings = portMappings.filter((_, i) => i !== index);
	}

	function addVolumeMapping() {
		volumeMappings = [...volumeMappings, { hostPath: '', containerPath: '', mode: 'rw' }];
	}

	function removeVolumeMapping(index: number) {
		volumeMappings = volumeMappings.filter((_, i) => i !== index);
	}

	function addEnvVar() {
		envVars = [...envVars, { key: '', value: '' }];
	}

	function removeEnvVar(index: number) {
		envVars = envVars.filter((_, i) => i !== index);
	}

	function addLabel() {
		labels = [...labels, { key: '', value: '' }];
	}

	function removeLabel(index: number) {
		labels = labels.filter((_, i) => i !== index);
	}

	function addNetwork(networkId: string) {
		if (networkId && !selectedNetworks.includes(networkId)) {
			selectedNetworks = [...selectedNetworks, networkId];
		}
	}

	function removeNetwork(networkId: string) {
		selectedNetworks = selectedNetworks.filter((n) => n !== networkId);
	}

	function addDeviceMapping() {
		deviceMappings = [...deviceMappings, { hostPath: '', containerPath: '', permissions: 'rwm' }];
	}

	function removeDeviceMapping(index: number) {
		deviceMappings = deviceMappings.filter((_, i) => i !== index);
	}

	function addUlimit() {
		ulimits = [...ulimits, { name: 'nofile', soft: '', hard: '' }];
	}

	function removeUlimit(index: number) {
		ulimits = ulimits.filter((_, i) => i !== index);
	}

	function addGpuDeviceId() {
		if (gpuDeviceIdInput.trim() && !gpuDeviceIds.includes(gpuDeviceIdInput.trim())) {
			gpuDeviceIds = [...gpuDeviceIds, gpuDeviceIdInput.trim()];
			gpuDeviceIdInput = '';
		}
	}

	function removeGpuDeviceId(id: string) {
		gpuDeviceIds = gpuDeviceIds.filter(d => d !== id);
	}

	function addGpuCapability(cap: string) {
		if (cap && !gpuCapabilities.includes(cap)) {
			gpuCapabilities = [...gpuCapabilities, cap];
		}
	}

	function removeGpuCapability(cap: string) {
		gpuCapabilities = gpuCapabilities.filter(c => c !== cap);
	}

	function addCapability(type: 'add' | 'drop', cap: string) {
		if (!cap) return;
		const capUpper = cap.toUpperCase();
		if (type === 'add') {
			if (!capAdd.includes(capUpper)) {
				capAdd = [...capAdd, capUpper];
			}
		} else {
			if (!capDrop.includes(capUpper)) {
				capDrop = [...capDrop, capUpper];
			}
		}
	}

	function removeCapability(type: 'add' | 'drop', cap: string) {
		if (type === 'add') {
			capAdd = capAdd.filter(c => c !== cap);
		} else {
			capDrop = capDrop.filter(c => c !== cap);
		}
	}

	function addSecurityOption() {
		if (securityOptionInput.trim() && !securityOptions.includes(securityOptionInput.trim())) {
			securityOptions = [...securityOptions, securityOptionInput.trim()];
			securityOptionInput = '';
		}
	}

	function removeSecurityOption(option: string) {
		securityOptions = securityOptions.filter(o => o !== option);
	}

	function addDnsServer() {
		if (dnsInput.trim() && !dnsServers.includes(dnsInput.trim())) {
			dnsServers = [...dnsServers, dnsInput.trim()];
			dnsInput = '';
		}
	}

	function removeDnsServer(server: string) {
		dnsServers = dnsServers.filter(s => s !== server);
	}

	function addDnsSearch() {
		if (dnsSearchInput.trim() && !dnsSearch.includes(dnsSearchInput.trim())) {
			dnsSearch = [...dnsSearch, dnsSearchInput.trim()];
			dnsSearchInput = '';
		}
	}

	function removeDnsSearch(domain: string) {
		dnsSearch = dnsSearch.filter(d => d !== domain);
	}

	function addDnsOption() {
		if (dnsOptionInput.trim() && !dnsOptions.includes(dnsOptionInput.trim())) {
			dnsOptions = [...dnsOptions, dnsOptionInput.trim()];
			dnsOptionInput = '';
		}
	}

	function removeDnsOption(option: string) {
		dnsOptions = dnsOptions.filter(o => o !== option);
	}

	function applyConfigSet(configSetId: string) {
		selectedConfigSetId = configSetId;
		if (!configSetId) return;

		const configSet = configSets.find((c) => c.id === parseInt(configSetId));
		if (!configSet) return;

		if (configSet.envVars && configSet.envVars.length > 0) {
			if (mode === 'edit') {
				// Merge mode for edit
				const existingKeys = new Set(envVars.map(e => e.key).filter(k => k));
				const newEnvVars = configSet.envVars.filter(e => !existingKeys.has(e.key));
				envVars = [...envVars.filter(e => e.key), ...newEnvVars.map(e => ({ ...e }))];
				if (envVars.length === 0) envVars = [{ key: '', value: '' }];
			} else {
				envVars = configSet.envVars.map((e) => ({ ...e }));
			}
		}
		if (configSet.labels && configSet.labels.length > 0) {
			if (mode === 'edit') {
				const existingKeys = new Set(labels.map(l => l.key).filter(k => k));
				const newLabels = configSet.labels.filter(l => !existingKeys.has(l.key));
				labels = [...labels.filter(l => l.key), ...newLabels.map(l => ({ ...l }))];
				if (labels.length === 0) labels = [{ key: '', value: '' }];
			} else {
				labels = configSet.labels.map((l) => ({ ...l }));
			}
		}
		if (configSet.ports && configSet.ports.length > 0) {
			if (mode === 'edit') {
				const existingPorts = new Set(portMappings.map(p => `${p.hostPort}:${p.containerPort}`).filter(p => p !== ':'));
				const newPorts = configSet.ports.filter(p => !existingPorts.has(`${p.hostPort}:${p.containerPort}`));
				portMappings = [...portMappings.filter(p => p.hostPort || p.containerPort), ...newPorts.map(p => ({ ...p }))];
				if (portMappings.length === 0) portMappings = [{ hostPort: '', containerPort: '', protocol: 'tcp' }];
			} else {
				portMappings = configSet.ports.map((p) => ({ ...p }));
			}
		}
		if (configSet.volumes && configSet.volumes.length > 0) {
			if (mode === 'edit') {
				const existingPaths = new Set(volumeMappings.map(v => v.containerPath).filter(p => p));
				const newVolumes = configSet.volumes.filter(v => !existingPaths.has(v.containerPath));
				volumeMappings = [...volumeMappings.filter(v => v.hostPath || v.containerPath), ...newVolumes.map(v => ({ ...v }))];
				if (volumeMappings.length === 0) volumeMappings = [{ hostPath: '', containerPath: '', mode: 'rw' }];
			} else {
				volumeMappings = configSet.volumes.map((v) => ({ ...v }));
			}
		}
		if (configSet.networkMode) {
			networkMode = configSet.networkMode;
		}
		if (configSet.restartPolicy) {
			restartPolicy = configSet.restartPolicy;
		}
	}

	function getDriverBadgeClasses(driver: string): string {
		const base = 'text-2xs px-1.5 py-0.5 rounded font-medium';
		switch (driver.toLowerCase()) {
			case 'bridge': return `${base} bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300`;
			case 'host': return `${base} bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300`;
			case 'null': case 'none': return `${base} bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400`;
			case 'overlay': return `${base} bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300`;
			case 'macvlan': return `${base} bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300`;
			default: return `${base} bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400`;
		}
	}
</script>

<div class="space-y-5">
	<!-- Image Summary (create mode only) -->
	{#if mode === 'create' && imageSummary}
		<div class="p-3 rounded-lg bg-muted/50 border">
			<div class="flex items-center gap-3">
				<Package class="w-5 h-5 text-muted-foreground" />
				<div>
					<p class="text-sm font-medium">Image: <code class="bg-muted px-1.5 py-0.5 rounded">{image || 'Not set'}</code></p>
					{#if imageSummary.isPulling || imageSummary.isScanning}
						<p class="text-xs text-blue-600 flex items-center gap-1 mt-0.5">
							<Loader2 class="w-3 h-3 animate-spin" />
							{imageSummary.isScanning ? 'Scanning...' : 'Pulling...'}
						</p>
					{:else if imageSummary.imageReady}
						<p class="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
							<CheckCircle2 class="w-3 h-3" />
							Image pulled and ready
							{#if imageSummary.scanResults && imageSummary.scanResults.length > 0}
								• <span class="{imageSummary.hasCriticalOrHigh ? 'text-red-600' : (imageSummary.totalVulnerabilities ?? 0) > 0 ? 'text-amber-600' : 'text-green-600'}">{imageSummary.totalVulnerabilities ?? 0} vulnerabilities</span>
							{/if}
						</p>
					{:else if !image}
						<p class="text-xs text-amber-600 flex items-center gap-1 mt-0.5">
							<AlertTriangle class="w-3 h-3" />
							Go to "Pull" tab to set the image
						</p>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	<!-- Config Set Selector -->
	{#if configSets.length > 0}
		<div class="space-y-2">
			<div class="flex items-center gap-2 pb-2 border-b">
				<Settings2 class="w-4 h-4 text-muted-foreground" />
				<h3 class="text-sm font-semibold text-foreground">{mode === 'edit' ? 'Apply config set' : 'Config set'}</h3>
			</div>
			<div class="flex gap-2 items-end">
				<div class="flex-1">
					<Select.Root type="single" value={selectedConfigSetId} onValueChange={applyConfigSet}>
						<Select.Trigger class="w-full h-9">
							<span>{selectedConfigSetId ? configSets.find(c => c.id === parseInt(selectedConfigSetId))?.name : (mode === 'edit' ? 'Select a config set to merge values...' : 'Select a config set to pre-fill values...')}</span>
						</Select.Trigger>
						<Select.Content>
							{#each configSets as configSet}
								<Select.Item value={String(configSet.id)} label={configSet.name}>
									<div class="flex flex-col">
										<span>{configSet.name}</span>
										{#if configSet.description}
											<span class="text-xs text-muted-foreground">{configSet.description}</span>
										{/if}
									</div>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			</div>
			{#if mode === 'edit'}
				<p class="text-xs text-muted-foreground">Note: Values from the config set will be merged with existing settings. Existing keys won't be overwritten.</p>
			{/if}
		</div>
	{/if}

	<!-- Basic Settings -->
	<div class="space-y-3">
		<div class="flex items-center gap-2 pb-2 border-b">
			<h3 class="text-sm font-semibold text-foreground">Basic settings</h3>
		</div>

		<div class="grid grid-cols-2 gap-3">
			<div class="space-y-1.5">
				<Label for="name" class="text-xs font-medium">Container name *</Label>
				<Input
					id="name"
					bind:value={name}
					placeholder="my-container"
					required
					class="h-9 {errors.name ? 'border-destructive focus-visible:ring-destructive' : ''}"
					oninput={() => errors.name = undefined}
				/>
				{#if errors.name}
					<p class="text-xs text-destructive">{errors.name}</p>
				{/if}
			</div>
			{#if mode === 'edit'}
				<div class="space-y-1.5">
					<Label for="image" class="text-xs font-medium">Image *</Label>
					<Input
						id="image"
						bind:value={image}
						placeholder="nginx:latest"
						required
						class="h-9 {errors.image ? 'border-destructive focus-visible:ring-destructive' : ''}"
						oninput={() => errors.image = undefined}
					/>
					{#if errors.image}
						<p class="text-xs text-destructive">{errors.image}</p>
					{/if}
				</div>
			{/if}
		</div>

		<div class="space-y-1.5">
			<Label for="command" class="text-xs font-medium">Command (optional)</Label>
			<Input id="command" bind:value={command} placeholder="/bin/sh -c 'echo hello'" class="h-9" />
		</div>

		<div class="grid grid-cols-2 gap-3">
			<div class="space-y-1.5">
				<Label class="text-xs font-medium">Restart policy</Label>
				<Select.Root type="single" bind:value={restartPolicy}>
					<Select.Trigger id="restartPolicy" tabindex={0} class="w-full h-9">
						<span class="flex items-center">
							{#if restartPolicy === 'no'}
								<Ban class="w-3.5 h-3.5 mr-2 text-muted-foreground" />
							{:else if restartPolicy === 'always'}
								<RotateCw class="w-3.5 h-3.5 mr-2 text-green-500" />
							{:else if restartPolicy === 'on-failure'}
								<AlertTriangle class="w-3.5 h-3.5 mr-2 text-amber-500" />
							{:else}
								<PauseCircle class="w-3.5 h-3.5 mr-2 text-blue-500" />
							{/if}
							{restartPolicy === 'no' ? 'No' : restartPolicy === 'always' ? 'Always' : restartPolicy === 'on-failure' ? 'On failure' : 'Unless stopped'}
						</span>
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="no">
							{#snippet children()}
								<Ban class="w-3.5 h-3.5 mr-2 text-muted-foreground" />
								No
							{/snippet}
						</Select.Item>
						<Select.Item value="always">
							{#snippet children()}
								<RotateCw class="w-3.5 h-3.5 mr-2 text-green-500" />
								Always
							{/snippet}
						</Select.Item>
						<Select.Item value="on-failure">
							{#snippet children()}
								<AlertTriangle class="w-3.5 h-3.5 mr-2 text-amber-500" />
								On failure
							{/snippet}
						</Select.Item>
						<Select.Item value="unless-stopped">
							{#snippet children()}
								<PauseCircle class="w-3.5 h-3.5 mr-2 text-blue-500" />
								Unless stopped
							{/snippet}
						</Select.Item>
					</Select.Content>
				</Select.Root>
				{#if restartPolicy === 'on-failure'}
					<div class="space-y-1.5 mt-2">
						<Label class="text-xs font-medium">Max retry count</Label>
						<Input
							type="number"
							bind:value={restartMaxRetries}
							placeholder="Unlimited"
							min="0"
							class="h-9"
						/>
						<p class="text-xs text-muted-foreground">Leave empty for unlimited retries</p>
					</div>
				{/if}
			</div>

			<div class="space-y-1.5">
				<Label class="text-xs font-medium">Network mode</Label>
				<Select.Root type="single" bind:value={networkMode}>
					<Select.Trigger id="networkMode" tabindex={0} class="w-full h-9">
						<span class="flex items-center">
							{#if networkMode === 'bridge'}
								<Share2 class="w-3.5 h-3.5 mr-2 text-emerald-500" />
							{:else if networkMode === 'host'}
								<Server class="w-3.5 h-3.5 mr-2 text-sky-500" />
							{:else}
								<CircleOff class="w-3.5 h-3.5 mr-2 text-muted-foreground" />
							{/if}
							{networkMode === 'bridge' ? 'Bridge' : networkMode === 'host' ? 'Host' : 'None'}
						</span>
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="bridge">
							{#snippet children()}
								<Share2 class="w-3.5 h-3.5 mr-2 text-emerald-500" />
								Bridge
							{/snippet}
						</Select.Item>
						<Select.Item value="host">
							{#snippet children()}
								<Server class="w-3.5 h-3.5 mr-2 text-sky-500" />
								Host
							{/snippet}
						</Select.Item>
						<Select.Item value="none">
							{#snippet children()}
								<CircleOff class="w-3.5 h-3.5 mr-2 text-muted-foreground" />
								None
							{/snippet}
						</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>
		</div>

		<div class="flex items-center gap-3 pt-1">
			<Label class="text-xs font-normal">Pull image before update</Label>
			<TogglePill bind:checked={repullImage} />
		</div>

		<div class="flex items-center gap-3 pt-1">
			<Label class="text-xs font-normal">Start container after {mode === 'create' ? 'creation' : 'update'}</Label>
			<TogglePill bind:checked={startAfterCreate} />
		</div>
	</div>

	<!-- Networks -->
	{#if availableNetworks.length > 0}
		<div class="space-y-2">
			<div class="flex justify-between items-center pb-2 border-b">
				<div class="flex items-center gap-2">
					<Network class="w-4 h-4 text-muted-foreground" />
					<h3 class="text-sm font-semibold text-foreground">Networks</h3>
				</div>
			</div>

			<div class="space-y-2">
				<Select.Root type="single" value="" onValueChange={addNetwork}>
					<Select.Trigger tabindex={0} class="w-full h-9">
						<span class="text-muted-foreground">Select network to add...</span>
					</Select.Trigger>
					<Select.Content>
						{#each availableNetworks.filter(n => !selectedNetworks.includes(n.name) && !['bridge', 'host', 'none'].includes(n.name)) as network}
							<Select.Item value={network.name}>
								{#snippet children()}
									<div class="flex items-center justify-between w-full">
										<span>{network.name}</span>
										<span class={getDriverBadgeClasses(network.driver)}>{network.driver}</span>
									</div>
								{/snippet}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>

				{#if selectedNetworks.length > 0}
					<div class="flex flex-wrap gap-2 pt-1">
						{#each selectedNetworks as networkName}
							{@const network = availableNetworks.find(n => n.name === networkName)}
							<Badge variant="secondary" class="flex items-center gap-1.5 pr-1">
								{networkName}
								{#if network}
									<span class={getDriverBadgeClasses(network.driver)}>{network.driver}</span>
								{/if}
								<button
									type="button"
									onclick={() => removeNetwork(networkName)}
									class="ml-0.5 hover:bg-destructive/20 rounded p-0.5"
								>
									<X class="w-3 h-3" />
								</button>
							</Badge>
						{/each}
					</div>
				{/if}
				{#if mode === 'edit'}
					<p class="text-xs text-muted-foreground">Container will be connected to selected networks in addition to the network mode above</p>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Port Mappings -->
	<div class="space-y-2">
		<div class="flex justify-between items-center pb-2 border-b">
			<h3 class="text-sm font-semibold text-foreground">Port mappings</h3>
			<Button type="button" size="sm" variant="ghost" onclick={addPortMapping} class="h-7 text-xs">
				<Plus class="w-3.5 h-3.5" />
				Add
			</Button>
		</div>

		<div class="space-y-2">
			{#each portMappings as mapping, index}
				<div class="flex gap-2 items-center">
					<div class="flex-1 relative">
						<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Host</span>
						<Input bind:value={mapping.hostPort} type="number" class="h-9" />
					</div>
					<div class="flex-1 relative">
						<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Container</span>
						<Input bind:value={mapping.containerPort} type="number" class="h-9" />
					</div>
					<ToggleGroup
						value={mapping.protocol}
						options={protocolOptions}
						onchange={(v) => { portMappings[index].protocol = v; }}
					/>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						onclick={() => removePortMapping(index)}
						disabled={portMappings.length === 1}
						class="h-9 w-9 text-muted-foreground hover:text-destructive"
					>
						<Trash2 class="w-4 h-4" />
					</Button>
				</div>
			{/each}
		</div>
	</div>

	<!-- Volume Mappings -->
	<div class="space-y-2">
		<div class="flex justify-between items-center pb-2 border-b">
			<h3 class="text-sm font-semibold text-foreground">Volume mappings</h3>
			<Button type="button" size="sm" variant="ghost" onclick={addVolumeMapping} class="h-7 text-xs">
				<Plus class="w-3.5 h-3.5" />
				Add
			</Button>
		</div>

		<div class="space-y-2">
			{#each volumeMappings as mapping, index}
				<div class="flex gap-2 items-center">
					<div class="flex-1 relative">
						<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Host path</span>
						<Input bind:value={mapping.hostPath} class="h-9" />
					</div>
					<div class="flex-1 relative">
						<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Container path</span>
						<Input bind:value={mapping.containerPath} class="h-9" />
					</div>
					<ToggleGroup
						value={mapping.mode}
						options={volumeModeOptions}
						onchange={(v) => { volumeMappings[index].mode = v; }}
					/>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						onclick={() => removeVolumeMapping(index)}
						disabled={volumeMappings.length === 1}
						class="h-9 w-9 text-muted-foreground hover:text-destructive"
					>
						<Trash2 class="w-4 h-4" />
					</Button>
				</div>
			{/each}
		</div>
	</div>

	<!-- Environment Variables -->
	<div class="space-y-2">
		<div class="flex justify-between items-center pb-2 border-b">
			<h3 class="text-sm font-semibold text-foreground">Environment variables</h3>
			<Button type="button" size="sm" variant="ghost" onclick={addEnvVar} class="h-7 text-xs">
				<Plus class="w-3.5 h-3.5" />
				Add
			</Button>
		</div>

		<div class="space-y-2">
			{#each envVars as envVar, index}
				<div class="flex gap-2 items-center">
					<div class="flex-1 relative">
						<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Key</span>
						<Input bind:value={envVar.key} class="h-9" />
					</div>
					<div class="flex-1 relative">
						<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Value</span>
						<Input bind:value={envVar.value} class="h-9" />
					</div>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						onclick={() => removeEnvVar(index)}
						disabled={envVars.length === 1}
						class="h-9 w-9 text-muted-foreground hover:text-destructive"
					>
						<Trash2 class="w-4 h-4" />
					</Button>
				</div>
			{/each}
		</div>
	</div>

	<!-- Labels -->
	<div class="space-y-2">
		<div class="flex justify-between items-center pb-2 border-b">
			<h3 class="text-sm font-semibold text-foreground">Labels</h3>
			<Button type="button" size="sm" variant="ghost" onclick={addLabel} class="h-7 text-xs">
				<Plus class="w-3.5 h-3.5" />
				Add
			</Button>
		</div>

		<div class="space-y-2">
			{#each labels as label, index}
				<div class="flex gap-2 items-center">
					<div class="flex-1 relative">
						<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Key</span>
						<Input bind:value={label.key} class="h-9" />
					</div>
					<div class="flex-1 relative">
						<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Value</span>
						<Input bind:value={label.value} class="h-9" />
					</div>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						onclick={() => removeLabel(index)}
						disabled={labels.length === 1}
						class="h-9 w-9 text-muted-foreground hover:text-destructive"
					>
						<Trash2 class="w-4 h-4" />
					</Button>
				</div>
			{/each}
		</div>
	</div>

	<!-- Advanced Options Header -->
	<div class="pt-2">
		<p class="text-xs text-muted-foreground mb-3">Advanced container options (click to expand)</p>
	</div>

	<!-- Resources Section (Collapsible) -->
	<div class="border rounded-lg">
		<button
			type="button"
			onclick={() => showResources = !showResources}
			class="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
		>
			<div class="flex items-center gap-2">
				<Cpu class="w-4 h-4 text-muted-foreground" />
				<span class="text-sm font-medium">Resources</span>
				{#if memoryLimit || nanoCpus || cpuShares}
					<Badge variant="secondary" class="text-2xs">configured</Badge>
				{/if}
			</div>
			{#if showResources}
				<ChevronDown class="w-4 h-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="w-4 h-4 text-muted-foreground" />
			{/if}
		</button>
		{#if showResources}
			<div class="px-3 pb-3 space-y-3 border-t">
				<p class="text-xs text-muted-foreground pt-2">Configure memory and CPU limits for this container</p>
				<div class="grid grid-cols-2 gap-3">
					<div class="space-y-1.5">
						<Label for="memoryLimit" class="text-xs font-medium">Memory limit</Label>
						<Input id="memoryLimit" bind:value={memoryLimit} placeholder="e.g., 512m, 1g" class="h-9" />
					</div>
					<div class="space-y-1.5">
						<Label for="memoryReservation" class="text-xs font-medium">Memory reservation</Label>
						<Input id="memoryReservation" bind:value={memoryReservation} placeholder="e.g., 256m" class="h-9" />
					</div>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div class="space-y-1.5">
						<Label for="nanoCpus" class="text-xs font-medium">CPU limit</Label>
						<Input id="nanoCpus" bind:value={nanoCpus} placeholder="e.g., 0.5, 1.5, 2" class="h-9" />
					</div>
					<div class="space-y-1.5">
						<Label for="cpuShares" class="text-xs font-medium">CPU shares</Label>
						<Input id="cpuShares" bind:value={cpuShares} type="number" placeholder="1024" class="h-9" />
					</div>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div class="space-y-1.5">
						<Label for="cpuQuota" class="text-xs font-medium">CPU quota</Label>
						<Input id="cpuQuota" bind:value={cpuQuota} type="number" placeholder="e.g., 50000" class="h-9" />
						<p class="text-xs text-muted-foreground">Microseconds per period</p>
					</div>
					<div class="space-y-1.5">
						<Label for="cpuPeriod" class="text-xs font-medium">CPU period</Label>
						<Input id="cpuPeriod" bind:value={cpuPeriod} type="number" placeholder="Default: 100000" class="h-9" />
						<p class="text-xs text-muted-foreground">Period in microseconds</p>
					</div>
				</div>
			</div>
		{/if}
	</div>

	<!-- Security Section (Collapsible) -->
	<div class="border rounded-lg">
		<button
			type="button"
			onclick={() => showSecurity = !showSecurity}
			class="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
		>
			<div class="flex items-center gap-2">
				<Shield class="w-4 h-4 text-muted-foreground" />
				<span class="text-sm font-medium">Security</span>
				{#if privilegedMode || containerUser || capAdd.length > 0 || capDrop.length > 0 || securityOptions.length > 0}
					<Badge variant="secondary" class="text-2xs">configured</Badge>
				{/if}
			</div>
			{#if showSecurity}
				<ChevronDown class="w-4 h-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="w-4 h-4 text-muted-foreground" />
			{/if}
		</button>
		{#if showSecurity}
			<div class="px-3 pb-3 space-y-3 border-t">
				<div class="grid grid-cols-2 gap-3 pt-2">
					<div class="space-y-1.5">
						<Label for="containerUser" class="text-xs font-medium">User</Label>
						<Input id="containerUser" bind:value={containerUser} placeholder="user:group or UID:GID" class="h-9" />
					</div>
					<div class="space-y-1.5 flex flex-col justify-center pt-4">
						<div class="flex items-center space-x-2">
							<Checkbox id="privilegedMode" bind:checked={privilegedMode} />
							<Label for="privilegedMode" class="text-xs font-normal flex items-center gap-1">
								<Lock class="w-3 h-3 text-amber-500" />
								Privileged mode
							</Label>
						</div>
					</div>
				</div>

				<div class="space-y-2">
					<Label class="text-xs font-medium">Add capabilities</Label>
					<Select.Root type="single" value="" onValueChange={(v) => { addCapability('add', v); }}>
						<Select.Trigger class="h-9">
							<span class="text-muted-foreground">Select capability to add...</span>
						</Select.Trigger>
						<Select.Content>
							{#each commonCapabilities.filter(c => !capAdd.includes(c)) as cap}
								<Select.Item value={cap} label={cap} />
							{/each}
						</Select.Content>
					</Select.Root>
					{#if capAdd.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each capAdd as cap}
								<Badge variant="outline" class="text-2xs bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400">
									+{cap}
									<button type="button" onclick={() => removeCapability('add', cap)} class="ml-1 hover:text-destructive">
										<X class="w-3 h-3" />
									</button>
								</Badge>
							{/each}
						</div>
					{/if}
				</div>

				<div class="space-y-2">
					<Label class="text-xs font-medium">Drop capabilities</Label>
					<Select.Root type="single" value="" onValueChange={(v) => { addCapability('drop', v); }}>
						<Select.Trigger class="h-9">
							<span class="text-muted-foreground">Select capability to drop...</span>
						</Select.Trigger>
						<Select.Content>
							{#each commonCapabilities.filter(c => !capDrop.includes(c)) as cap}
								<Select.Item value={cap} label={cap} />
							{/each}
						</Select.Content>
					</Select.Root>
					{#if capDrop.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each capDrop as cap}
								<Badge variant="outline" class="text-2xs bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400">
									-{cap}
									<button type="button" onclick={() => removeCapability('drop', cap)} class="ml-1 hover:text-destructive">
										<X class="w-3 h-3" />
									</button>
								</Badge>
							{/each}
						</div>
					{/if}
				</div>

				<div class="space-y-2 pt-2 border-t">
					<Label class="text-xs font-medium">Security options</Label>
					<div class="flex gap-2">
						<Input
							bind:value={securityOptionInput}
							placeholder="e.g., no-new-privileges, seccomp=unconfined"
							class="h-9 flex-1"
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSecurityOption(); } }}
						/>
						<Button type="button" size="sm" variant="outline" onclick={addSecurityOption} class="h-9">
							<Plus class="w-4 h-4" />
						</Button>
					</div>
					{#if securityOptions.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each securityOptions as option}
								<Badge variant="secondary" class="text-2xs">
									{option}
									<button type="button" onclick={() => removeSecurityOption(option)} class="ml-1 hover:text-destructive">
										<X class="w-3 h-3" />
									</button>
								</Badge>
							{/each}
						</div>
					{/if}
					<p class="text-xs text-muted-foreground">Common options: no-new-privileges, seccomp=unconfined, apparmor=unconfined</p>
				</div>
			</div>
		{/if}
	</div>

	<!-- Health Section (Collapsible) -->
	<div class="border rounded-lg">
		<button
			type="button"
			onclick={() => showHealth = !showHealth}
			class="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
		>
			<div class="flex items-center gap-2">
				<HeartPulse class="w-4 h-4 text-muted-foreground" />
				<span class="text-sm font-medium">Healthcheck</span>
				{#if healthcheckEnabled}
					<Badge variant="secondary" class="text-2xs">enabled</Badge>
				{/if}
			</div>
			{#if showHealth}
				<ChevronDown class="w-4 h-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="w-4 h-4 text-muted-foreground" />
			{/if}
		</button>
		{#if showHealth}
			<div class="px-3 pb-3 space-y-3 border-t">
				<div class="flex items-center space-x-2 pt-2">
					<Checkbox id="healthcheckEnabled" bind:checked={healthcheckEnabled} />
					<Label for="healthcheckEnabled" class="text-xs font-normal">Enable healthcheck</Label>
				</div>
				{#if healthcheckEnabled}
					<div class="space-y-1.5">
						<Label for="healthcheckCommand" class="text-xs font-medium">Command</Label>
						<Input id="healthcheckCommand" bind:value={healthcheckCommand} placeholder="e.g., curl -f http://localhost/ || exit 1" class="h-9" />
					</div>
					<div class="grid grid-cols-4 gap-3">
						<div class="space-y-1.5">
							<Label for="healthcheckInterval" class="text-xs font-medium">Interval (s)</Label>
							<Input id="healthcheckInterval" type="number" bind:value={healthcheckInterval} min="1" class="h-9" />
						</div>
						<div class="space-y-1.5">
							<Label for="healthcheckTimeout" class="text-xs font-medium">Timeout (s)</Label>
							<Input id="healthcheckTimeout" type="number" bind:value={healthcheckTimeout} min="1" class="h-9" />
						</div>
						<div class="space-y-1.5">
							<Label for="healthcheckRetries" class="text-xs font-medium">Retries</Label>
							<Input id="healthcheckRetries" type="number" bind:value={healthcheckRetries} min="1" class="h-9" />
						</div>
						<div class="space-y-1.5">
							<Label for="healthcheckStartPeriod" class="text-xs font-medium">Start (s)</Label>
							<Input id="healthcheckStartPeriod" type="number" bind:value={healthcheckStartPeriod} min="0" class="h-9" />
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- DNS Section (Collapsible) -->
	<div class="border rounded-lg">
		<button
			type="button"
			onclick={() => showDns = !showDns}
			class="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
		>
			<div class="flex items-center gap-2">
				<Wifi class="w-4 h-4 text-muted-foreground" />
				<span class="text-sm font-medium">DNS settings</span>
				{#if dnsServers.length > 0 || dnsSearch.length > 0}
					<Badge variant="secondary" class="text-2xs">configured</Badge>
				{/if}
			</div>
			{#if showDns}
				<ChevronDown class="w-4 h-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="w-4 h-4 text-muted-foreground" />
			{/if}
		</button>
		{#if showDns}
			<div class="px-3 pb-3 space-y-3 border-t">
				<div class="space-y-2 pt-2">
					<Label class="text-xs font-medium">DNS servers</Label>
					<div class="flex gap-2">
						<Input
							bind:value={dnsInput}
							placeholder="e.g., 8.8.8.8"
							class="h-9 flex-1"
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDnsServer(); } }}
						/>
						<Button type="button" size="sm" variant="outline" onclick={addDnsServer} class="h-9">
							<Plus class="w-4 h-4" />
						</Button>
					</div>
					{#if dnsServers.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each dnsServers as server}
								<Badge variant="secondary" class="text-2xs">
									{server}
									<button type="button" onclick={() => removeDnsServer(server)} class="ml-1 hover:text-destructive">
										<X class="w-3 h-3" />
									</button>
								</Badge>
							{/each}
						</div>
					{/if}
				</div>

				<!-- DNS Search domains -->
				<div class="space-y-2">
					<Label class="text-xs font-medium">DNS search domains</Label>
					<div class="flex gap-2">
						<Input
							bind:value={dnsSearchInput}
							placeholder="e.g., example.com"
							class="h-9 flex-1"
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDnsSearch(); } }}
						/>
						<Button type="button" size="sm" variant="outline" onclick={addDnsSearch} class="h-9">
							<Plus class="w-4 h-4" />
						</Button>
					</div>
					{#if dnsSearch.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each dnsSearch as domain}
								<Badge variant="secondary" class="text-2xs">
									{domain}
									<button type="button" onclick={() => removeDnsSearch(domain)} class="ml-1 hover:text-destructive">
										<X class="w-3 h-3" />
									</button>
								</Badge>
							{/each}
						</div>
					{/if}
				</div>

				<!-- DNS Options -->
				<div class="space-y-2">
					<Label class="text-xs font-medium">DNS options</Label>
					<div class="flex gap-2">
						<Input
							bind:value={dnsOptionInput}
							placeholder="e.g., ndots:5"
							class="h-9 flex-1"
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDnsOption(); } }}
						/>
						<Button type="button" size="sm" variant="outline" onclick={addDnsOption} class="h-9">
							<Plus class="w-4 h-4" />
						</Button>
					</div>
					{#if dnsOptions.length > 0}
						<div class="flex flex-wrap gap-1.5">
							{#each dnsOptions as option}
								<Badge variant="secondary" class="text-2xs">
									{option}
									<button type="button" onclick={() => removeDnsOption(option)} class="ml-1 hover:text-destructive">
										<X class="w-3 h-3" />
									</button>
								</Badge>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<!-- Devices Section (Collapsible) -->
	<div class="border rounded-lg">
		<button
			type="button"
			onclick={() => showDevices = !showDevices}
			class="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
		>
			<div class="flex items-center gap-2">
				<HardDrive class="w-4 h-4 text-muted-foreground" />
				<span class="text-sm font-medium">Devices</span>
				{#if deviceMappings.length > 0}
					<Badge variant="secondary" class="text-2xs">{deviceMappings.length}</Badge>
				{/if}
			</div>
			{#if showDevices}
				<ChevronDown class="w-4 h-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="w-4 h-4 text-muted-foreground" />
			{/if}
		</button>
		{#if showDevices}
			<div class="px-3 pb-3 space-y-3 border-t">
				<div class="flex justify-end pt-2">
					<Button type="button" size="sm" variant="ghost" onclick={addDeviceMapping} class="h-7 text-xs">
						<Plus class="w-3.5 h-3.5" />
						Add device
					</Button>
				</div>
				{#each deviceMappings as mapping, index}
					<div class="flex gap-2 items-center">
						<Input bind:value={mapping.hostPath} placeholder="/dev/sda" class="h-9 flex-1" />
						<Input bind:value={mapping.containerPath} placeholder="/dev/sda" class="h-9 flex-1" />
						<Button
							type="button"
							size="icon"
							variant="ghost"
							onclick={() => removeDeviceMapping(index)}
							class="h-9 w-9 text-muted-foreground hover:text-destructive"
						>
							<Trash2 class="w-4 h-4" />
						</Button>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- GPU Section (Collapsible) -->
	<div class="border rounded-lg">
		<button
			type="button"
			onclick={() => showGpu = !showGpu}
			class="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
		>
			<div class="flex items-center gap-2">
				<Gpu class="w-4 h-4 text-muted-foreground" />
				<span class="text-sm font-medium">GPU</span>
				{#if gpuEnabled}
					<Badge variant="secondary" class="text-2xs">configured</Badge>
				{/if}
			</div>
			{#if showGpu}
				<ChevronDown class="w-4 h-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="w-4 h-4 text-muted-foreground" />
			{/if}
		</button>
		{#if showGpu}
			<div class="px-3 pb-3 space-y-3 border-t">
				<div class="flex items-center justify-between pt-2">
					<Label class="text-xs font-medium">Enable GPU access</Label>
					<TogglePill bind:checked={gpuEnabled} />
				</div>

				<div class="space-y-1.5">
					<Label class="text-xs font-medium">Runtime</Label>
					<div class="flex gap-2">
						<Select.Root type="single" value={runtime === '' ? '' : runtime === 'nvidia' ? 'nvidia' : 'custom'} onValueChange={(v) => {
							if (v === '') runtime = '';
							else if (v === 'nvidia') runtime = 'nvidia';
							else if (v === 'custom') runtime = customRuntimeInput || '';
						}}>
							<Select.Trigger class="h-9 flex-1">
								<span>{runtime === '' ? 'Default (runc)' : runtime === 'nvidia' ? 'NVIDIA' : `Custom: ${runtime}`}</span>
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="" label="Default (runc)" />
								<Select.Item value="nvidia" label="NVIDIA" />
								<Select.Item value="custom" label="Custom..." />
							</Select.Content>
						</Select.Root>
						{#if runtime !== '' && runtime !== 'nvidia'}
							<Input
								bind:value={customRuntimeInput}
								placeholder="Runtime name"
								class="h-9 w-40"
								oninput={() => { runtime = customRuntimeInput; }}
							/>
						{/if}
					</div>
				</div>

				{#if gpuEnabled}
					<div class="space-y-1.5">
						<Label class="text-xs font-medium">GPU mode</Label>
						<ToggleGroup
							value={gpuMode}
							options={[
								{ value: 'all', label: 'All' },
								{ value: 'count', label: 'Count' },
								{ value: 'specific', label: 'Specific' }
							]}
							onchange={(v) => { gpuMode = v as 'all' | 'count' | 'specific'; }}
						/>
					</div>

					{#if gpuMode === 'count'}
						<div class="space-y-1.5">
							<Label class="text-xs font-medium">GPU count</Label>
							<Input type="number" bind:value={gpuCount} min="1" placeholder="1" class="h-9 w-24" />
						</div>
					{/if}

					{#if gpuMode === 'specific'}
						<div class="space-y-2">
							<Label class="text-xs font-medium">Device IDs</Label>
							<div class="flex gap-2">
								<Input
									bind:value={gpuDeviceIdInput}
									placeholder="e.g., 0, GPU-xxxx"
									class="h-9 flex-1"
									onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGpuDeviceId(); } }}
								/>
								<Button type="button" size="sm" variant="outline" onclick={addGpuDeviceId} class="h-9">
									<Plus class="w-4 h-4" />
								</Button>
							</div>
							{#if gpuDeviceIds.length > 0}
								<div class="flex flex-wrap gap-1.5">
									{#each gpuDeviceIds as id}
										<Badge variant="secondary" class="text-2xs">
											{id}
											<button type="button" onclick={() => removeGpuDeviceId(id)} class="ml-1 hover:text-destructive">
												<X class="w-3 h-3" />
											</button>
										</Badge>
									{/each}
								</div>
							{/if}
						</div>
					{/if}

					<div class="space-y-1.5">
						<Label class="text-xs font-medium">Driver</Label>
						<Input bind:value={gpuDriver} placeholder="nvidia" class="h-9" />
					</div>

					<div class="space-y-2">
						<Label class="text-xs font-medium">Capabilities</Label>
						<Select.Root type="single" value="" onValueChange={(v) => { addGpuCapability(v); }}>
							<Select.Trigger class="h-9">
								<span class="text-muted-foreground">Add capability...</span>
							</Select.Trigger>
							<Select.Content>
								{#each commonGpuCapabilities.filter(c => !gpuCapabilities.includes(c)) as cap}
									<Select.Item value={cap} label={cap} />
								{/each}
							</Select.Content>
						</Select.Root>
						{#if gpuCapabilities.length > 0}
							<div class="flex flex-wrap gap-1.5">
								{#each gpuCapabilities as cap}
									<Badge variant="outline" class="text-2xs bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
										{cap}
										<button type="button" onclick={() => removeGpuCapability(cap)} class="ml-1 hover:text-destructive">
											<X class="w-3 h-3" />
										</button>
									</Badge>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Ulimits Section (Collapsible) -->
	<div class="border rounded-lg">
		<button
			type="button"
			onclick={() => showUlimits = !showUlimits}
			class="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
		>
			<div class="flex items-center gap-2">
				<Settings2 class="w-4 h-4 text-muted-foreground" />
				<span class="text-sm font-medium">Ulimits</span>
				{#if ulimits.length > 0}
					<Badge variant="secondary" class="text-2xs">{ulimits.length}</Badge>
				{/if}
			</div>
			{#if showUlimits}
				<ChevronDown class="w-4 h-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="w-4 h-4 text-muted-foreground" />
			{/if}
		</button>
		{#if showUlimits}
			<div class="px-3 pb-3 space-y-3 border-t">
				<div class="flex justify-end pt-2">
					<Button type="button" size="sm" variant="ghost" onclick={addUlimit} class="h-7 text-xs">
						<Plus class="w-3.5 h-3.5" />
						Add ulimit
					</Button>
				</div>
				{#each ulimits as ulimit, index}
					<div class="flex gap-2 items-center">
						<Select.Root type="single" bind:value={ulimit.name}>
							<Select.Trigger class="w-32 h-9">
								<span>{ulimit.name}</span>
							</Select.Trigger>
							<Select.Content>
								{#each commonUlimits as name}
									<Select.Item value={name} label={name} />
								{/each}
							</Select.Content>
						</Select.Root>
						<Input bind:value={ulimit.soft} type="number" placeholder="Soft" class="h-9 flex-1" />
						<Input bind:value={ulimit.hard} type="number" placeholder="Hard" class="h-9 flex-1" />
						<Button
							type="button"
							size="icon"
							variant="ghost"
							onclick={() => removeUlimit(index)}
							class="h-9 w-9 text-muted-foreground hover:text-destructive"
						>
							<Trash2 class="w-4 h-4" />
						</Button>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Auto-update Settings -->
	<div class="space-y-3">
		<div class="flex items-center gap-2 pb-2 border-b">
			<RefreshCw class="w-4 h-4 text-muted-foreground" />
			<h3 class="text-sm font-semibold text-foreground">Auto-update</h3>
		</div>
		<AutoUpdateSettings
			bind:enabled={autoUpdateEnabled}
			bind:cronExpression={autoUpdateCronExpression}
			bind:vulnerabilityCriteria={vulnerabilityCriteria}
			systemContainer={detectSystemContainer(image)}
		/>
	</div>
</div>
