<script lang="ts" module>
	// Static data moved outside component to prevent recreation on each mount
	const NETWORK_DRIVERS = [
		{ value: 'bridge', label: 'Bridge', description: 'Default network driver' },
		{ value: 'host', label: 'Host', description: 'Use host networking directly' },
		{ value: 'overlay', label: 'Overlay', description: 'Swarm multi-host networking' },
		{ value: 'macvlan', label: 'Macvlan', description: 'Assign MAC address to containers' },
		{ value: 'ipvlan', label: 'IPvlan', description: 'IPvlan L2/L3 networking' },
		{ value: 'none', label: 'None', description: 'Disable networking' }
	] as const;

	const COMMON_DRIVER_OPTIONS: Record<string, { key: string; description: string }[]> = {
		bridge: [
			{ key: 'com.docker.network.bridge.name', description: 'Bridge device name' },
			{ key: 'com.docker.network.bridge.enable_ip_masquerade', description: 'Enable IP masquerading (true/false)' },
			{ key: 'com.docker.network.bridge.enable_icc', description: 'Enable inter-container communication (true/false)' },
			{ key: 'com.docker.network.bridge.host_binding_ipv4', description: 'Host binding IPv4 address' },
			{ key: 'com.docker.network.driver.mtu', description: 'MTU size' }
		],
		macvlan: [
			{ key: 'parent', description: 'Parent interface (e.g., eth0)' },
			{ key: 'macvlan_mode', description: 'Mode: bridge, private, vepa, passthru' }
		],
		ipvlan: [
			{ key: 'parent', description: 'Parent interface (e.g., eth0)' },
			{ key: 'ipvlan_mode', description: 'Mode: l2, l3, l3s' },
			{ key: 'ipvlan_flag', description: 'Flag: bridge, private, vepa' }
		],
		overlay: [
			{ key: 'encrypted', description: 'Enable encryption (true/false)' }
		]
	};

	type KeyValue = { key: string; value: string };
</script>

<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Plus, Trash2, Network, Settings, Tag, Layers, MonitorSmartphone, Share2, Cpu, Server, CircleOff, Globe, TriangleAlert } from 'lucide-svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { focusFirstInput } from '$lib/utils';

	interface Props {
		open: boolean;
		onClose?: () => void;
		onSuccess?: () => void;
	}

	let { open = $bindable(), onClose, onSuccess }: Props = $props();

	// Form state
	let name = $state('');
	let driver = $state('bridge');
	let internal = $state(false);
	let attachable = $state(true);
	let enableIPv6 = $state(false);

	// IPAM configuration
	let ipamDriver = $state('default');
	let subnet = $state('');
	let gateway = $state('');
	let ipRange = $state('');
	let auxAddresses = $state<KeyValue[]>([]);

	// Driver options
	let driverOptions = $state<KeyValue[]>([]);

	// IPAM options
	let ipamOptions = $state<KeyValue[]>([]);

	// Macvlan/IPvlan quick config
	let parentInterface = $state('');
	let macvlanMode = $state('bridge');
	let ipvlanMode = $state('l2');

	// Check if driver requires special config
	let needsParentConfig = $derived(driver === 'macvlan' || driver === 'ipvlan');

	// Labels
	let labels = $state<KeyValue[]>([]);

	let creating = $state(false);
	let error = $state('');
	let errors = $state<{ name?: string; parentInterface?: string; subnet?: string }>({});

	// Generic list helpers to reduce repetitive code
	function addItem(list: KeyValue[]): KeyValue[] {
		return [...list, { key: '', value: '' }];
	}

	function removeItem(list: KeyValue[], index: number): KeyValue[] {
		return list.filter((_, i) => i !== index);
	}

	function resetForm() {
		name = '';
		driver = 'bridge';
		internal = false;
		attachable = true;
		enableIPv6 = false;
		ipamDriver = 'default';
		subnet = '';
		gateway = '';
		ipRange = '';
		auxAddresses = [];
		driverOptions = [];
		ipamOptions = [];
		labels = [];
		parentInterface = '';
		macvlanMode = 'bridge';
		ipvlanMode = 'l2';
		error = '';
		errors = {};
	}

	async function handleSubmit() {
		errors = {};
		let hasErrors = false;

		if (!name.trim()) {
			errors.name = 'Network name is required';
			hasErrors = true;
		}

		// Validation for macvlan/ipvlan
		if (needsParentConfig) {
			if (!parentInterface.trim()) {
				errors.parentInterface = `Parent interface is required for ${driver} networks`;
				hasErrors = true;
			}
			if (!subnet.trim()) {
				errors.subnet = `Subnet is required for ${driver} networks`;
				hasErrors = true;
			}
		}

		if (hasErrors) return;

		creating = true;
		error = '';

		try {
			const envId = $currentEnvironment?.id;
			const payload: Record<string, unknown> = {
				name: name.trim(),
				driver,
				internal,
				attachable,
				enableIPv6
			};

			// Build driver options - start with quick config for macvlan/ipvlan
			const allDriverOptions: Record<string, string> = {};

			if (driver === 'macvlan' && parentInterface.trim()) {
				allDriverOptions['parent'] = parentInterface.trim();
				if (macvlanMode) allDriverOptions['macvlan_mode'] = macvlanMode;
			} else if (driver === 'ipvlan' && parentInterface.trim()) {
				allDriverOptions['parent'] = parentInterface.trim();
				if (ipvlanMode) allDriverOptions['ipvlan_mode'] = ipvlanMode;
			}

			// Add any additional driver options (optimized single iteration)
			for (const opt of driverOptions) {
				if (opt.key.trim()) {
					allDriverOptions[opt.key] = opt.value;
				}
			}

			if (Object.keys(allDriverOptions).length > 0) {
				payload.options = allDriverOptions;
			}

			// Build labels
			if (labels.length > 0) {
				const labelsObj: Record<string, string> = {};
				for (const l of labels) {
					if (l.key.trim()) {
						labelsObj[l.key] = l.value;
					}
				}
				if (Object.keys(labelsObj).length > 0) {
					payload.labels = labelsObj;
				}
			}

			// Build IPAM config
			if (subnet.trim() || gateway.trim() || ipRange.trim() || auxAddresses.length > 0 || ipamDriver !== 'default' || ipamOptions.length > 0) {
				const ipamConfig: Record<string, unknown> = {};
				if (subnet.trim()) ipamConfig.subnet = subnet.trim();
				if (gateway.trim()) ipamConfig.gateway = gateway.trim();
				if (ipRange.trim()) ipamConfig.ipRange = ipRange.trim();
				if (auxAddresses.length > 0) {
					const auxObj: Record<string, string> = {};
					for (const a of auxAddresses) {
						if (a.key.trim()) {
							auxObj[a.key] = a.value;
						}
					}
					if (Object.keys(auxObj).length > 0) {
						ipamConfig.auxAddress = auxObj;
					}
				}

				const ipamOpts: Record<string, string> = {};
				for (const opt of ipamOptions) {
					if (opt.key.trim()) {
						ipamOpts[opt.key] = opt.value;
					}
				}

				payload.ipam = {
					driver: ipamDriver,
					config: Object.keys(ipamConfig).length > 0 ? [ipamConfig] : [],
					options: ipamOpts
				};
			}

			const response = await fetch(appendEnvParam('/api/networks', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.details || data.error || 'Failed to create network');
			}

			resetForm();
			open = false;
			onSuccess?.();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create network';
		} finally {
			creating = false;
		}
	}

	function handleClose() {
		resetForm();
		onClose?.();
	}
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (isOpen) focusFirstInput(); else handleClose(); }}>
	<Dialog.Content class="max-w-3xl max-h-[90vh] overflow-y-auto">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Network class="w-5 h-5" />
				Create network
			</Dialog.Title>
			<Dialog.Description>Configure a new Docker network with custom settings.</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root value="basic" class="mt-4">
			<Tabs.List class="grid w-full grid-cols-4">
				<Tabs.Trigger value="basic" class="flex items-center gap-1.5 text-xs">
					<Network class="w-3.5 h-3.5" />Basic
				</Tabs.Trigger>
				<Tabs.Trigger value="ipam" class="flex items-center gap-1.5 text-xs">
					<Settings class="w-3.5 h-3.5" />IPAM
				</Tabs.Trigger>
				<Tabs.Trigger value="options" class="flex items-center gap-1.5 text-xs">
					<Settings class="w-3.5 h-3.5" />Options
				</Tabs.Trigger>
				<Tabs.Trigger value="labels" class="flex items-center gap-1.5 text-xs">
					<Tag class="w-3.5 h-3.5" />Labels
				</Tabs.Trigger>
			</Tabs.List>

			<div class="min-h-[200px] sm:min-h-[300px] mt-4">
				<!-- Basic Tab -->
				<Tabs.Content value="basic" class="space-y-4 h-full overflow-y-auto">
				<div class="space-y-2">
					<Label for="name">Network name *</Label>
					<Input
						id="name"
						bind:value={name}
						placeholder="my-network"
						class={errors.name ? 'border-destructive focus-visible:ring-destructive' : ''}
						oninput={() => errors.name = undefined}
					/>
					{#if errors.name}
						<p class="text-xs text-destructive">{errors.name}</p>
					{/if}
				</div>

				<div class="space-y-2">
					<Label for="driver">Driver</Label>
					<Select.Root type="single" bind:value={driver}>
						<Select.Trigger class="w-full h-9">
							<span class="flex items-center">
								{#if driver === 'bridge'}
									<Share2 class="w-4 h-4 mr-2 text-emerald-500" />
								{:else if driver === 'host'}
									<Server class="w-4 h-4 mr-2 text-sky-500" />
								{:else if driver === 'overlay'}
									<Globe class="w-4 h-4 mr-2 text-violet-500" />
								{:else if driver === 'macvlan'}
									<MonitorSmartphone class="w-4 h-4 mr-2 text-amber-500" />
								{:else if driver === 'ipvlan'}
									<Cpu class="w-4 h-4 mr-2 text-orange-500" />
								{:else}
									<CircleOff class="w-4 h-4 mr-2 text-muted-foreground" />
								{/if}
								{NETWORK_DRIVERS.find(d => d.value === driver)?.label || 'Select driver'}
							</span>
						</Select.Trigger>
						<Select.Content>
							{#each NETWORK_DRIVERS as d}
								<Select.Item value={d.value} label={d.label}>
									{#snippet children()}
										<div class="flex items-center">
											{#if d.value === 'bridge'}
												<Share2 class="w-4 h-4 mr-2 text-emerald-500" />
											{:else if d.value === 'host'}
												<Server class="w-4 h-4 mr-2 text-sky-500" />
											{:else if d.value === 'overlay'}
												<Globe class="w-4 h-4 mr-2 text-violet-500" />
											{:else if d.value === 'macvlan'}
												<MonitorSmartphone class="w-4 h-4 mr-2 text-amber-500" />
											{:else if d.value === 'ipvlan'}
												<Cpu class="w-4 h-4 mr-2 text-orange-500" />
											{:else}
												<CircleOff class="w-4 h-4 mr-2 text-muted-foreground" />
											{/if}
											<div class="flex flex-col">
												<span>{d.label}</span>
												<span class="text-xs text-muted-foreground">{d.description}</span>
											</div>
										</div>
									{/snippet}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				{#if needsParentConfig}
					<div class="bg-amber-500/10 border border-amber-500/20 rounded-md p-3 space-y-3">
						<p class="text-xs font-medium text-amber-600 dark:text-amber-400">
							{driver === 'macvlan' ? 'Macvlan' : 'IPvlan'} configuration (required)
						</p>
						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-1">
								<Label for="parentInterface" class="text-xs">Parent interface *</Label>
								<Input
									id="parentInterface"
									bind:value={parentInterface}
									placeholder="eth0"
									class="h-8 {errors.parentInterface ? 'border-destructive focus-visible:ring-destructive' : ''}"
									oninput={() => errors.parentInterface = undefined}
								/>
								{#if errors.parentInterface}
									<p class="text-xs text-destructive">{errors.parentInterface}</p>
								{/if}
							</div>
							{#if driver === 'macvlan'}
								<div class="space-y-1">
									<Label for="macvlanMode" class="text-xs">Mode</Label>
									<Select.Root type="single" bind:value={macvlanMode}>
										<Select.Trigger class="h-8 text-xs">
											<Layers class="w-3 h-3 mr-1.5 text-muted-foreground" />
											<span>{macvlanMode === 'bridge' ? 'Bridge (default)' : macvlanMode === 'private' ? 'Private' : macvlanMode === 'vepa' ? 'VEPA' : 'Passthru'}</span>
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="bridge" label="Bridge (default)">
												<Layers class="w-3 h-3 mr-1.5 text-muted-foreground" />Bridge (default)
											</Select.Item>
											<Select.Item value="private" label="Private">
												<Layers class="w-3 h-3 mr-1.5 text-muted-foreground" />Private
											</Select.Item>
											<Select.Item value="vepa" label="VEPA">
												<Layers class="w-3 h-3 mr-1.5 text-muted-foreground" />VEPA
											</Select.Item>
											<Select.Item value="passthru" label="Passthru">
												<Layers class="w-3 h-3 mr-1.5 text-muted-foreground" />Passthru
											</Select.Item>
										</Select.Content>
									</Select.Root>
								</div>
							{:else}
								<div class="space-y-1">
									<Label for="ipvlanMode" class="text-xs">Mode</Label>
									<Select.Root type="single" bind:value={ipvlanMode}>
										<Select.Trigger class="h-8 text-xs">
											<Share2 class="w-3 h-3 mr-1.5 text-muted-foreground" />
											<span>{ipvlanMode === 'l2' ? 'L2 (default)' : ipvlanMode === 'l3' ? 'L3' : 'L3S'}</span>
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="l2" label="L2 (default)">
												<Share2 class="w-3 h-3 mr-1.5 text-muted-foreground" />L2 (default)
											</Select.Item>
											<Select.Item value="l3" label="L3">
												<Share2 class="w-3 h-3 mr-1.5 text-muted-foreground" />L3
											</Select.Item>
											<Select.Item value="l3s" label="L3S">
												<Share2 class="w-3 h-3 mr-1.5 text-muted-foreground" />L3S
											</Select.Item>
										</Select.Content>
									</Select.Root>
								</div>
							{/if}
						</div>
						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-1">
								<Label for="subnetQuick" class="text-xs">Subnet *</Label>
								<Input
									id="subnetQuick"
									bind:value={subnet}
									placeholder="192.168.1.0/24"
									class="h-8 {errors.subnet ? 'border-destructive focus-visible:ring-destructive' : ''}"
									oninput={() => errors.subnet = undefined}
								/>
								{#if errors.subnet}
									<p class="text-xs text-destructive">{errors.subnet}</p>
								{/if}
							</div>
							<div class="space-y-1">
								<Label for="gatewayQuick" class="text-xs">Gateway</Label>
								<Input id="gatewayQuick" bind:value={gateway} placeholder="192.168.1.1" class="h-8" />
							</div>
						</div>
					</div>
				{/if}

				<div class="space-y-3 pt-2">
					<div class="flex items-center gap-3">
						<TogglePill bind:checked={internal} />
						<div>
							<span class="text-sm font-normal">Internal network</span>
							<span class="text-muted-foreground text-xs block">Restrict external access to this network</span>
						</div>
					</div>

					<div class="flex items-center gap-3">
						<TogglePill bind:checked={attachable} />
						<div>
							<span class="text-sm font-normal">Attachable</span>
							<span class="text-muted-foreground text-xs block">Allow manual container attachment (overlay networks)</span>
						</div>
					</div>

					<div class="flex items-center gap-3">
						<TogglePill bind:checked={enableIPv6} />
						<div>
							<span class="text-sm font-normal">Enable IPv6</span>
							<span class="text-muted-foreground text-xs block">Enable IPv6 networking</span>
						</div>
					</div>
				</div>
				</Tabs.Content>

				<!-- IPAM Tab -->
				<Tabs.Content value="ipam" class="space-y-4 h-full overflow-y-auto">
				<div class="space-y-2">
					<Label for="ipamDriver">IPAM driver</Label>
					<Input id="ipamDriver" bind:value={ipamDriver} placeholder="default" />
					<p class="text-xs text-muted-foreground">IP Address Management driver (default: default)</p>
				</div>

				<div class="grid grid-cols-2 gap-4">
					<div class="space-y-2">
						<Label for="subnet">Subnet</Label>
						<Input id="subnet" bind:value={subnet} placeholder="172.20.0.0/16" />
					</div>
					<div class="space-y-2">
						<Label for="gateway">Gateway</Label>
						<Input id="gateway" bind:value={gateway} placeholder="172.20.0.1" />
					</div>
				</div>

				<div class="space-y-2">
					<Label for="ipRange">IP range</Label>
					<Input id="ipRange" bind:value={ipRange} placeholder="172.20.10.0/24" />
					<p class="text-xs text-muted-foreground">Allocate container IPs from a sub-range of the subnet</p>
				</div>

				<!-- Auxiliary Addresses -->
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<Label>Auxiliary addresses</Label>
						<Button variant="outline" size="sm" onclick={() => auxAddresses = addItem(auxAddresses)}>
							<Plus class="w-3 h-3" />Add
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">Reserve IP addresses for network devices (e.g., host=192.168.1.1)</p>
					{#each auxAddresses as aux, i}
						<div class="flex gap-2 items-center">
							<div class="flex-1 relative">
								<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Hostname</span>
								<Input bind:value={aux.key} class="h-9" />
							</div>
							<div class="flex-1 relative">
								<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">IP</span>
								<Input bind:value={aux.value} class="h-9" />
							</div>
							<Button variant="ghost" size="sm" onclick={() => auxAddresses = removeItem(auxAddresses, i)}>
								<Trash2 class="w-4 h-4 text-destructive" />
							</Button>
						</div>
					{/each}
				</div>

				<!-- IPAM Options -->
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<Label>IPAM options</Label>
						<Button variant="outline" size="sm" onclick={() => ipamOptions = addItem(ipamOptions)}>
							<Plus class="w-3 h-3" />Add
						</Button>
					</div>
					{#each ipamOptions as opt, i}
						<div class="flex gap-2 items-center">
							<div class="flex-1 relative">
								<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Key</span>
								<Input bind:value={opt.key} class="h-9" />
							</div>
							<div class="flex-1 relative">
								<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Value</span>
								<Input bind:value={opt.value} class="h-9" />
							</div>
							<Button variant="ghost" size="sm" onclick={() => ipamOptions = removeItem(ipamOptions, i)}>
								<Trash2 class="w-4 h-4 text-destructive" />
							</Button>
						</div>
					{/each}
				</div>
				</Tabs.Content>

				<!-- Options Tab -->
				<Tabs.Content value="options" class="space-y-4 h-full overflow-y-auto">
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<Label>Driver options</Label>
						<Button variant="outline" size="sm" onclick={() => driverOptions = addItem(driverOptions)}>
							<Plus class="w-3 h-3" />Add
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">Set driver-specific options (-o key=value)</p>

					{#if COMMON_DRIVER_OPTIONS[driver]?.length > 0}
						<div class="bg-muted/50 rounded-md p-3 text-xs space-y-1">
							<p class="font-medium">Common options for {driver} driver:</p>
							{#each COMMON_DRIVER_OPTIONS[driver] as opt}
								<p><code class="bg-muted px-1 rounded">{opt.key}</code> - {opt.description}</p>
							{/each}
						</div>
					{/if}

					{#each driverOptions as opt, i}
						<div class="flex gap-2 items-center">
							<div class="flex-1 relative">
								<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Key</span>
								<Input bind:value={opt.key} class="h-9" />
							</div>
							<div class="flex-1 relative">
								<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Value</span>
								<Input bind:value={opt.value} class="h-9" />
							</div>
							<Button variant="ghost" size="sm" onclick={() => driverOptions = removeItem(driverOptions, i)}>
								<Trash2 class="w-4 h-4 text-destructive" />
							</Button>
						</div>
					{/each}
				</div>
				</Tabs.Content>

				<!-- Labels Tab -->
				<Tabs.Content value="labels" class="space-y-4 h-full overflow-y-auto">
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<Label>Labels</Label>
						<Button variant="outline" size="sm" onclick={() => labels = addItem(labels)}>
							<Plus class="w-3 h-3" />Add
						</Button>
					</div>
					<p class="text-xs text-muted-foreground">Set metadata labels on the network</p>

					{#each labels as label, i}
						<div class="flex gap-2 items-center">
							<div class="flex-1 relative">
								<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Key</span>
								<Input bind:value={label.key} class="h-9" />
							</div>
							<div class="flex-1 relative">
								<span class="absolute -top-2 left-2 text-2xs text-muted-foreground bg-background px-1">Value</span>
								<Input bind:value={label.value} class="h-9" />
							</div>
							<Button variant="ghost" size="sm" onclick={() => labels = removeItem(labels, i)}>
								<Trash2 class="w-4 h-4 text-destructive" />
							</Button>
						</div>
					{/each}
					{#if labels.length === 0}
						<p class="text-xs text-muted-foreground italic">No labels configured</p>
					{/if}
				</div>
				</Tabs.Content>
			</div>
		</Tabs.Root>

		{#if error}
			<Alert.Root variant="destructive" class="mt-4">
				<TriangleAlert class="h-4 w-4" />
				<Alert.Description>{error}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if errors.name || errors.parentInterface || errors.subnet}
			<Alert.Root variant="destructive" class="mt-4">
				<TriangleAlert class="h-4 w-4" />
				<Alert.Description>Please fix the validation errors above</Alert.Description>
			</Alert.Root>
		{/if}

		<Dialog.Footer class="mt-6">
			<Button variant="outline" onclick={handleClose} disabled={creating}>Cancel</Button>
			<Button onclick={handleSubmit} disabled={creating}>
				{#if creating}Creating...{:else}Create network{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
