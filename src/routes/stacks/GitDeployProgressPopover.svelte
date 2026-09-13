<script lang="ts">
	import { formatErrorLines } from '$lib/utils/format';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import {
		Rocket,
		Loader2,
		AlertCircle,
		AlertTriangle
	} from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import { appSettings } from '$lib/stores/settings';
	import { watchJob } from '$lib/utils/sse-fetch';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import DeployOutputHeader from './DeployOutputHeader.svelte';
	import { GIT_LINE_MARKER } from '$lib/utils/log-lines';

	interface Props {
		stackId: number;
		stackName: string;
		// Stack icon value (lucide/selfhst/custom) + env, so the header shows the stack's
		// own icon and the target environment -- matching the compose output modal.
		stackIcon?: string | null;
		envId?: number | null;
		// Called when the dialog closes after a deploy ran, not when the deploy completes:
		// this component is embedded in a table row, so refreshing the list mid-deploy
		// would remount it and drop its open dialog.
		onComplete?: () => void;
		children: Snippet;
	}

	let { stackId, stackName, stackIcon = null, envId = null, onComplete, children }: Props = $props();

	let deployFinished = $state(false);

	// The deploy-stream job emits these fields; the UI reads status/message/error/logLine
	// (step/totalSteps are still sent by the server but no longer rendered as steps).
	interface StepProgress {
		status: 'connecting' | 'cloning' | 'fetching' | 'reading' | 'env' | 'secrets' | 'deploying' | 'complete' | 'error';
		message?: string;
		error?: string;
		// A raw (already redacted) compose output line.
		logLine?: string;
	}

	let open = $state(false);
	let overallStatus = $state<'idle' | 'confirming' | 'deploying' | 'complete' | 'error'>('idle');
	// Everything the deploy emits -- git stage messages AND compose output -- lands in
	// one log stream (matching the compose output modal), so there is no separate step
	// list. Git stage lines carry the GIT_LINE_MARKER so LogViewer draws a git glyph.
	let logLines = $state<string[]>([]);
	let errorMessage = $state('');

	const confirmDestructive = $derived($appSettings.confirmDestructive);

	// Close the log with a colored status line once the deploy settles, matching the
	// compose output modal. LogViewer colors via ansi_to_html; the ESC byte is built
	// from its code point to keep the source ASCII.
	const ANSI = {
		green: String.fromCharCode(27) + '[32m',
		red: String.fromCharCode(27) + '[31m',
		reset: String.fromCharCode(27) + '[0m'
	};
	let logText = $derived.by(() => {
		const base = logLines.join('\n');
		if (overallStatus !== 'complete' && overallStatus !== 'error') return base;
		// Match the closing line's indent to the log's own lines (compose prefixes a
		// space, other producers don't) so it lines up with the text, not the edge.
		const lastReal = [...logLines].reverse().find((l) => l.trim().length > 0);
		const indent = lastReal ? (lastReal.match(/^\s*/)?.[0] ?? '') : '';
		const [color, label] = overallStatus === 'complete' ? [ANSI.green, 'Succeeded'] : [ANSI.red, 'Failed'];
		return base + (base ? '\n' : '') + indent + color + label + ANSI.reset;
	});

	// The log viewer follows the app-wide light/dark switch (source of truth: the `.dark`
	// class on <html>). Read it each time the dialog opens so it tracks the current theme,
	// not whatever it was when this page-root component first mounted.
	let logTheme = $state<'light' | 'dark'>('dark');
	function currentAppTheme(): 'light' | 'dark' {
		if (typeof document !== 'undefined') {
			return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
		}
		return 'dark';
	}
	$effect(() => {
		if (open) logTheme = currentAppTheme();
	});

	async function startDeploy() {
		logLines = [];
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
					// Compose output line: append verbatim.
					if (typeof data.logLine === 'string') {
						logLines = [...logLines, data.logLine];
						return;
					}
					if (data.status === 'complete') {
						// Keep the final "Successfully deployed ..." line -- no git icon, it's
						// a compose-side boundary, not a git operation.
						if (typeof data.message === 'string') {
							logLines = [...logLines, data.message];
						}
						overallStatus = 'complete';
						deployFinished = true;
					} else if (data.status === 'error') {
						overallStatus = 'error';
						errorMessage = data.error || 'Unknown error occurred';
						// Put the reason in the log too (as plain, uniconed lines) so a
						// failure that happens mid-stream shows WHY, not just "Failed".
						for (const l of errorMessage.split('\n')) {
							if (l.trim()) logLines = [...logLines, l];
						}
						deployFinished = true;
					} else if (typeof data.message === 'string') {
						// Only the actual git stages (clone/fetch/read) get the git glyph; the
						// "Deploying <stack>..." boundary is compose-side, so it stays plain.
						const isGitStage = ['connecting', 'cloning', 'fetching', 'reading'].includes(data.status);
						logLines = [...logLines, (isGitStage ? GIT_LINE_MARKER : '') + data.message];
					}
				} catch (e) {
					console.error('Failed to process job line:', e);
				}
			});

			if (overallStatus === 'deploying') {
				overallStatus = 'complete';
				deployFinished = true;
			}
		} catch (error: any) {
			console.error('Failed to deploy git stack:', error);
			overallStatus = 'error';
			errorMessage = error.message || 'Failed to deploy';
			deployFinished = true;
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
		logLines = [];
		errorMessage = '';
		// Refresh the list on close, not on complete (see onComplete's doc).
		if (deployFinished) {
			deployFinished = false;
			onComplete?.();
		}
	}

	const isDeploying = $derived(overallStatus === 'deploying');

	// Map the popover's status to the shared header's state + status text.
	const headerState = $derived<'idle' | 'running' | 'complete' | 'error'>(
		overallStatus === 'complete' ? 'complete'
			: overallStatus === 'error' ? 'error'
			: isDeploying ? 'running'
			: 'idle'
	);
	const headerStatusLine = $derived(
		overallStatus === 'complete' ? 'Succeeded'
			: overallStatus === 'error' ? 'Failed'
			: isDeploying ? 'Deploying...'
			: ''
	);

	// Compact while confirming (just a prompt); wide + tall once a deploy runs and the
	// full log needs room. Matches the compose output modal's size in the deploy state.
	const isConfirming = $derived(overallStatus === 'confirming');
	const contentSizeClass = $derived(
		isConfirming
			? 'max-w-lg'
			: 'max-w-[min(90rem,calc(100vw-4rem))] h-[85vh]'
	);
</script>

<!-- Trigger wrapper: intercepts click to open the dialog -->
<span role="none" style="display:contents" onclick={handleTriggerClick}>
	{@render children()}
</span>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
	<Dialog.Content
		class="{contentSizeClass} flex flex-col gap-0 p-0 overflow-hidden"
		showCloseButton={false}
		interactOutsideBehavior={isDeploying ? 'ignore' : 'close'}
		escapeKeydownBehavior={isDeploying ? 'ignore' : 'close'}
	>
		<!-- Header -->
		<div class="px-6 py-4 border-b shrink-0">
			<DeployOutputHeader
				verb="Git deploy"
				{stackName}
				{stackIcon}
				{envId}
				state={headerState}
				statusLine={headerStatusLine}
			/>
		</div>

		<!-- Body: one log stream (git stages + compose output), filling the dialog -->
		<div class="flex-1 min-h-0 flex flex-col px-4 py-3">
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
			{:else if logLines.length === 0 && isDeploying}
				<div class="flex items-center gap-3 text-muted-foreground py-2 px-2">
					<Loader2 class="w-4 h-4 animate-spin shrink-0" />
					<span class="text-sm">Initializing...</span>
				</div>
			{/if}

			{#if logLines.length > 0}
				<div class="flex-1 min-h-0">
					<LogViewer
						logs={logText}
						title={`${stackName}-git-deploy`}
						autoRefresh={false}
						autoScroll={isDeploying}
						class="h-full"
						theme={logTheme}
					/>
				</div>
			{/if}

			{#if errorMessage && logLines.length === 0}
				<!-- Only when the log itself doesn't already carry the reason (e.g. a throw
				     before any compose output) -- otherwise this box just duplicates it. -->
				<div class="mt-3 mx-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
					<div class="flex items-start gap-2 text-sm text-destructive">
						<AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
						<span class="whitespace-pre-wrap break-words">{formatErrorLines(errorMessage)}</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div class="px-6 py-4 border-t shrink-0 flex items-center justify-between gap-2">
			<!-- Left: cancel (confirm step only). The log has its own copy button. -->
			<div>
				{#if overallStatus === 'confirming'}
					<Button variant="outline" onclick={handleCancelConfirm}>Cancel</Button>
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
