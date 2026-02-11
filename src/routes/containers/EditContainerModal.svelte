<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Pencil, Check, Loader2, X, Layers } from 'lucide-svelte';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { focusFirstInput } from '$lib/utils';
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
		containerId: string;
		onClose: () => void;
		onSuccess: () => void;
	}

	let { open = $bindable(), containerId, onClose, onSuccess }: Props = $props();

	// Config sets
	let configSets = $state<ConfigSet[]>([]);
	let selectedConfigSetId = $state<string>('');

	// Guard to prevent reloading data while user is editing
	let hasLoadedData = $state(false);

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

	// Form state - Basic
	let name = $state('');
	let image = $state('');
	let command = $state('');
	let restartPolicy = $state('no');
	let restartMaxRetries = $state<number | ''>('');
	let networkMode = $state('bridge');
	let startAfterUpdate = $state(true);
	let repullImage = $state(true);

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

	// Auto-update settings
	let autoUpdateEnabled = $state(false);
	let autoUpdateCronExpression = $state('0 3 * * *');
	let vulnerabilityCriteria = $state<VulnerabilityCriteria>('never');
	let currentEnvId = $state<number | null>(null);
	currentEnvironment.subscribe(env => currentEnvId = env?.id || null);

	// Track original values to detect changes
	let originalConfig = $state<{
		name: string;
		image: string;
		command: string;
		restartPolicy: string;
		networkMode: string;
		portMappings: typeof portMappings;
		volumeMappings: typeof volumeMappings;
		envVars: typeof envVars;
		labels: typeof labels;
		selectedNetworks: string[];
		// Advanced options
		containerUser: string;
		privilegedMode: boolean;
		healthcheckEnabled: boolean;
		healthcheckCommand: string;
		healthcheckInterval: number;
		healthcheckTimeout: number;
		healthcheckRetries: number;
		healthcheckStartPeriod: number;
		memoryLimit: string;
		memoryReservation: string;
		cpuShares: string;
		nanoCpus: string;
		cpuQuota: string;
		cpuPeriod: string;
		capAdd: string[];
		capDrop: string[];
		securityOptions: string[];
		deviceMappings: typeof deviceMappings;
		dnsServers: string[];
		dnsSearch: string[];
		dnsOptions: string[];
		ulimits: typeof ulimits;
		gpuEnabled: boolean;
		gpuMode: 'all' | 'count' | 'specific';
		gpuCount: number;
		gpuDeviceIds: string[];
		gpuDriver: string;
		gpuCapabilities: string[];
		runtime: string;
	} | null>(null);

	// Compose container detection
	let isComposeContainer = $state(false);
	let composeStackName = $state('');


	let originalAutoUpdate = $state<{
		enabled: boolean;
		cronExpression: string;
		vulnerabilityCriteria: string;
	} | null>(null);

	let loading = $state(false);
	let loadingData = $state(true);
	let error = $state('');
	let abortController: AbortController | null = null;
	let statusMessage = $state('');
	let visible = $state(false);

	// Field-specific errors for inline validation
	let errors = $state<{ name?: string; image?: string }>({});

	// Inline rename state (for title bar)
	let isEditingTitle = $state(false);
	let editTitleName = $state('');
	let renamingTitle = $state(false);

	async function fetchNetworks() {
		try {
			const envParam = currentEnvId ? `?env=${currentEnvId}` : '';
			const response = await fetch(`/api/networks${envParam}`);
			if (response.ok) {
				availableNetworks = await response.json();
			}
		} catch (err) {
			console.error('Failed to fetch networks:', err);
		}
	}

	// Inline title rename functions
	let titleInputRef: HTMLInputElement | null = null;

	function startEditingTitle() {
		editTitleName = name;
		isEditingTitle = true;
		setTimeout(() => {
			titleInputRef?.focus();
			titleInputRef?.select();
		}, 0);
	}

	function cancelEditingTitle() {
		isEditingTitle = false;
		editTitleName = '';
	}

	function saveEditingTitle() {
		if (!editTitleName.trim() || editTitleName === name) {
			cancelEditingTitle();
			return;
		}
		name = editTitleName.trim();
		isEditingTitle = false;
	}

	async function checkScannerSettings() {
		if (!currentEnvId) {
			return;
		}
		try {
			const response = await fetch(`/api/settings/scanner?env=${currentEnvId}&settingsOnly=true`);
			if (response.ok) {
				const data = await response.json();
				const settings = data.settings || data;
			}
		} catch (err) {
			console.error('Failed to check scanner settings:', err);
		}
	}

	async function fetchAutoUpdateSettings(containerName: string) {
		try {
			const envParam = currentEnvId ? `?env=${currentEnvId}` : '';
			const [autoUpdateResponse] = await Promise.all([
				fetch(`/api/auto-update/${encodeURIComponent(containerName)}${envParam}`),
				checkScannerSettings()
			]);
			if (autoUpdateResponse.ok) {
				const data = await autoUpdateResponse.json();
				autoUpdateEnabled = data.enabled || false;
				autoUpdateCronExpression = data.cronExpression || '0 3 * * *';
				vulnerabilityCriteria = data.vulnerabilityCriteria || 'never';
				originalAutoUpdate = {
					enabled: autoUpdateEnabled,
					cronExpression: autoUpdateCronExpression,
					vulnerabilityCriteria: vulnerabilityCriteria
				};
			}
		} catch (err) {
			console.error('Failed to fetch auto-update settings:', err);
		}
	}

	async function saveAutoUpdateSettings(containerName: string) {
		try {
			const envParam = currentEnvId ? `?env=${currentEnvId}` : '';
			await fetch(`/api/auto-update/${encodeURIComponent(containerName)}${envParam}`, {
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

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + sizes[i];
	}

	async function loadContainerData() {
		loadingData = true;
		try {
			const response = await fetch(appendEnvParam(`/api/containers/${containerId}`, $currentEnvironment?.id));
			const data = await response.json();

			if (!response.ok || data.error) {
				throw new Error(data.error || `Failed to fetch container: ${response.status}`);
			}

			// Parse basic container data
			name = data.Name.replace(/^\//, '');
			image = data.Config.Image;
			command = data.Config.Cmd ? data.Config.Cmd.map((arg: string) =>
				arg.includes(' ') ? `"${arg}"` : arg
			).join(' ') : '';
			restartPolicy = data.HostConfig.RestartPolicy?.Name || 'no';
			restartMaxRetries = data.HostConfig.RestartPolicy?.MaximumRetryCount ?? '';

			// Normalize network mode
			const rawNetworkMode = data.HostConfig.NetworkMode || 'bridge';
			if (['bridge', 'host', 'none', 'default'].includes(rawNetworkMode)) {
				networkMode = rawNetworkMode === 'default' ? 'bridge' : rawNetworkMode;
			} else {
				networkMode = 'bridge';
			}

			// Parse port mappings
			const ports = data.HostConfig.PortBindings || {};
			portMappings = Object.keys(ports).length > 0
				? Object.entries(ports).map(([containerPort, bindings]: [string, any]) => {
						const [port, protocol] = containerPort.split('/');
						return {
							containerPort: port,
							hostPort: bindings[0]?.HostPort || '',
							protocol: protocol || 'tcp'
						};
				  })
				: [{ hostPort: '', containerPort: '', protocol: 'tcp' }];

			// Parse volume mappings
			const binds = data.HostConfig.Binds || [];
			volumeMappings = binds.length > 0
				? binds.map((bind: string) => {
						const [hostPath, containerPath, mode] = bind.split(':');
						return {
							hostPath,
							containerPath,
							mode: mode || 'rw'
						};
				  })
				: [{ hostPath: '', containerPath: '', mode: 'rw' }];

			// Parse environment variables
			const env = data.Config.Env || [];
			envVars = env.length > 0
				? env
						.filter((e: string) => !e.startsWith('PATH='))
						.map((e: string) => {
							const [key, ...valueParts] = e.split('=');
							return { key, value: valueParts.join('=') };
						})
				: [{ key: '', value: '' }];

			// Parse labels - filter out com.docker.* labels for UI (they're preserved automatically by updateContainer)
			const containerLabels = data.Config.Labels || {};
			const labelEntries = Object.entries(containerLabels).filter(
				([key]) => !key.startsWith('com.docker.')
			);
			labels = labelEntries.length > 0
				? labelEntries.map(([key, value]) => ({ key, value: String(value) }))
				: [{ key: '', value: '' }];

			// Detect if container belongs to a compose stack
			const composeProject = containerLabels['com.docker.compose.project'];
			if (composeProject) {
				isComposeContainer = true;
				composeStackName = composeProject;
			} else {
				isComposeContainer = false;
				composeStackName = '';
			}

			// Parse connected networks
			const networks = data.NetworkSettings?.Networks || {};
			selectedNetworks = Object.keys(networks);

			// Parse advanced options - User
			containerUser = data.Config.User || '';

			// Parse advanced options - Privileged
			privilegedMode = data.HostConfig.Privileged || false;

			// Parse advanced options - Healthcheck
			const healthcheck = data.Config.Healthcheck;
			if (healthcheck && healthcheck.Test && healthcheck.Test.length > 0) {
				healthcheckEnabled = true;
				// Extract command from Test array (first element is usually CMD-SHELL or CMD)
				if (healthcheck.Test[0] === 'CMD-SHELL') {
					healthcheckCommand = healthcheck.Test.slice(1).join(' ');
				} else if (healthcheck.Test[0] === 'CMD') {
					healthcheckCommand = healthcheck.Test.slice(1).join(' ');
				} else if (healthcheck.Test[0] === 'NONE') {
					healthcheckEnabled = false;
				} else {
					healthcheckCommand = healthcheck.Test.join(' ');
				}
				healthcheckInterval = Math.floor((healthcheck.Interval || 30e9) / 1e9);
				healthcheckTimeout = Math.floor((healthcheck.Timeout || 30e9) / 1e9);
				healthcheckRetries = healthcheck.Retries || 3;
				healthcheckStartPeriod = Math.floor((healthcheck.StartPeriod || 0) / 1e9);
			}

			// Parse advanced options - Resources
			if (data.HostConfig.Memory) {
				memoryLimit = formatBytes(data.HostConfig.Memory);
			}
			if (data.HostConfig.MemoryReservation) {
				memoryReservation = formatBytes(data.HostConfig.MemoryReservation);
			}
			if (data.HostConfig.CpuShares && data.HostConfig.CpuShares !== 0) {
				cpuShares = String(data.HostConfig.CpuShares);
			}
			if (data.HostConfig.NanoCpus) {
				nanoCpus = String(data.HostConfig.NanoCpus / 1e9);
			}
			if (data.HostConfig.CpuQuota) {
				cpuQuota = String(data.HostConfig.CpuQuota);
			}
			if (data.HostConfig.CpuPeriod) {
				cpuPeriod = String(data.HostConfig.CpuPeriod);
			}

			// Parse advanced options - Capabilities
			capAdd = data.HostConfig.CapAdd || [];
			capDrop = data.HostConfig.CapDrop || [];

			// Parse advanced options - Devices
			const devices = data.HostConfig.Devices || [];
			deviceMappings = devices.map((d: any) => ({
				hostPath: d.PathOnHost || '',
				containerPath: d.PathInContainer || '',
				permissions: d.CgroupPermissions || 'rwm'
			}));

			// Parse advanced options - DNS
			dnsServers = data.HostConfig.Dns || [];
			dnsSearch = data.HostConfig.DnsSearch || [];
			dnsOptions = data.HostConfig.DnsOptions || [];

			// Parse advanced options - Security options
			securityOptions = data.HostConfig.SecurityOpt || [];

			// Parse advanced options - Ulimits
			const ulimitsList = data.HostConfig.Ulimits || [];
			ulimits = ulimitsList.map((u: any) => ({
				name: u.Name || '',
				soft: String(u.Soft || 0),
				hard: String(u.Hard || 0)
			}));

			// Parse GPU / Device Requests
			const deviceReqs = data.HostConfig?.DeviceRequests || [];
			if (deviceReqs.length > 0) {
				gpuEnabled = true;
				const firstReq = deviceReqs[0];
				if (firstReq.DeviceIDs?.length > 0) {
					gpuMode = 'specific';
					gpuDeviceIds = [...firstReq.DeviceIDs];
				} else if (firstReq.Count === -1) {
					gpuMode = 'all';
				} else {
					gpuMode = 'count';
					gpuCount = firstReq.Count || 1;
				}
				gpuCapabilities = firstReq.Capabilities?.length > 0
					? firstReq.Capabilities.flat() : ['gpu'];
				gpuDriver = firstReq.Driver || '';
			} else {
				gpuEnabled = false;
				gpuMode = 'all';
				gpuCount = 1;
				gpuDeviceIds = [];
				gpuDriver = '';
				gpuCapabilities = ['gpu'];
			}

			// Parse runtime
			runtime = (data.HostConfig?.Runtime && data.HostConfig.Runtime !== 'runc')
				? data.HostConfig.Runtime : '';

			// Fetch available networks and auto-update settings
			await fetchNetworks();
			await fetchAutoUpdateSettings(name);

			// Store original config for change detection
			originalConfig = {
				name,
				image,
				command,
				restartPolicy,
				networkMode,
				portMappings: JSON.parse(JSON.stringify(portMappings)),
				volumeMappings: JSON.parse(JSON.stringify(volumeMappings)),
				envVars: JSON.parse(JSON.stringify(envVars)),
				labels: JSON.parse(JSON.stringify(labels)),
				selectedNetworks: [...selectedNetworks],
				// Advanced options
				containerUser,
				privilegedMode,
				healthcheckEnabled,
				healthcheckCommand,
				healthcheckInterval,
				healthcheckTimeout,
				healthcheckRetries,
				healthcheckStartPeriod,
				memoryLimit,
				memoryReservation,
				cpuShares,
				nanoCpus,
				cpuQuota,
				cpuPeriod,
				capAdd: [...capAdd],
				capDrop: [...capDrop],
				securityOptions: [...securityOptions],
				deviceMappings: JSON.parse(JSON.stringify(deviceMappings)),
				dnsServers: [...dnsServers],
				dnsSearch: [...dnsSearch],
				dnsOptions: [...dnsOptions],
				ulimits: JSON.parse(JSON.stringify(ulimits)),
				gpuEnabled,
				gpuMode,
				gpuCount,
				gpuDeviceIds: [...gpuDeviceIds],
				gpuDriver,
				gpuCapabilities: [...gpuCapabilities],
				runtime
			};
		} catch (err) {
			error = 'Failed to load container data: ' + String(err);
		} finally {
			loadingData = false;
			requestAnimationFrame(() => {
				visible = true;
				focusFirstInput();
			});
		}
	}

	// Check if container configuration has changed
	function hasContainerConfigChanged(): boolean {
		if (!originalConfig) return true;

		// Basic options
		if (name.trim() !== originalConfig.name) return true;
		if (image.trim() !== originalConfig.image) return true;
		if (command.trim() !== originalConfig.command) return true;
		if (restartPolicy !== originalConfig.restartPolicy) return true;
		if (networkMode !== originalConfig.networkMode) return true;

		const currentPorts = portMappings.filter(p => p.containerPort && p.hostPort);
		const originalPorts = originalConfig.portMappings.filter(p => p.containerPort && p.hostPort);
		if (JSON.stringify(currentPorts) !== JSON.stringify(originalPorts)) return true;

		const currentVolumes = volumeMappings.filter(v => v.hostPath && v.containerPath);
		const originalVolumes = originalConfig.volumeMappings.filter(v => v.hostPath && v.containerPath);
		if (JSON.stringify(currentVolumes) !== JSON.stringify(originalVolumes)) return true;

		const currentEnvs = envVars.filter(e => e.key);
		const originalEnvs = originalConfig.envVars.filter(e => e.key);
		if (JSON.stringify(currentEnvs) !== JSON.stringify(originalEnvs)) return true;

		const currentLabels = labels.filter(l => l.key);
		const originalLabels = originalConfig.labels.filter(l => l.key);
		if (JSON.stringify(currentLabels) !== JSON.stringify(originalLabels)) return true;

		if (JSON.stringify([...selectedNetworks].sort()) !== JSON.stringify([...originalConfig.selectedNetworks].sort())) return true;

		// Advanced options - User & Security
		if (containerUser !== originalConfig.containerUser) return true;
		if (privilegedMode !== originalConfig.privilegedMode) return true;
		if (JSON.stringify([...capAdd].sort()) !== JSON.stringify([...originalConfig.capAdd].sort())) return true;
		if (JSON.stringify([...capDrop].sort()) !== JSON.stringify([...originalConfig.capDrop].sort())) return true;
		if (JSON.stringify([...securityOptions].sort()) !== JSON.stringify([...originalConfig.securityOptions].sort())) return true;

		// Advanced options - Healthcheck
		if (healthcheckEnabled !== originalConfig.healthcheckEnabled) return true;
		if (healthcheckCommand !== originalConfig.healthcheckCommand) return true;
		if (healthcheckInterval !== originalConfig.healthcheckInterval) return true;
		if (healthcheckTimeout !== originalConfig.healthcheckTimeout) return true;
		if (healthcheckRetries !== originalConfig.healthcheckRetries) return true;
		if (healthcheckStartPeriod !== originalConfig.healthcheckStartPeriod) return true;

		// Advanced options - Resources
		if (memoryLimit !== originalConfig.memoryLimit) return true;
		if (memoryReservation !== originalConfig.memoryReservation) return true;
		if (cpuShares !== originalConfig.cpuShares) return true;
		if (nanoCpus !== originalConfig.nanoCpus) return true;
		if (cpuQuota !== originalConfig.cpuQuota) return true;
		if (cpuPeriod !== originalConfig.cpuPeriod) return true;

		// Advanced options - Devices
		const currentDevices = deviceMappings.filter(d => d.hostPath && d.containerPath);
		const originalDevices = originalConfig.deviceMappings.filter(d => d.hostPath && d.containerPath);
		if (JSON.stringify(currentDevices) !== JSON.stringify(originalDevices)) return true;

		// Advanced options - DNS
		if (JSON.stringify([...dnsServers]) !== JSON.stringify([...originalConfig.dnsServers])) return true;
		if (JSON.stringify([...dnsSearch]) !== JSON.stringify([...originalConfig.dnsSearch])) return true;
		if (JSON.stringify([...dnsOptions]) !== JSON.stringify([...originalConfig.dnsOptions])) return true;

		// Advanced options - Ulimits
		const currentUlimits = ulimits.filter(u => u.name && u.soft && u.hard);
		const originalUlimits = originalConfig.ulimits.filter(u => u.name && u.soft && u.hard);
		if (JSON.stringify(currentUlimits) !== JSON.stringify(originalUlimits)) return true;

		// GPU settings
		if (gpuEnabled !== originalConfig.gpuEnabled) return true;
		if (gpuMode !== originalConfig.gpuMode) return true;
		if (gpuCount !== originalConfig.gpuCount) return true;
		if (JSON.stringify([...gpuDeviceIds].sort()) !== JSON.stringify([...originalConfig.gpuDeviceIds].sort())) return true;
		if (gpuDriver !== originalConfig.gpuDriver) return true;
		if (JSON.stringify([...gpuCapabilities].sort()) !== JSON.stringify([...originalConfig.gpuCapabilities].sort())) return true;
		if (runtime !== originalConfig.runtime) return true;

		return false;
	}

	function hasAutoUpdateChanged(): boolean {
		if (!originalAutoUpdate) return true;
		return (
			autoUpdateEnabled !== originalAutoUpdate.enabled ||
			autoUpdateCronExpression !== originalAutoUpdate.cronExpression ||
			vulnerabilityCriteria !== originalAutoUpdate.vulnerabilityCriteria
		);
	}

	function serializeConfigWithoutName() {
		return JSON.stringify({
			image: image.trim(),
			command: command.trim(),
			restartPolicy,
			networkMode,
			portMappings: portMappings.filter(p => p.containerPort && p.hostPort),
			volumeMappings: volumeMappings.filter(v => v.hostPath && v.containerPath),
			envVars: envVars.filter(e => e.key),
			labels: labels.filter(l => l.key),
			selectedNetworks: [...selectedNetworks].sort()
		});
	}

	function serializeOriginalConfigWithoutName() {
		if (!originalConfig) return null;
		return JSON.stringify({
			image: originalConfig.image,
			command: originalConfig.command,
			restartPolicy: originalConfig.restartPolicy,
			networkMode: originalConfig.networkMode,
			portMappings: originalConfig.portMappings.filter(p => p.containerPort && p.hostPort),
			volumeMappings: originalConfig.volumeMappings.filter(v => v.hostPath && v.containerPath),
			envVars: originalConfig.envVars.filter(e => e.key),
			labels: originalConfig.labels.filter(l => l.key),
			selectedNetworks: [...originalConfig.selectedNetworks].sort()
		});
	}

	function hasOnlyNameChanged(): boolean {
		if (!originalConfig) return false;
		if (name.trim() === originalConfig.name) return false;
		return serializeConfigWithoutName() === serializeOriginalConfigWithoutName();
	}

	function hasConfigChangedBesidesName(): boolean {
		if (!originalConfig) return false;
		return serializeConfigWithoutName() !== serializeOriginalConfigWithoutName();
	}

	let showComposeRenameWarning = $derived(isComposeContainer && hasOnlyNameChanged());
	let showComposeConfigWarning = $derived(isComposeContainer && hasConfigChangedBesidesName());

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
		error = '';
		errors = {};
		statusMessage = '';

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
		abortController = new AbortController();
		const signal = abortController.signal;

		const containerConfigChanged = hasContainerConfigChanged();
		const autoUpdateChanged = hasAutoUpdateChanged();

		if (!containerConfigChanged && !autoUpdateChanged) {
			onClose();
			loading = false;
			return;
		}

		try {
			// If only name changed, use the rename endpoint
			if (hasOnlyNameChanged()) {
				statusMessage = 'Renaming container...';

				const response = await fetch(appendEnvParam(
					`/api/containers/${containerId}/rename`,
					$currentEnvironment?.id
				), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: name.trim() }),
					signal
				});

				const result = await response.json();

				if (!response.ok) {
					error = result.error || 'Failed to rename container';
					loading = false;
					return;
				}

				statusMessage = 'Container renamed successfully!';

				if (autoUpdateChanged) {
					await saveAutoUpdateSettings(name.trim());
				}

				await new Promise(resolve => setTimeout(resolve, 500));
				onSuccess();
				onClose();
				loading = false;
				return;
			}

			// Full update required - recreate container
			if (containerConfigChanged) {
				statusMessage = 'Updating container...';

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
					startAfterUpdate,
					repullImage,
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

				const response = await fetch(appendEnvParam(`/api/containers/${containerId}/update`, $currentEnvironment?.id), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
					signal
				});

				const result = await response.json();

				if (!response.ok) {
					error = result.error || 'Failed to update container';
					if (result.details) {
						error += ': ' + result.details;
					}
					return;
				}

				statusMessage = 'Container updated successfully!';
			}

			if (autoUpdateChanged) {
				if (!containerConfigChanged) {
					statusMessage = 'Saving auto-update settings...';
				}
				await saveAutoUpdateSettings(name.trim());
				if (!containerConfigChanged) {
					statusMessage = 'Auto-update settings saved!';
				}
			}

			await new Promise(resolve => setTimeout(resolve, 500));

			onSuccess();
			onClose();
		} catch (err) {
			if (signal.aborted) return;
			error = 'Failed to update container: ' + String(err);
		} finally {
			loading = false;
			abortController = null;
		}
	}

	function handleClose() {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
		loading = false;
		onClose();
	}

	$effect(() => {
		if (open && containerId && !hasLoadedData) {
			visible = false;
			loadingData = true;
			name = ''; // Reset to prevent showing stale name in header
			statusMessage = '';
			error = '';
			hasLoadedData = true;
			loadContainerData();
			fetchConfigSets();
			selectedConfigSetId = '';
		} else if (!open) {
			loadingData = true;
			visible = false;
			hasLoadedData = false;
		}
	});
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => isOpen && focusFirstInput()}>
	<Dialog.Content class="max-w-4xl w-full max-h-[90vh] p-0 flex flex-col overflow-hidden sm:max-h-[85vh]">
		<Dialog.Header class="px-5 py-4 border-b bg-muted/30 shrink-0 sticky top-0 z-10">
			<Dialog.Title class="text-base font-semibold flex items-center gap-1">
				Edit container
				{#if isEditingTitle}
					<span class="ml-1">-</span>
					<input
						type="text"
						bind:value={editTitleName}
						bind:this={titleInputRef}
						class="text-muted-foreground font-normal bg-muted border border-input rounded px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
						onkeydown={(e) => {
							if (e.key === 'Enter') saveEditingTitle();
							if (e.key === 'Escape') cancelEditingTitle();
						}}
					/>
					<button
						type="button"
						onclick={saveEditingTitle}
						title="Save"
						class="p-0.5 rounded hover:bg-muted transition-colors"
					>
						<Check class="w-3 h-3 text-green-500 hover:text-green-600" />
					</button>
					<button
						type="button"
						onclick={cancelEditingTitle}
						title="Cancel"
						class="p-0.5 rounded hover:bg-muted transition-colors"
					>
						<X class="w-3 h-3 text-muted-foreground hover:text-foreground" />
					</button>
				{:else if name}
					<span class="font-normal text-muted-foreground ml-1">- {name}</span>
					<button
						type="button"
						onclick={startEditingTitle}
						title="Rename container"
						class="p-0.5 rounded hover:bg-muted transition-colors ml-0.5"
					>
						<Pencil class="w-3 h-3 text-muted-foreground hover:text-foreground" />
					</button>
				{/if}
			</Dialog.Title>
		</Dialog.Header>

		{#if loadingData}
			<div class="flex-1 flex items-center justify-center text-muted-foreground text-sm min-h-[200px]">
				<Loader2 class="w-5 h-5 animate-spin mr-2" />
				Loading container data...
			</div>
		{:else}
			<div class="px-5 py-4 flex-1 overflow-y-auto">
				<!-- Compose warning banners -->
				{#if showComposeRenameWarning}
					<div class="mb-4 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-100/50 dark:bg-amber-900/30 rounded-md flex items-start gap-2">
						<Layers class="w-4 h-4 shrink-0 mt-0.5" />
						<span>This container is part of the <strong>{composeStackName}</strong> compose stack. Renaming it may cause issues with stack management.</span>
					</div>
				{/if}
				{#if showComposeConfigWarning}
					<div class="mb-4 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-100/50 dark:bg-amber-900/30 rounded-md flex items-start gap-2">
						<Layers class="w-4 h-4 shrink-0 mt-0.5" />
						<span>This container is part of the <strong>{composeStackName}</strong> compose stack. Changes may be overwritten when the stack is redeployed.</span>
					</div>
				{/if}

				<ContainerSettingsTab
					mode="edit"
					bind:name
					bind:image
					bind:command
					bind:restartPolicy
					bind:restartMaxRetries
					bind:networkMode
					startAfterCreate={startAfterUpdate}
					{repullImage}
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
				/>

				{#if statusMessage}
					<div class="mt-4 px-3 py-2 text-xs text-primary bg-primary/10 rounded-md">
						{statusMessage}
					</div>
				{/if}

				{#if error}
					<div class="mt-4 px-3 py-2 text-xs text-destructive bg-destructive/10 rounded-md">
						{error}
					</div>
				{/if}
			</div>

			<div class="flex justify-end gap-2 px-5 py-3 border-t bg-muted/30 shrink-0">
				<Button type="button" variant="outline" onclick={handleClose} size="sm">
					Cancel
				</Button>
				<Button type="button" variant="secondary" disabled={loading} size="sm" onclick={handleSubmit}>
					{#if loading}
						<Loader2 class="w-4 h-4 mr-1 animate-spin" />
						Updating...
					{:else}
						Update container
					{/if}
				</Button>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
