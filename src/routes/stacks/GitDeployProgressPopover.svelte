<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Rocket,
		CheckCircle2,
		XCircle,
		Loader2,
		AlertCircle,
		GitBranch,
		FileCode,
		Server,
		Link
	} from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import { Progress } from '$lib/components/ui/progress';

	type SyncMode = 'git' | 'vault' | 'all' | 'deploy';

	interface Props {
		stackId: number;
		stackName: string;
		mode?: SyncMode;
		onComplete?: () => void;
		children: Snippet;
	}

	let { stackId, stackName, mode = 'deploy', onComplete, children }: Props = $props();

	interface StepProgress {
		status: 'connecting' | 'cloning' | 'fetching' | 'reading' | 'deploying' | 'complete' | 'error';
		message?: string;
		step?: number;
		totalSteps?: number;
		error?: string;
	}

	let open = $state(false);
	let overallStatus = $state<'idle' | 'deploying' | 'complete' | 'error'>('idle');
	let currentStep = $state<StepProgress | null>(null);
	let steps = $state<StepProgress[]>([]);
	let errorMessage = $state('');

	function getStepIcon(status: string) {
		switch (status) {
			case 'connecting':
				return Link;
			case 'cloning':
				return GitBranch;
			case 'fetching':
				return GitBranch;
			case 'reading':
				return FileCode;
			case 'deploying':
				return Server;
			case 'complete':
				return CheckCircle2;
			case 'error':
				return XCircle;
			default:
				return Loader2;
		}
	}

	function getStepColor(status: string, isCurrentStep: boolean): string {
		if (status === 'complete') {
			return 'text-green-600 dark:text-green-400';
		}
		if (status === 'error') {
			return 'text-red-600 dark:text-red-400';
		}
		if (isCurrentStep) {
			return 'text-blue-600 dark:text-blue-400';
		}
		return 'text-muted-foreground';
	}

	function getEndpointUrl(): string {
		if (mode === 'deploy') {
			return `/api/git/stacks/${stackId}/deploy-stream`;
		}
		// For sync modes, use the sync endpoint with mode parameter
		return `/api/git/stacks/${stackId}/sync?mode=${mode}`;
	}

	function getActionLabel(): string {
		switch (mode) {
			case 'git': return 'Syncing Git';
			case 'vault': return 'Syncing Vault';
			case 'all': return 'Syncing All';
			default: return 'Deploying';
		}
	}

	async function startDeploy() {
		steps = [];
		currentStep = null;
		overallStatus = 'deploying';
		errorMessage = '';
		open = true;

		// For sync modes, use a simple POST request (not streaming)
		if (mode !== 'deploy') {
			try {
				currentStep = { status: 'connecting', message: getActionLabel() + '...' };
				steps = [currentStep];

				const response = await fetch(getEndpointUrl(), { method: 'POST' });
				const data = await response.json();

				if (!response.ok || !data.success) {
					throw new Error(data.error || 'Sync failed');
				}

				// Build success message
				let message = 'Sync complete';
				if (mode === 'vault' && data.synced !== undefined) {
					message = `Synced ${data.synced} secret(s)`;
				} else if (mode === 'git') {
					message = data.updated ? 'Repository updated' : 'Already up to date';
				} else if (mode === 'all') {
					message = data.updated ? 'Changes detected' : 'Already up to date';
				}

				if (data.deployed) {
					message += data.deploySuccess ? ' (auto-deployed)' : ' (deploy failed)';
				}

				overallStatus = 'complete';
				currentStep = { status: 'complete', message };
				steps = [...steps, currentStep];
				onComplete?.();
			} catch (error: any) {
				console.error('Sync failed:', error);
				overallStatus = 'error';
				errorMessage = error.message || 'Sync failed';
				currentStep = { status: 'error', error: errorMessage };
				steps = [...steps, currentStep];
			}
			return;
		}

		// Original deploy-stream logic for mode === 'deploy'
		try {
			const response = await fetch(getEndpointUrl(), {
				method: 'POST'
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.error || 'Failed to start deployment');
			}

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error('No response body');
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim() || !line.startsWith('data: ')) continue;

					try {
						const data: StepProgress = JSON.parse(line.slice(6));

						if (data.status === 'complete') {
							overallStatus = 'complete';
							currentStep = data;
							steps = [...steps, data];
							onComplete?.();
						} else if (data.status === 'error') {
							overallStatus = 'error';
							errorMessage = data.error || 'Unknown error occurred';
							currentStep = data;
							steps = [...steps, data];
						} else {
							currentStep = data;
							steps = [...steps, data];
						}
					} catch (e) {
						console.error('Failed to parse SSE data:', e);
					}
				}
			}
		} catch (error: any) {
			console.error('Failed to deploy git stack:', error);
			overallStatus = 'error';
			errorMessage = error.message || 'Failed to deploy';
		}
	}

	function handleOpenChange(isOpen: boolean) {
		// Only allow closing via the Close button (not by clicking outside)
		// When deploying, complete, or error - require explicit close
		if (!isOpen && overallStatus !== 'idle') {
			return;
		}

		// Start deploy when opening
		if (isOpen && !open) {
			startDeploy();
			return;
		}

		open = isOpen;
	}

	function handleClose() {
		open = false;
		// Reset state when closed
		overallStatus = 'idle';
		steps = [];
		currentStep = null;
		errorMessage = '';
	}

	const progressPercentage = $derived(
		currentStep?.step && currentStep?.totalSteps
			? Math.round((currentStep.step / currentStep.totalSteps) * 100)
			: 0
	);
</script>

<Popover.Root {open} onOpenChange={handleOpenChange}>
	<Popover.Trigger asChild>
		{@render children()}
	</Popover.Trigger>
	<Popover.Content
		class="w-80 p-0 overflow-hidden flex flex-col z-[200]"
		align="end"
		sideOffset={8}
		interactOutsideBehavior={overallStatus !== 'idle' ? 'ignore' : 'close'}
		escapeKeydownBehavior={overallStatus !== 'idle' ? 'ignore' : 'close'}
	>
		<!-- Header -->
		<div class="p-3 border-b space-y-2">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Rocket class="w-4 h-4 text-violet-600" />
				<span class="truncate">{stackName}</span>
			</div>

			<!-- Overall Progress -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-2">
					{#if overallStatus === 'idle'}
						<Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
						<span class="text-sm text-muted-foreground">Initializing...</span>
					{:else if overallStatus === 'deploying'}
						<Loader2 class="w-4 h-4 animate-spin text-violet-600" />
						<span class="text-sm">Deploying...</span>
					{:else if overallStatus === 'complete'}
						<CheckCircle2 class="w-4 h-4 text-green-600" />
						<span class="text-sm text-green-600">Complete!</span>
					{:else if overallStatus === 'error'}
						<XCircle class="w-4 h-4 text-red-600" />
						<span class="text-sm text-red-600">Failed</span>
					{/if}
				</div>
				{#if currentStep?.step && currentStep?.totalSteps}
					<Badge variant="secondary" class="text-xs">
						{currentStep.step}/{currentStep.totalSteps}
					</Badge>
				{/if}
			</div>

			{#if currentStep?.message && overallStatus === 'deploying'}
				<p class="text-xs text-muted-foreground truncate">{currentStep.message}</p>
			{/if}

			{#if currentStep?.totalSteps}
				<Progress value={progressPercentage} class="h-1.5 [&>[data-progress]]:bg-violet-600" />
			{/if}

			{#if errorMessage}
				<div class="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
					<AlertCircle class="w-3 h-3 shrink-0 mt-0.5" />
					<span class="break-all">{errorMessage}</span>
				</div>
			{/if}
		</div>

		<!-- Steps List -->
		{#if steps.length > 0}
			<div class="p-2 max-h-48 overflow-auto">
				<div class="space-y-1">
					{#each steps as step, index (index)}
						{@const StepIcon = getStepIcon(step.status)}
						{@const isCurrentStep = index === steps.length - 1 && overallStatus === 'deploying'}
						<div class="flex items-center gap-2 py-1 px-1 rounded text-xs hover:bg-muted/50">
							<StepIcon
								class="w-3.5 h-3.5 shrink-0 {getStepColor(step.status, isCurrentStep)} {isCurrentStep && step.status !== 'complete' && step.status !== 'error' ? 'animate-spin' : ''}"
							/>
							<span class="flex-1 {getStepColor(step.status, isCurrentStep)} truncate">
								{step.message || step.status}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Footer -->
		{#if overallStatus === 'complete' || overallStatus === 'error'}
			<div class="p-2 border-t">
				<Button
					variant="outline"
					size="sm"
					class="w-full"
					onclick={handleClose}
				>
					Close
				</Button>
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
