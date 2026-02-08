<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import * as Select from '$lib/components/ui/select';
	import { CheckCircle2, XCircle, Download, ShieldCheck, ShieldAlert, ShieldX, ArrowBigRight, Settings2, Server, Trash2, Loader2, Icon } from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import { currentEnvironment } from '$lib/stores/environment';
	import PullTab from '$lib/components/PullTab.svelte';
	import ScanTab from '$lib/components/ScanTab.svelte';
	import type { ScanResult } from '$lib/components/ScanTab.svelte';

	interface Registry {
		id: number;
		name: string;
		url: string;
		hasCredentials: boolean;
		is_default: boolean;
	}

	interface Props {
		open: boolean;
		imageName?: string;              // Optional - if not provided, show configure step
		registries?: Registry[];         // For registry selection in configure step
		envHasScanning?: boolean;
		envId?: number | null;
		showDeleteButton?: boolean;      // Show "Remove image" after scan (for Images page)
		onClose?: () => void;
		onComplete?: () => void;
	}

	let { open = $bindable(), imageName = '', registries = [], envHasScanning = false, envId, showDeleteButton = false, onClose, onComplete }: Props = $props();

	// Component refs
	let pullTabRef = $state<PullTab | undefined>();
	let scanTabRef = $state<ScanTab | undefined>();

	// Determine if we need configure step (when imageName is not provided)
	const needsConfigureStep = $derived(!imageName);

	// Tab state - use 'configure' | 'pull' | 'scan'
	let activeTab = $state<'configure' | 'pull' | 'scan'>('pull');

	// Configure step state
	let selectedRegistryId = $state<number | 'dockerhub' | null>('dockerhub');
	let configImageName = $state('');

	// Track status from components
	let pullStatus = $state<'idle' | 'pulling' | 'complete' | 'error'>('idle');
	let scanStatus = $state<'idle' | 'scanning' | 'complete' | 'error'>('idle');
	let scanResults = $state<ScanResult[]>([]);
	let hasStarted = $state(false);
	let pullStarted = $state(false);
	let scanStarted = $state(false);
	let autoSwitchedToScan = $state(false);

	// Delete state
	let isDeleting = $state(false);

	// Check if a registry is Docker Hub
	function isDockerHub(registry: Registry): boolean {
		const url = registry.url.toLowerCase();
		return url.includes('docker.io') ||
			   url.includes('hub.docker.com') ||
			   url.includes('registry.hub.docker.com');
	}

	// Get all registries plus a Docker Hub option
	const allRegistries = $derived([
		{ id: 'dockerhub' as const, name: 'Docker Hub (public)', url: 'https://hub.docker.com', hasCredentials: false, is_default: false },
		...registries.filter(r => !isDockerHub(r))
	]);

	const selectedRegistry = $derived(
		selectedRegistryId === 'dockerhub'
			? allRegistries[0]
			: registries.find(r => r.id === selectedRegistryId)
	);

	// Build full image reference for configure mode
	const fullImageReference = $derived.by(() => {
		if (!configImageName.trim()) return '';

		const name = configImageName.trim();

		// For Docker Hub, use as-is (docker handles it)
		if (selectedRegistryId === 'dockerhub') {
			return name.includes(':') ? name : `${name}:latest`;
		}

		// For other registries, prefix with registry URL
		const registry = registries.find(r => r.id === selectedRegistryId);
		if (!registry) return name;

		const url = new URL(registry.url);
		const hostWithPath = url.host + (url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '');
		const imageWithTag = name.includes(':') ? name : `${name}:latest`;
		return `${hostWithPath}/${imageWithTag}`;
	});

	// The actual image name to pull (either from prop or from configure step)
	const effectiveImageName = $derived(imageName || fullImageReference);

	$effect(() => {
		if (open && imageName && !hasStarted) {
			// When imageName is provided (registry page), go directly to pull
			hasStarted = true;
			pullStarted = true;
			activeTab = 'pull';
		}
		if (open && !imageName && !hasStarted) {
			// When no imageName (images page), show configure step
			activeTab = 'configure';
		}
		if (!open) {
			// Reset when modal closes
			hasStarted = false;
			pullStarted = false;
			scanStarted = false;
			pullStatus = 'idle';
			scanStatus = 'idle';
			scanResults = [];
			activeTab = imageName ? 'pull' : 'configure';
			autoSwitchedToScan = false;
			isDeleting = false;
			// Reset configure state
			selectedRegistryId = 'dockerhub';
			configImageName = '';
			pullTabRef?.reset();
			scanTabRef?.reset();
		}
	});

	function handlePullComplete() {
		pullStatus = 'complete';
		if (envHasScanning && !autoSwitchedToScan) {
			autoSwitchedToScan = true;
			scanStarted = true;
			activeTab = 'scan';
			setTimeout(() => scanTabRef?.startScan(), 100);
		} else {
			onComplete?.();
		}
	}

	function handlePullError(_error: string) {
		pullStatus = 'error';
	}

	function handlePullStatusChange(status: 'idle' | 'pulling' | 'complete' | 'error') {
		pullStatus = status;
	}

	function handleScanComplete(results: ScanResult[]) {
		scanResults = results;
		onComplete?.();
	}

	function handleScanError(_error: string) {
		// Error is handled by ScanTab display
	}

	function handleScanStatusChange(status: 'idle' | 'scanning' | 'complete' | 'error') {
		scanStatus = status;
	}

	function handleClose() {
		if (pullStatus !== 'pulling' && scanStatus !== 'scanning' && !isDeleting) {
			open = false;
			onClose?.();
		}
	}

	function startPullFromConfigure() {
		// Switch to pull tab and start pulling
		hasStarted = true;
		pullStarted = true;
		activeTab = 'pull';
	}

	async function deleteImage() {
		if (!effectiveImageName) return;

		isDeleting = true;
		try {
			const deleteUrl = effectiveEnvId
				? `/api/images/${encodeURIComponent(effectiveImageName)}?env=${effectiveEnvId}`
				: `/api/images/${encodeURIComponent(effectiveImageName)}`;

			const response = await fetch(deleteUrl, { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.error || 'Failed to delete image');
			}

			// Close modal after successful delete
			onComplete?.();
			open = false;
			onClose?.();
		} catch (error: any) {
			console.error('Failed to delete image:', error);
			// Could add error display here if needed
		} finally {
			isDeleting = false;
		}
	}

	const totalVulnerabilities = $derived(
		scanResults.reduce((total, r) => total + r.vulnerabilities.length, 0)
	);

	const hasCriticalOrHigh = $derived(
		scanResults.some(r => r.summary.critical > 0 || r.summary.high > 0)
	);

	const isProcessing = $derived(pullStatus === 'pulling' || scanStatus === 'scanning' || isDeleting);

	const effectiveEnvId = $derived(envId ?? $currentEnvironment?.id ?? null);

	const title = $derived(envHasScanning ? 'Pull & scan image' : 'Pull image');
</script>

<Dialog.Root bind:open onOpenChange={handleClose}>
	<Dialog.Content class="max-w-4xl h-[85vh] flex flex-col">
		<Dialog.Header class="shrink-0 pb-2">
			<Dialog.Title class="flex items-center gap-2">
				{#if scanStatus === 'complete' && scanResults.length > 0}
					{#if hasCriticalOrHigh}
						<ShieldX class="w-5 h-5 text-red-500" />
					{:else if totalVulnerabilities > 0}
						<ShieldAlert class="w-5 h-5 text-yellow-500" />
					{:else}
						<ShieldCheck class="w-5 h-5 text-green-500" />
					{/if}
				{:else if pullStatus === 'complete' && !envHasScanning}
					<CheckCircle2 class="w-5 h-5 text-green-500" />
				{:else if pullStatus === 'error' || scanStatus === 'error'}
					<XCircle class="w-5 h-5 text-red-500" />
				{:else}
					<Download class="w-5 h-5" />
				{/if}
				{title}
				{#if effectiveImageName}
					<code class="text-sm font-normal bg-muted px-1.5 py-0.5 rounded ml-1">{effectiveImageName}</code>
				{/if}
			</Dialog.Title>
		</Dialog.Header>

		<!-- Step tabs - show configure tab only when needed -->
		<div class="flex items-center border-b shrink-0">
			{#if needsConfigureStep}
				<button
					class="px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer {activeTab === 'configure' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => { if (!isProcessing && activeTab !== 'configure') activeTab = 'configure'; }}
					disabled={isProcessing}
				>
					<Settings2 class="w-3.5 h-3.5 inline mr-1.5" />
					Configure
				</button>
				<ArrowBigRight class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
			{/if}
			<button
				class="px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer {activeTab === 'pull' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => { if (!isProcessing && pullStatus !== 'idle') activeTab = 'pull'; }}
				disabled={isProcessing || (needsConfigureStep && pullStatus === 'idle')}
			>
				<Download class="w-3.5 h-3.5 inline mr-1.5" />
				Pull
				{#if pullStatus === 'complete'}
					<CheckCircle2 class="w-3.5 h-3.5 inline ml-1 text-green-500" />
				{:else if pullStatus === 'error'}
					<XCircle class="w-3.5 h-3.5 inline ml-1 text-red-500" />
				{:else}
					<CheckCircle2 class="w-3.5 h-3.5 inline ml-1 invisible" />
				{/if}
			</button>
			{#if envHasScanning}
				<ArrowBigRight class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
				<button
					class="px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer {activeTab === 'scan' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => { if (!isProcessing && scanStarted) activeTab = 'scan'; }}
					disabled={isProcessing || !scanStarted}
				>
					{#if scanStatus === 'complete' && scanResults.length > 0}
						{#if hasCriticalOrHigh}
							<ShieldX class="w-3.5 h-3.5 inline mr-1.5 text-red-500" />
						{:else if totalVulnerabilities > 0}
							<ShieldAlert class="w-3.5 h-3.5 inline mr-1.5 text-yellow-500" />
						{:else}
							<ShieldCheck class="w-3.5 h-3.5 inline mr-1.5 text-green-500" />
						{/if}
					{:else}
						<ShieldCheck class="w-3.5 h-3.5 inline mr-1.5" />
					{/if}
					Scan
					{#if scanStatus === 'complete'}
						<CheckCircle2 class="w-3.5 h-3.5 inline ml-1 text-green-500" />
					{:else if scanStatus === 'error'}
						<XCircle class="w-3.5 h-3.5 inline ml-1 text-red-500" />
					{:else}
						<CheckCircle2 class="w-3.5 h-3.5 inline ml-1 invisible" />
					{/if}
				</button>
			{/if}
		</div>

		<div class="flex-1 min-h-0 flex flex-col overflow-hidden py-2">
			<!-- Configure Tab -->
			{#if needsConfigureStep}
				<div class="space-y-4 px-1 overflow-auto" class:hidden={activeTab !== 'configure'}>
					<div class="space-y-2">
						<Label>Registry</Label>
						<Select.Root
							type="single"
							value={selectedRegistryId === 'dockerhub' ? 'dockerhub' : selectedRegistryId ? String(selectedRegistryId) : undefined}
							onValueChange={(v) => selectedRegistryId = v === 'dockerhub' ? 'dockerhub' : Number(v)}
						>
							<Select.Trigger class="w-full h-9 justify-start">
								{#if selectedRegistry}
									{#if selectedRegistryId === 'dockerhub'}
										<Icon iconNode={whale} class="w-4 h-4 mr-2 text-muted-foreground" />
									{:else}
										<Server class="w-4 h-4 mr-2 text-muted-foreground" />
									{/if}
									<span class="flex-1 text-left">{selectedRegistry.name}</span>
								{:else}
									<span class="text-muted-foreground">Select registry</span>
								{/if}
							</Select.Trigger>
							<Select.Content>
								{#each allRegistries as registry}
									<Select.Item value={registry.id === 'dockerhub' ? 'dockerhub' : String(registry.id)} label={registry.name}>
										{#if registry.id === 'dockerhub'}
											<Icon iconNode={whale} class="w-4 h-4 mr-2 text-muted-foreground" />
										{:else}
											<Server class="w-4 h-4 mr-2 text-muted-foreground" />
										{/if}
										{registry.name}
										{#if registry.hasCredentials}
											<Badge variant="outline" class="ml-2 text-xs">auth</Badge>
										{/if}
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>

					<div class="space-y-2">
						<Label>Image name</Label>
						<Input
							bind:value={configImageName}
							placeholder={selectedRegistryId === 'dockerhub' ? 'nginx:latest or library/nginx:1.25' : 'myimage:latest'}
							onkeydown={(e: KeyboardEvent) => {
								if (e.key === 'Enter' && configImageName.trim()) {
									startPullFromConfigure();
								}
							}}
						/>
						<p class="text-xs text-muted-foreground">
							Format: <code class="bg-muted px-1 py-0.5 rounded">image:tag</code> or <code class="bg-muted px-1 py-0.5 rounded">namespace/image:tag</code>
						</p>
					</div>

					{#if configImageName.trim()}
						<div class="space-y-2">
							<Label class="text-muted-foreground">Full image reference</Label>
							<div class="p-2 bg-muted rounded text-sm">
								<code class="break-all">{fullImageReference}</code>
							</div>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Pull Tab -->
			<div class="flex flex-col flex-1 min-h-0" class:hidden={activeTab !== 'pull'}>
				<PullTab
					bind:this={pullTabRef}
					imageName={effectiveImageName}
					envId={effectiveEnvId}
					showImageInput={false}
					autoStart={pullStarted && pullStatus === 'idle'}
					onComplete={handlePullComplete}
					onError={handlePullError}
					onStatusChange={handlePullStatusChange}
				/>
			</div>

			<!-- Scan Tab -->
			{#if envHasScanning}
				<div class="flex flex-col flex-1 min-h-0" class:hidden={activeTab !== 'scan'}>
					<ScanTab
						bind:this={scanTabRef}
						imageName={effectiveImageName}
						envId={effectiveEnvId}
						autoStart={scanStarted && scanStatus === 'idle'}
						onComplete={handleScanComplete}
						onError={handleScanError}
						onStatusChange={handleScanStatusChange}
					/>
				</div>
			{/if}
		</div>

		<Dialog.Footer class="shrink-0 flex justify-between">
			<div>
				{#if activeTab === 'pull' && pullStatus === 'error'}
					<Button variant="outline" onclick={() => pullTabRef?.startPull()}>
						Retry
					</Button>
				{:else if activeTab === 'scan' && scanStatus === 'error'}
					<Button variant="outline" onclick={() => scanTabRef?.startScan()}>
						Retry scan
					</Button>
				{/if}
			</div>
			<div class="flex gap-2">
				{#if showDeleteButton && scanStatus === 'complete'}
					<!-- Show Keep/Remove buttons after scan completes (Images page usage) -->
					<Button
						variant="destructive"
						onclick={deleteImage}
						disabled={isDeleting}
					>
						{#if isDeleting}
							<Loader2 class="w-4 h-4 mr-2 animate-spin" />
							Removing...
						{:else}
							<Trash2 class="w-4 h-4" />
							Remove image
						{/if}
					</Button>
					<Button
						variant="default"
						onclick={handleClose}
						disabled={isDeleting}
					>
						<CheckCircle2 class="w-4 h-4" />
						Keep image
					</Button>
				{:else if showDeleteButton && pullStatus === 'complete' && !envHasScanning}
					<!-- Show Keep/Remove buttons after pull completes when no scanning (Images page) -->
					<Button
						variant="destructive"
						onclick={deleteImage}
						disabled={isDeleting}
					>
						{#if isDeleting}
							<Loader2 class="w-4 h-4 mr-2 animate-spin" />
							Removing...
						{:else}
							<Trash2 class="w-4 h-4" />
							Remove image
						{/if}
					</Button>
					<Button
						variant="default"
						onclick={handleClose}
						disabled={isDeleting}
					>
						<CheckCircle2 class="w-4 h-4" />
						Keep image
					</Button>
				{:else}
					<Button
						variant="outline"
						onclick={handleClose}
						disabled={isProcessing}
					>
						{pullStatus === 'complete' && !envHasScanning ? 'Done' : 'Cancel'}
					</Button>
					{#if activeTab === 'configure'}
						<Button
							onclick={startPullFromConfigure}
							disabled={!configImageName.trim()}
						>
							<Download class="w-4 h-4" />
							Pull
						</Button>
					{:else if pullStatus === 'complete' || scanStatus === 'complete'}
						<Button
							variant="default"
							onclick={handleClose}
							disabled={isProcessing}
						>
							OK
						</Button>
					{/if}
				{/if}
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
