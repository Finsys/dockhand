<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import {
		Rocket,
		CheckCircle2,
		XCircle,
		Loader2,
		AlertCircle,
		GitBranch,
		FileCode,
		Server,
		Link,
		AlertTriangle,
		Copy,
		Check,
		Database,
		KeyRound
	} from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import { appSettings } from '$lib/stores/settings';
	import { watchJob } from '$lib/utils/sse-fetch';

	interface Props {
		stackId: number;
		stackName: string;
		onComplete?: () => void;
		children: Snippet;
	}

	let { stackId, stackName, onComplete, children }: Props = $props();

	interface StepProgress {
		status: 'connecting' | 'cloning' | 'fetching' | 'reading' | 'env' | 'secrets' | 'deploying' | 'complete' | 'error';
		message?: string;
		step?: number;
		totalSteps?: number;
		error?: string;
	}

	let open = $state(false);
	let overallStatus = $state<'idle' | 'confirming' | 'deploying' | 'complete' | 'error'>('idle');
	let currentStep = $state<StepProgress | null>(null);
	let steps = $state<StepProgress[]>([]);
	let errorMessage = $state('');
	let copied = $state(false);

	const confirmDestructive = $derived($appSettings.confirmDestructive);

	function getStepIcon(status: string) {
		switch (status) {
			case 'connecting': return Link;
			case 'cloning':    return GitBranch;
			case 'fetching':   return GitBranch;
			case 'reading':    return FileCode;
			case 'env':        return Database;
			case 'secrets':    return KeyRound;
			case 'deploying':  return Server;
			case 'complete':   return CheckCircle2;
			case 'error':      return XCircle;
			default:           return Loader2;
		}
	}

	function getStepColor(status: string, isCurrentStep: boolean): string {
		if (status === 'complete') return 'text-green-600 dark:text-green-400';
		if (status === 'error')    return 'text-red-600 dark:text-red-400';
		if (isCurrentStep)         return 'text-violet-600 dark:text-violet-400';
		return 'text-muted-foreground';
	}

	async function startDeploy() {
		steps = [];
		currentStep = null;
		overallStatus = 'deploying';
		errorMessage = '';

		try {
			const response = await fetch(`/api/git/stacks/${stackId}/deploy-stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.error || 'Failed to start deployment');
			}

			const { jobId } = await response.json();

			await watchJob(jobId, (line) => {
				try {
					const data = line.data as StepProgress;
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
					console.error('Failed to process job line:', e);
				}
			});

			if (overallStatus === 'deploying') {
				overallStatus = 'complete';
				onComplete?.();
			}
		} catch (error: any) {
			console.error('Failed to deploy git stack:', error);
			overallStatus = 'error';
			errorMessage = error.message || 'Failed to deploy';
		}
	}

	function handleTriggerClick() {
		if (overallStatus !== 'idle') return;
		if (confirmDestructive) {
			overallStatus = 'confirming';
		} else {
			startDeploy();
		}
		open = true;
	}

	function handleConfirmDeploy() {
		startDeploy();
	}

	function handleCancelConfirm() {
		open = false;
		overallStatus = 'idle';
	}

	function handleClose() {
		if (overallStatus === 'deploying') return;
		open = false;
		overallStatus = 'idle';
		steps = [];
		currentStep = null;
		errorMessage = '';
		copied = false;
	}

	async function copyLogs() {
		const lines = steps.map(s => s.message || s.status);
		if (errorMessage) lines.push(`Error: ${errorMessage}`);
		await navigator.clipboard.writeText(lines.join('\n'));
		copied = true;
		setTimeout(() => { copied = false; }, 2000);
	}

	const progressPercentage = $derived(
		currentStep?.step && currentStep?.totalSteps
			? Math.round((currentStep.step / currentStep.totalSteps) * 100)
			: 0
	);

	const isDeploying = $derived(overallStatus === 'deploying');
</script>

<!-- Trigger wrapper: intercepts click to open the dialog -->
<span role="none" style="display:contents" onclick={handleTriggerClick}>
	{@render children()}
</span>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
	<Dialog.Content
		class="max-w-2xl flex flex-col gap-0 p-0 overflow-hidden"
		showCloseButton={false}
		interactOutsideBehavior={isDeploying ? 'ignore' : 'close'}
		escapeKeydownBehavior={isDeploying ? 'ignore' : 'close'}
	>
		<!-- Header -->
		<div class="px-6 py-4 border-b shrink-0">
			<div class="flex items-center gap-2 min-w-0">
				{#if overallStatus === 'complete'}
					<CheckCircle2 class="w-5 h-5 text-green-500 shrink-0" />
				{:else if overallStatus === 'error'}
					<XCircle class="w-5 h-5 text-red-500 shrink-0" />
				{:else if isDeploying}
					<Loader2 class="w-5 h-5 text-violet-500 animate-spin shrink-0" />
				{:else}
					<Rocket class="w-5 h-5 text-violet-500 shrink-0" />
				{/if}
				<span class="text-base font-semibold">Git deploy</span>
				<code class="text-sm font-normal bg-muted px-1.5 py-0.5 rounded ml-1 truncate">{stackName}</code>
				{#if overallStatus === 'complete'}
					<Badge variant="outline" class="ml-auto shrink-0 text-green-600 border-green-600/30">Complete</Badge>
				{:else if overallStatus === 'error'}
					<Badge variant="outline" class="ml-auto shrink-0 text-red-600 border-red-600/30">Failed</Badge>
				{:else if isDeploying}
					<Badge variant="secondary" class="ml-auto shrink-0 tabular-nums text-xs">
						{#if currentStep?.step && currentStep?.totalSteps}
							{currentStep.step}/{currentStep.totalSteps}
						{:else}
							Deploying...
						{/if}
					</Badge>
				{/if}
			</div>
			{#if isDeploying && currentStep?.totalSteps}
				<div class="mt-3">
					<Progress value={progressPercentage} class="h-1.5 [&>[data-progress]]:bg-violet-600" />
				</div>
			{/if}
		</div>

		<!-- Body: steps log -->
		<div class="overflow-y-auto px-4 py-3" style="max-height: 55vh; min-height: 12rem;">
			{#if overallStatus === 'confirming'}
				<div class="flex items-start gap-3 py-2 px-2">
					<AlertTriangle class="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
					<div class="space-y-1">
						<p class="font-medium">Sync from git?</p>
						<p class="text-sm text-muted-foreground">
							This will pull the latest changes for <strong class="text-foreground">{stackName}</strong>.
							Containers will only restart if the configuration changed.
						</p>
					</div>
				</div>
			{:else if steps.length === 0 && isDeploying}
				<div class="flex items-center gap-3 text-muted-foreground py-2 px-2">
					<Loader2 class="w-4 h-4 animate-spin shrink-0" />
					<span class="text-sm">Initializing...</span>
				</div>
			{:else}
				<div class="space-y-0.5">
					{#each steps as step, index (index)}
						{@const StepIcon = getStepIcon(step.status)}
						{@const isCurrentStep = index === steps.length - 1 && isDeploying}
						<div class="flex items-center gap-3 py-1.5 px-2 rounded-md text-sm hover:bg-muted/40 transition-colors">
							<StepIcon
								class="w-4 h-4 shrink-0 {getStepColor(step.status, isCurrentStep)} {isCurrentStep && step.status !== 'complete' && step.status !== 'error' ? 'animate-spin' : ''}"
							/>
							<span class="{getStepColor(step.status, isCurrentStep)}">
								{step.message || step.status}
							</span>
						</div>
					{/each}
				</div>
			{/if}

			{#if errorMessage}
				<div class="mt-3 mx-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
					<div class="flex items-start gap-2 text-sm text-destructive">
						<AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
						<span class="break-all">{errorMessage}</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div class="px-6 py-4 border-t shrink-0 flex items-center justify-between gap-2">
			<!-- Left: copy / cancel -->
			<div>
				{#if overallStatus === 'confirming'}
					<Button variant="outline" onclick={handleCancelConfirm}>Cancel</Button>
				{:else if steps.length > 0}
					<Button variant="outline" size="sm" onclick={copyLogs} class="gap-1.5">
						{#if copied}
							<Check class="w-3.5 h-3.5" />
							Copied!
						{:else}
							<Copy class="w-3.5 h-3.5" />
							Copy logs
						{/if}
					</Button>
				{/if}
			</div>

			<!-- Right: confirm / close -->
			<div class="flex gap-2">
				{#if overallStatus === 'confirming'}
					<Button onclick={handleConfirmDeploy}>
						<Rocket class="w-4 h-4" />
						Deploy
					</Button>
				{:else}
					<Button
						variant={overallStatus === 'complete' ? 'default' : 'secondary'}
						onclick={handleClose}
						disabled={isDeploying}
					>
						{#if isDeploying}
							<Loader2 class="w-4 h-4 animate-spin" />
							Deploying...
						{:else}
							Close
						{/if}
					</Button>
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
