<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import * as Select from '$lib/components/ui/select';
	import { CheckCircle2, XCircle, Download, Upload, Server, Settings2, Copy, Check, Clipboard, Icon, ShieldCheck, ShieldAlert, ShieldX, ArrowBigRight } from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { currentEnvironment } from '$lib/stores/environment';
	import PullTab from '$lib/components/PullTab.svelte';
	import ScanTab from '$lib/components/ScanTab.svelte';
	import PushTab from '$lib/components/PushTab.svelte';
	import type { ScanResult } from '$lib/components/ScanTab.svelte';

	interface Registry {
		id: number;
		name: string;
		url: string;
		username?: string;
		hasCredentials: boolean;
		is_default: boolean;
	}

	interface Props {
		open: boolean;
		imageName: string;
		initialTag?: string;
		registries: Registry[];
		sourceRegistryId?: number | null;
		envId?: number | null;
		onClose?: () => void;
		onComplete?: () => void;
	}

	let {
		open = $bindable(),
		imageName,
		initialTag = 'latest',
		registries,
		sourceRegistryId = null,
		envId,
		onClose,
		onComplete
	}: Props = $props();

	// Component refs
	let pullTabRef = $state<PullTab | undefined>();
	let scanTabRef = $state<ScanTab | undefined>();
	let pushTabRef = $state<PushTab | undefined>();

	// Step state: configure → pull → scan (optional) → push
	let currentStep = $state<'configure' | 'pull' | 'scan' | 'push'>('configure');

	// Configuration
	let sourceTag = $state('latest');
	let targetRegistryId = $state<number | null>(null);
	let customTag = $state('');

	// Scanner settings - scanning enabled if scanner is configured
	let envHasScanning = $state(false);

	// Status
	let pullStatus = $state<'idle' | 'pulling' | 'complete' | 'error'>('idle');
	let pullStarted = $state(false);
	let scanStatus = $state<'idle' | 'scanning' | 'complete' | 'error'>('idle');
	let scanStarted = $state(false);
	let scanResults = $state<ScanResult[]>([]);
	let pushStatus = $state<'idle' | 'pushing' | 'complete' | 'error'>('idle');
	let pushStarted = $state(false);
	let copiedToClipboard = $state<'ok' | 'error' | null>(null);

	// Computed
	const sourceRegistry = $derived(registries.find(r => r.id === sourceRegistryId));
	const pushableRegistries = $derived(registries.filter(r => !isDockerHub(r) && r.id !== sourceRegistryId));
	const targetRegistry = $derived(registries.find(r => r.id === targetRegistryId));

	const fullSourceImageName = $derived(() => {
		const tagToUse = sourceTag.trim() || 'latest';
		const imageWithTag = imageName.includes(':') ? imageName : `${imageName}:${tagToUse}`;
		if (sourceRegistry && !isDockerHub(sourceRegistry)) {
			const urlObj = new URL(sourceRegistry.url);
			// Include both host and path (e.g., registry.example.com/organization)
			const hostWithPath = urlObj.host + (urlObj.pathname !== '/' ? urlObj.pathname.replace(/\/$/, '') : '');
			return `${hostWithPath}/${imageWithTag}`;
		}
		return imageWithTag;
	});

	const targetImageName = $derived(() => {
		if (!targetRegistryId || !targetRegistry) return customTag || 'image:latest';
		// Include both host and path (e.g., registry.example.com/organization)
		const url = new URL(targetRegistry.url);
		const hostWithPath = url.host + (url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '');
		const tag = customTag ? (customTag.includes(':') ? customTag : customTag + ':latest') : 'image:latest';
		return `${hostWithPath}/${tag}`;
	});

	const isProcessing = $derived(pullStatus === 'pulling' || scanStatus === 'scanning' || pushStatus === 'pushing');

	const totalVulnerabilities = $derived(
		scanResults.reduce((total, r) => total + r.vulnerabilities.length, 0)
	);

	const hasCriticalOrHigh = $derived(
		scanResults.some(r => r.summary.critical > 0 || r.summary.high > 0)
	);

	function isDockerHub(registry: Registry): boolean {
		const url = registry.url.toLowerCase();
		return url.includes('docker.io') || url.includes('hub.docker.com') || url.includes('registry.hub.docker.com');
	}

	async function fetchScannerSettings() {
		try {
			const effectiveEnvId = envId ?? $currentEnvironment?.id;
			const url = effectiveEnvId
				? `/api/settings/scanner?env=${effectiveEnvId}&settingsOnly=true`
				: '/api/settings/scanner?settingsOnly=true';
			const response = await fetch(url);
			if (response.ok) {
				const data = await response.json();
				const scanner = data.settings?.scanner ?? 'none';
				// Scanning is enabled if a scanner is configured
				envHasScanning = scanner !== 'none';
			}
		} catch (error) {
			console.error('Failed to fetch scanner settings:', error);
		}
	}

	$effect(() => {
		if (!open) {
			// Reset when modal closes
			currentStep = 'configure';
			sourceTag = initialTag;
			targetRegistryId = null;
			customTag = '';
			pullStatus = 'idle';
			pullStarted = false;
			scanStatus = 'idle';
			scanStarted = false;
			scanResults = [];
			pushStatus = 'idle';
			pushStarted = false;
			pullTabRef?.reset();
			scanTabRef?.reset();
			pushTabRef?.reset();
		} else {
			// Set initial values when modal opens
			sourceTag = initialTag;
			// Pre-fill target tag with source image name (without registry prefix) and tag
			const imageNameOnly = imageName.includes('/') ? imageName.split('/').pop()! : imageName;
			customTag = `${imageNameOnly}:${initialTag}`;
			// Preselect registry if only one available
			if (pushableRegistries.length === 1) {
				targetRegistryId = pushableRegistries[0].id;
			}
			// Fetch scanner settings
			fetchScannerSettings();
		}
	});

	function startCopy() {
		currentStep = 'pull';
		pullStarted = true;
		// PullTab will auto-start due to autoStart prop
	}

	function handlePullComplete() {
		pullStatus = 'complete';
		if (envHasScanning) {
			// Go to scan step
			currentStep = 'scan';
			scanStarted = true;
			// ScanTab will auto-start
			setTimeout(() => scanTabRef?.startScan(), 100);
		} else {
			// Skip scan, go directly to push
			currentStep = 'push';
			pushStarted = true;
			// PushTab will auto-start
			setTimeout(() => pushTabRef?.startPush(), 100);
		}
	}

	function handlePullError(error: string) {
		pullStatus = 'error';
	}

	function handlePullStatusChange(status: 'idle' | 'pulling' | 'complete' | 'error') {
		pullStatus = status;
	}

	function handleScanComplete(results: ScanResult[]) {
		scanResults = results;
		// Don't auto-push - wait for user confirmation
	}

	function handleScanError(error: string) {
		// Error is handled by ScanTab display
	}

	function handleScanStatusChange(status: 'idle' | 'scanning' | 'complete' | 'error') {
		scanStatus = status;
	}

	function proceedToPush() {
		currentStep = 'push';
		pushStarted = true;
		// PushTab will auto-start
		setTimeout(() => pushTabRef?.startPush(), 100);
	}

	function handlePushComplete(_targetTag: string) {
		pushStatus = 'complete';
		onComplete?.();
	}

	function handlePushError(_error: string) {
		pushStatus = 'error';
	}

	function handlePushStatusChange(status: 'idle' | 'pushing' | 'complete' | 'error') {
		pushStatus = status;
	}

	function handleClose() {
		if (!isProcessing) {
			open = false;
			onClose?.();
		}
	}

	async function copyTargetToClipboard() {
		const ok = await copyToClipboard(targetImageName());
		copiedToClipboard = ok ? 'ok' : 'error';
		setTimeout(() => copiedToClipboard = null, 2000);
	}

	const effectiveEnvId = $derived(envId ?? $currentEnvironment?.id ?? null);
</script>

<Dialog.Root bind:open onOpenChange={handleClose}>
	<Dialog.Content class="max-w-4xl h-[85vh] flex flex-col">
		<Dialog.Header class="shrink-0 pb-2">
			<Dialog.Title class="flex items-center gap-2">
				{#if pushStatus === 'complete'}
					<CheckCircle2 class="w-5 h-5 text-green-500" />
				{:else if pullStatus === 'error' || pushStatus === 'error'}
					<XCircle class="w-5 h-5 text-red-500" />
				{:else}
					<Copy class="w-5 h-5" />
				{/if}
				Copy to registry
				<code class="text-sm font-normal bg-muted px-1.5 py-0.5 rounded ml-1">{imageName}</code>
			</Dialog.Title>
		</Dialog.Header>

		<!-- Step tabs -->
		<div class="flex items-center border-b shrink-0">
			<button
				class="px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer {currentStep === 'configure' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => { if (!isProcessing && currentStep !== 'configure') currentStep = 'configure'; }}
				disabled={isProcessing}
			>
				<Settings2 class="w-3.5 h-3.5 inline mr-1.5" />
				Configure
			</button>
			<ArrowBigRight class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
			<button
				class="px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer {currentStep === 'pull' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => { if (!isProcessing && pullStatus !== 'idle') currentStep = 'pull'; }}
				disabled={isProcessing || pullStatus === 'idle'}
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
					class="px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer {currentStep === 'scan' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => { if (!isProcessing && scanStatus !== 'idle') currentStep = 'scan'; }}
					disabled={isProcessing || scanStatus === 'idle'}
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
			<ArrowBigRight class="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
			<button
				class="px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer {currentStep === 'push' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => { if (!isProcessing && pushStatus !== 'idle') currentStep = 'push'; }}
				disabled={isProcessing || pushStatus === 'idle'}
			>
				<Upload class="w-3.5 h-3.5 inline mr-1.5" />
				Push
				{#if pushStatus === 'complete'}
					<CheckCircle2 class="w-3.5 h-3.5 inline ml-1 text-green-500" />
				{:else if pushStatus === 'error'}
					<XCircle class="w-3.5 h-3.5 inline ml-1 text-red-500" />
				{:else}
					<CheckCircle2 class="w-3.5 h-3.5 inline ml-1 invisible" />
				{/if}
			</button>
		</div>

		<div class="flex-1 min-h-0 flex flex-col overflow-hidden py-4">
			<!-- Configuration Step -->
			<div class="space-y-4 px-1" class:hidden={currentStep !== 'configure'}>
					<div class="space-y-2">
						<Label>Source image</Label>
						<div class="p-2 bg-muted rounded text-sm">
							<code class="break-all">{imageName}:{sourceTag}</code>
						</div>
					</div>

					<div class="space-y-2">
						<Label>Target registry</Label>
						<Select.Root type="single" value={targetRegistryId ? String(targetRegistryId) : undefined} onValueChange={(v) => targetRegistryId = Number(v)}>
							<Select.Trigger class="w-full h-9 justify-start">
								{#if targetRegistry}
									{#if isDockerHub(targetRegistry)}
										<Icon iconNode={whale} class="w-4 h-4 mr-2 text-muted-foreground" />
									{:else}
										<Server class="w-4 h-4 mr-2 text-muted-foreground" />
									{/if}
									<span class="flex-1 text-left">{targetRegistry.name}{targetRegistry.hasCredentials ? ' (auth)' : ''}</span>
								{:else}
									<span class="text-muted-foreground">Select registry</span>
								{/if}
							</Select.Trigger>
							<Select.Content>
								{#each pushableRegistries as registry}
									<Select.Item value={String(registry.id)} label={registry.name}>
										{#if isDockerHub(registry)}
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
						{#if pushableRegistries.length === 0}
							<p class="text-xs text-muted-foreground">No target registries available. Add a private registry in Settings.</p>
						{/if}
					</div>

					<div class="space-y-2">
						<Label>Image name/tag</Label>
						<Input
							bind:value={customTag}
							placeholder="myimage:latest"
						/>
						<p class="text-xs text-muted-foreground flex items-center gap-1">
							<span>Will be pushed as:</span>
							<code class="bg-muted px-1 py-0.5 rounded">{targetImageName()}</code>
							<button
								type="button"
								onclick={copyTargetToClipboard}
								class="p-0.5 rounded hover:bg-muted transition-colors cursor-pointer"
								title="Copy to clipboard"
							>
								{#if copiedToClipboard === 'error'}
									<Tooltip.Root open>
										<Tooltip.Trigger>
											<XCircle class="w-3 h-3 text-red-500" />
										</Tooltip.Trigger>
										<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
									</Tooltip.Root>
								{:else if copiedToClipboard === 'ok'}
									<Check class="w-3 h-3 text-green-500" />
								{:else}
									<Clipboard class="w-3 h-3 text-muted-foreground hover:text-foreground" />
								{/if}
							</button>
						</p>
					</div>
			</div>

			<!-- Pull Step -->
			<div class="flex flex-col flex-1 min-h-0" class:hidden={currentStep !== 'pull'}>
				<PullTab
					bind:this={pullTabRef}
					imageName={fullSourceImageName()}
					envId={effectiveEnvId}
					showImageInput={false}
					autoStart={pullStarted && pullStatus === 'idle'}
					onComplete={handlePullComplete}
					onError={handlePullError}
					onStatusChange={handlePullStatusChange}
				/>
			</div>

			<!-- Scan Step -->
			{#if envHasScanning}
				<div class="flex flex-col flex-1 min-h-0" class:hidden={currentStep !== 'scan'}>
					<ScanTab
						bind:this={scanTabRef}
						imageName={fullSourceImageName()}
						envId={effectiveEnvId}
						autoStart={scanStarted && scanStatus === 'idle'}
						onComplete={handleScanComplete}
						onError={handleScanError}
						onStatusChange={handleScanStatusChange}
					/>
				</div>
			{/if}

			<!-- Push Step -->
			<div class="flex flex-col flex-1 min-h-0" class:hidden={currentStep !== 'push'}>
				<PushTab
					bind:this={pushTabRef}
					sourceImageName={fullSourceImageName()}
					registryId={targetRegistryId ?? 0}
					newTag={customTag}
					registryName={targetRegistry?.name || 'registry'}
					envId={effectiveEnvId}
					autoStart={pushStarted && pushStatus === 'idle'}
					onComplete={handlePushComplete}
					onError={handlePushError}
					onStatusChange={handlePushStatusChange}
				/>
			</div>
		</div>

		<Dialog.Footer class="shrink-0 flex justify-between">
			<div>
				{#if currentStep === 'pull' && pullStatus === 'error'}
					<Button variant="outline" onclick={() => pullTabRef?.startPull()}>
						Retry pull
					</Button>
				{:else if currentStep === 'scan' && scanStatus === 'error'}
					<Button variant="outline" onclick={() => scanTabRef?.startScan()}>
						Retry scan
					</Button>
				{:else if currentStep === 'push' && pushStatus === 'error'}
					<Button variant="outline" onclick={() => pushTabRef?.startPush()}>
						Retry push
					</Button>
				{/if}
			</div>
			<div class="flex gap-2">
				<Button
					variant="outline"
					onclick={handleClose}
					disabled={isProcessing}
				>
					{pushStatus === 'complete' ? 'Done' : 'Cancel'}
				</Button>
				{#if currentStep === 'configure'}
					<Button
						onclick={startCopy}
						disabled={!targetRegistryId || pushableRegistries.length === 0}
					>
						<Copy class="w-4 h-4" />
						Start copy
					</Button>
				{:else if currentStep === 'scan' && scanStatus === 'complete'}
					{#if hasCriticalOrHigh}
						<div class="flex items-center gap-2 text-red-600 text-sm mr-2">
							<ShieldX class="w-4 h-4" />
							<span>Critical/high vulnerabilities found</span>
						</div>
					{:else if totalVulnerabilities > 0}
						<div class="flex items-center gap-2 text-yellow-600 text-sm mr-2">
							<ShieldAlert class="w-4 h-4" />
							<span>{totalVulnerabilities} vulnerabilities found</span>
						</div>
					{/if}
					<Button onclick={proceedToPush} variant={hasCriticalOrHigh ? 'destructive' : 'default'}>
						<Upload class="w-4 h-4" />
						{hasCriticalOrHigh ? 'Push anyway' : 'Continue to push'}
					</Button>
				{/if}
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
