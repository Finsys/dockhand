<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import * as Select from '$lib/components/ui/select';
	import { CheckCircle2, XCircle, Upload, Server, Settings2, Icon, ArrowBigRight } from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import { currentEnvironment } from '$lib/stores/environment';
	import PushTab from '$lib/components/PushTab.svelte';

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
		imageId: string;
		imageName: string;
		registries: Registry[];
		envId?: number | null;
		onClose?: () => void;
		onComplete?: () => void;
	}

	let {
		open = $bindable(),
		imageId,
		imageName,
		registries,
		envId,
		onClose,
		onComplete
	}: Props = $props();

	// Component ref
	let pushTabRef = $state<PushTab | undefined>();

	// Step state: configure → push
	let currentStep = $state<'configure' | 'push'>('configure');

	// Configuration
	let targetRegistryId = $state<number | null>(null);
	let customTag = $state('');

	// Status
	let pushStatus = $state<'idle' | 'pushing' | 'complete' | 'error'>('idle');
	let pushStarted = $state(false);

	// Computed - allow Docker Hub if it has credentials
	const pushableRegistries = $derived(registries.filter(r => !isDockerHub(r) || r.hasCredentials));
	const targetRegistry = $derived(registries.find(r => r.id === targetRegistryId));

	const targetImageName = $derived(() => {
		if (!targetRegistryId || !targetRegistry) return customTag || 'image:latest';
		const tag = customTag ? (customTag.includes(':') ? customTag : customTag + ':latest') : 'image:latest';
		// Docker Hub doesn't need host prefix
		if (isDockerHub(targetRegistry)) {
			return tag;
		}
		// Include both host and path (e.g., registry.example.com/organization)
		const url = new URL(targetRegistry.url);
		const hostWithPath = url.host + (url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '');
		return `${hostWithPath}/${tag}`;
	});

	const isProcessing = $derived(pushStatus === 'pushing');

	function isDockerHub(registry: Registry): boolean {
		const url = registry.url.toLowerCase();
		return url.includes('docker.io') || url.includes('hub.docker.com') || url.includes('registry.hub.docker.com');
	}

	// Extract base image name (without registry prefix)
	function getBaseImageName(): string {
		const nameWithoutRegistry = imageName.includes('/')
			? imageName.split('/').slice(-1)[0]
			: imageName;
		return nameWithoutRegistry.includes(':') ? nameWithoutRegistry : `${nameWithoutRegistry}:latest`;
	}

	$effect(() => {
		if (!open) {
			// Reset when modal closes
			currentStep = 'configure';
			targetRegistryId = null;
			customTag = '';
			pushStatus = 'idle';
			pushStarted = false;
			pushTabRef?.reset();
		} else {
			// Set initial values when modal opens
			// Only preselect if there's exactly one registry
			targetRegistryId = pushableRegistries.length === 1 ? pushableRegistries[0].id : null;
			// Pre-fill target tag with source image name
			customTag = getBaseImageName();
		}
	});

	// Auto-prefix with username when Docker Hub registry is selected
	$effect(() => {
		if (targetRegistry && isDockerHub(targetRegistry) && targetRegistry.username) {
			const baseImage = getBaseImageName();
			const currentBase = customTag.includes('/') ? customTag.split('/').slice(-1)[0] : customTag;
			// Only update if the base image matches and doesn't already have the correct prefix
			if (!customTag.startsWith(`${targetRegistry.username}/`)) {
				customTag = `${targetRegistry.username}/${currentBase || baseImage}`;
			}
		}
	});

	function startPush() {
		currentStep = 'push';
		pushStarted = true;
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

	const effectiveEnvId = $derived(envId ?? $currentEnvironment?.id ?? null);
</script>

<Dialog.Root bind:open onOpenChange={handleClose}>
	<Dialog.Content class="max-w-3xl h-[70vh] flex flex-col">
		<Dialog.Header class="shrink-0 pb-2">
			<Dialog.Title class="flex items-center gap-2">
				{#if pushStatus === 'complete'}
					<CheckCircle2 class="w-5 h-5 text-green-500" />
				{:else if pushStatus === 'error'}
					<XCircle class="w-5 h-5 text-red-500" />
				{:else}
					<Upload class="w-5 h-5" />
				{/if}
				Push to registry
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
						<code class="break-all">{imageName}</code>
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
					<p class="text-xs text-muted-foreground">
						Will be pushed as: <code class="bg-muted px-1 py-0.5 rounded">{targetImageName()}</code>
					</p>
				</div>
			</div>

			<!-- Push Step -->
			<div class="flex flex-col flex-1 min-h-0" class:hidden={currentStep !== 'push'}>
				<PushTab
					bind:this={pushTabRef}
					sourceImageName={imageName}
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
				{#if currentStep === 'push' && pushStatus === 'error'}
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
						onclick={startPush}
						disabled={!targetRegistryId || pushableRegistries.length === 0}
					>
						<Upload class="w-4 h-4" />
						Push
					</Button>
				{/if}
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
