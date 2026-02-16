<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import { CircleArrowUp, CheckCircle2, XCircle, Loader2, Circle, Ship, Sparkles, Bug, Wrench, RotateCcw, AlertCircle } from 'lucide-svelte';

	declare const __APP_VERSION__: string | null;

	interface ChangelogEntry {
		version: string;
		date: string;
		changes: Array<{ type: string; text: string }>;
		imageTag?: string;
	}

	interface Props {
		open: boolean;
		currentImage: string;
		newImage: string;
		currentDigest?: string;
		newDigest?: string;
		containerName: string;
		isComposeManaged?: boolean;
		onclose: () => void;
	}

	let { open = $bindable(), currentImage, newImage, currentDigest = '', newDigest = '', containerName, isComposeManaged = false, onclose }: Props = $props();

	// Phase management
	type Phase = 'confirm' | 'preparing' | 'updating' | 'restarting' | 'completed' | 'error';
	let phase = $state<Phase>('confirm');
	let updaterId = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let pollTimer = $state<ReturnType<typeof setTimeout> | null>(null);
	let healthTimer = $state<ReturnType<typeof setTimeout> | null>(null);
	let consecutivePollFailures = $state(0);

	// Release notes
	let releaseNotes = $state<ChangelogEntry[]>([]);
	let loadingNotes = $state(false);

	const currentVersion = __APP_VERSION__?.replace(/^v/, '') || '';

	// All steps in a single unified list
	interface StepState {
		id: string;
		label: string;
		status: 'pending' | 'active' | 'completed' | 'error';
		logs: string[];
		showLogs: boolean;
	}

	const ALL_STEPS = [
		// Preparation (from SSE)
		{ id: 'pulling_image', label: 'Pulling new image' },
		{ id: 'building_config', label: 'Building container config' },
		{ id: 'pulling_updater', label: 'Pulling updater' },
		{ id: 'creating_container', label: 'Creating new container' },
		{ id: 'launching_updater', label: 'Launching updater' },
		// Update (from updater container logs)
		{ id: 'stopping', label: 'Stopping Dockhand' },
		{ id: 'removing', label: 'Removing old container' },
		{ id: 'renaming', label: 'Renaming container' },
		{ id: 'connecting', label: 'Connecting networks' },
		{ id: 'starting', label: 'Starting Dockhand' },
		// Reconnect
		{ id: 'reconnecting', label: 'Waiting for Dockhand' }
	] as const;

	// Updater log markers → step id mapping
	const UPDATER_STEP_MARKERS: { start: string; end: string; id: string }[] = [
		{ start: 'Stopping container', end: 'Container stopped', id: 'stopping' },
		{ start: 'Removing old container', end: 'Old container removed', id: 'removing' },
		{ start: 'Renaming container', end: 'Container renamed', id: 'renaming' },
		{ start: 'Connecting to network', end: 'Networks connected', id: 'connecting' },
		{ start: 'Starting container', end: 'Container is running', id: 'starting' }
	];

	let steps = $state<StepState[]>(ALL_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending', logs: [], showLogs: false })));
	let scrollTick = $state(0);
	let stepsListEl = $state<HTMLDivElement | null>(null);

	// Auto-scroll steps list
	$effect(() => {
		scrollTick;
		if (stepsListEl) {
			requestAnimationFrame(() => {
				stepsListEl?.scrollTo({ top: stepsListEl.scrollHeight, behavior: 'smooth' });
			});
		}
	});

	// Fetch release notes when dialog opens
	$effect(() => {
		if (open) {
			fetchReleaseNotes();
		} else {
			if (phase === 'confirm' || phase === 'completed' || phase === 'error') {
				resetState();
			}
		}
	});

	function resetState() {
		phase = 'confirm';
		updaterId = null;
		errorMessage = null;
		consecutivePollFailures = 0;
		releaseNotes = [];
		lastParsedLogCount = 0;
		steps = ALL_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending', logs: [], showLogs: false }));
		stopPolling();
	}

	function stopPolling() {
		if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
		if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; }
	}

	function getStep(id: string): StepState | undefined {
		return steps.find(s => s.id === id);
	}

	function setStepStatus(id: string, status: StepState['status']) {
		const step = getStep(id);
		if (step) {
			step.status = status;
			steps = [...steps];
			scrollTick++;
		}
	}

	function addStepLog(id: string, message: string) {
		const step = getStep(id);
		if (step) {
			step.logs = [...step.logs, message];
			step.showLogs = true;
			steps = [...steps];
			scrollTick++;
		}
	}

	/** Find the currently active step id */
	function activeStepId(): string | null {
		const active = steps.find(s => s.status === 'active');
		return active?.id ?? null;
	}

	async function fetchReleaseNotes() {
		loadingNotes = true;
		try {
			const response = await fetch(
				'https://raw.githubusercontent.com/Finsys/dockhand/main/src/lib/data/changelog.json',
				{ signal: AbortSignal.timeout(5000) }
			);

			if (response.ok) {
				const changelog: ChangelogEntry[] = await response.json();
				if (currentVersion && changelog.length > 0) {
					const newer = changelog.filter(entry => compareVersions(entry.version, currentVersion) > 0);
					releaseNotes = newer.length > 0 ? newer : changelog.slice(0, 1);
				} else if (changelog.length > 0) {
					releaseNotes = changelog.slice(0, 1);
				}
			}
		} catch {
			// Non-critical
		}
		loadingNotes = false;
	}

	function compareVersions(a: string, b: string): number {
		const pa = a.replace(/^v/, '').split('.').map(Number);
		const pb = b.replace(/^v/, '').split('.').map(Number);
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const va = pa[i] || 0;
			const vb = pb[i] || 0;
			if (va > vb) return 1;
			if (va < vb) return -1;
		}
		return 0;
	}

	function getChangeIcon(type: string) {
		switch (type) {
			case 'feature': return Sparkles;
			case 'fix': return Bug;
			case 'improvement': return Wrench;
			default: return Wrench;
		}
	}

	function getChangeColor(type: string): string {
		switch (type) {
			case 'feature': return 'text-emerald-500';
			case 'fix': return 'text-amber-500';
			case 'improvement': return 'text-blue-500';
			default: return 'text-muted-foreground';
		}
	}

	// --- Update Flow ---

	async function startUpdate() {
		phase = 'preparing';
		errorMessage = null;
		steps = ALL_STEPS.map(s => ({ id: s.id, label: s.label, status: 'pending', logs: [], showLogs: false }));

		try {
			const response = await fetch('/api/self-update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ newImage })
			});

			// Check for JSON error response (fail-fast validation)
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('application/json')) {
				const data = await response.json();
				phase = 'error';
				errorMessage = data.error || 'Update failed';
				return;
			}

			// It's an SSE stream
			if (!response.body) {
				phase = 'error';
				errorMessage = 'No response body';
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				let eventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) {
						eventType = line.substring(7).trim();
					} else if (line.startsWith('data: ')) {
						const data = JSON.parse(line.substring(6));
						handleSSEEvent(eventType, data);
					}
				}
			}
		} catch (err) {
			if (phase === 'preparing') {
				phase = 'error';
				errorMessage = 'Connection lost: ' + String(err);
			}
		}
	}

	function handleSSEEvent(event: string, data: any) {
		if (event === 'step') {
			const stepId = data.step;
			if (data.status === 'completed') {
				setStepStatus(stepId, 'completed');
			} else {
				setStepStatus(stepId, 'active');
			}
		} else if (event === 'log') {
			// Attach log to the currently active step
			const currentId = activeStepId();
			if (currentId) {
				addStepLog(currentId, data.message);
			}
		} else if (event === 'launched') {
			updaterId = data.updaterId;
			phase = 'updating';
			consecutivePollFailures = 0;
			startProgressPolling();
		} else if (event === 'error') {
			phase = 'error';
			errorMessage = data.message || 'Update failed';
			// Mark current active step as error
			const currentId = activeStepId();
			if (currentId) {
				setStepStatus(currentId, 'error');
			}
		}
	}

	function startProgressPolling() {
		pollProgress();
	}

	async function pollProgress() {
		if (!updaterId || phase === 'restarting' || phase === 'completed' || phase === 'error') return;

		try {
			const response = await fetch(`/api/self-update/progress?id=${updaterId}`, {
				signal: AbortSignal.timeout(3000)
			});

			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			const data = await response.json() as {
				logs: string;
				status: 'running' | 'exited' | 'removed';
				exitCode?: number;
			};

			consecutivePollFailures = 0;
			parseLogsIntoSteps(data.logs);

			if (data.status === 'removed') {
				markAllUpdateStepsComplete();
				switchToRestarting();
				return;
			}

			if (data.status === 'exited') {
				if (data.exitCode === 0) {
					markAllUpdateStepsComplete();
					switchToRestarting();
				} else {
					phase = 'error';
					errorMessage = `Updater exited with code ${data.exitCode}`;
					const currentId = activeStepId();
					if (currentId) setStepStatus(currentId, 'error');
				}
				return;
			}

			pollTimer = setTimeout(pollProgress, 1500);
		} catch {
			consecutivePollFailures++;
			if (consecutivePollFailures >= 3) {
				markAllUpdateStepsComplete();
				switchToRestarting();
			} else {
				pollTimer = setTimeout(pollProgress, 2000);
			}
		}
	}

	let lastParsedLogCount = 0;

	function parseLogsIntoSteps(logText: string) {
		if (!logText) return;

		const rawLines = logText.split('\n').filter(l => l.trim());

		// Add new log lines to the appropriate step
		if (rawLines.length > lastParsedLogCount) {
			for (let i = lastParsedLogCount; i < rawLines.length; i++) {
				const line = rawLines[i];
				const cleanLine = line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/, '');

				// Find which step this log belongs to
				let stepId = activeStepId();
				for (const marker of UPDATER_STEP_MARKERS) {
					if (cleanLine.includes(marker.start)) {
						stepId = marker.id;
						break;
					}
				}
				if (stepId) {
					addStepLog(stepId, line);
				}
			}
			lastParsedLogCount = rawLines.length;
		}

		// Update step statuses based on full log
		let currentStepIdx = -1;
		for (const line of rawLines) {
			const cleanLine = line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/, '');

			for (let i = 0; i < UPDATER_STEP_MARKERS.length; i++) {
				const marker = UPDATER_STEP_MARKERS[i];
				if (cleanLine.includes(marker.start)) {
					currentStepIdx = i;
					setStepStatus(marker.id, 'active');
					// Complete all prior updater steps
					for (let j = 0; j < i; j++) {
						setStepStatus(UPDATER_STEP_MARKERS[j].id, 'completed');
					}
					break;
				}
			}

			if (currentStepIdx >= 0) {
				const marker = UPDATER_STEP_MARKERS[currentStepIdx];
				if (cleanLine.includes(marker.end)) {
					setStepStatus(marker.id, 'completed');
				}
			}
		}
	}

	function markAllUpdateStepsComplete() {
		for (const marker of UPDATER_STEP_MARKERS) {
			setStepStatus(marker.id, 'completed');
		}
	}

	function switchToRestarting() {
		phase = 'restarting';
		stopPolling();
		setStepStatus('reconnecting', 'active');
		startHealthPolling();
	}

	function startHealthPolling() {
		pollHealth();
	}

	async function pollHealth() {
		if (phase !== 'restarting') return;

		try {
			const response = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
			if (response.ok) {
				phase = 'completed';
				const step = getStep('reconnecting');
				if (step) {
					step.label = 'Dockhand is back online';
					step.status = 'completed';
					steps = [...steps];
				}
				return;
			}
		} catch {
			// Still down
		}

		healthTimer = setTimeout(pollHealth, 3000);
	}

	function handleClose() {
		if (phase === 'preparing' || phase === 'updating' || phase === 'restarting') {
			return;
		}
		stopPolling();
		resetState();
		onclose();
	}

	function getIconComponent(status: string) {
		switch (status) {
			case 'completed': return CheckCircle2;
			case 'active': return Loader2;
			case 'error': return XCircle;
			default: return Circle;
		}
	}

	function getIconClass(status: string): string {
		switch (status) {
			case 'completed': return 'text-green-600 dark:text-green-400';
			case 'active': return 'text-blue-600 dark:text-blue-400 animate-spin';
			case 'error': return 'text-red-600 dark:text-red-400';
			default: return 'text-muted-foreground/30';
		}
	}

	const canClose = $derived(phase === 'confirm' || phase === 'completed' || phase === 'error');
	const visibleSteps = $derived(steps.filter(s => s.status !== 'pending'));

	const activeStep = $derived(steps.find(s => s.status === 'active'));
	const completedCount = $derived(steps.filter(s => s.status === 'completed').length);
	const progressPercentage = $derived(Math.round((completedCount / ALL_STEPS.length) * 100));
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
	<Dialog.Content class="max-w-3xl h-[70vh] overflow-hidden flex flex-col" onInteractOutside={(e) => { if (!canClose) e.preventDefault(); }}>
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				<CircleArrowUp class="w-5 h-5 text-amber-500" />
				{#if phase === 'confirm'}
					Update Dockhand
				{:else}
					Updating Dockhand
				{/if}
			</Dialog.Title>
			{#if phase !== 'confirm'}
				<Dialog.Description>
					{#if activeStep}
						<span class="text-primary font-medium">{activeStep.label}...</span>
						<span class="text-muted-foreground ml-2">({completedCount}/{ALL_STEPS.length})</span>
					{:else if phase === 'completed'}
						Update complete
					{:else if phase === 'error'}
						Update failed
					{:else}
						Preparing...
					{/if}
				</Dialog.Description>
			{/if}
		</Dialog.Header>

		{#if phase === 'confirm'}
			<!-- Confirmation View -->
			<div class="space-y-4 py-2 overflow-y-auto min-h-0 flex-1">
				<div class="space-y-2">
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Container</span>
						<span class="font-medium flex items-center gap-1.5">
							<Ship class="w-3.5 h-3.5" />
							{containerName}
						</span>
					</div>
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Image</span>
						<Badge variant="secondary" class="font-mono text-xs">{currentImage}</Badge>
					</div>
					{#if currentDigest || newDigest}
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">Current digest</span>
							<span class="font-mono text-xs text-muted-foreground">{currentDigest ? currentDigest.replace('sha256:', '').slice(0, 12) : 'unknown'}</span>
						</div>
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">New digest</span>
							<span class="font-mono text-xs text-amber-500">{newDigest ? newDigest.replace('sha256:', '').slice(0, 12) : 'unknown'}</span>
						</div>
					{/if}
				</div>

				{#if loadingNotes}
					<div class="flex items-center gap-2 text-sm text-muted-foreground py-2">
						<Loader2 class="w-4 h-4 animate-spin" />
						Loading release notes...
					</div>
				{:else if releaseNotes.length > 0}
					<div class="border rounded-md overflow-hidden">
						<div class="bg-muted/50 px-3 py-2 border-b">
							<p class="text-sm font-medium">What's new</p>
						</div>
						<div class="p-3 space-y-3 max-h-48 overflow-y-auto">
							{#each releaseNotes as entry}
								<div class="space-y-1.5">
									<div class="flex items-center gap-2">
										<Badge variant="outline" class="text-2xs font-mono">v{entry.version}</Badge>
										<span class="text-2xs text-muted-foreground">{entry.date}</span>
									</div>
									<ul class="space-y-1">
										{#each entry.changes as change}
											{@const ChangeIcon = getChangeIcon(change.type)}
											<li class="flex items-start gap-1.5 text-xs">
												<ChangeIcon class="w-3 h-3 mt-0.5 shrink-0 {getChangeColor(change.type)}" />
												<span class="text-muted-foreground">{change.text}</span>
											</li>
										{/each}
									</ul>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if isComposeManaged}
					<div class="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
						<p class="text-xs text-muted-foreground">
							<span class="font-medium text-blue-400">Note:</span> This container is managed by Docker Compose. After update it will continue to work but may lose Compose tracking. Use <code class="text-2xs">docker compose pull && docker compose up -d</code> for Compose-aware updates.
						</p>
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Button variant="outline" onclick={handleClose}>
					Cancel
				</Button>
				<Button onclick={startUpdate}>
					<CircleArrowUp class="w-4 h-4 mr-2" />
					Update now
				</Button>
			</Dialog.Footer>

		{:else}
			<!-- Progress View -->
			<div class="flex-1 min-h-0 space-y-4 py-4 overflow-hidden flex flex-col">
				<!-- Progress bar -->
				<div class="space-y-2 shrink-0">
					<div class="flex items-center justify-between text-sm">
						<span class="text-muted-foreground">Progress</span>
						<Badge variant="secondary">{completedCount}/{ALL_STEPS.length}</Badge>
					</div>
					<Progress value={progressPercentage} class="h-2" />
				</div>

				<!-- Steps list -->
				{#if visibleSteps.length > 0}
					<div bind:this={stepsListEl} class="border rounded-lg divide-y flex-1 min-h-0 overflow-auto">
						{#each visibleSteps as step (step.id)}
							{@const StepIcon = getIconComponent(step.status)}
							{@const hasLogs = step.logs.length > 0}
							<div class="text-sm">
								<!-- Step header -->
								<div class="flex items-center gap-3 p-3">
									<StepIcon class="w-4 h-4 shrink-0 {getIconClass(step.status)}" />
									<div class="flex-1 min-w-0">
										<div class="font-medium">{step.label}</div>
									</div>
									{#if step.status === 'completed'}
										<CheckCircle2 class="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
									{:else if step.status === 'error'}
										<XCircle class="w-4 h-4 text-red-600 shrink-0" />
									{/if}
								</div>

								<!-- Logs (always visible) -->
								{#if hasLogs}
									<div class="bg-muted/50 px-3 py-2 font-mono text-xs border-t overflow-x-hidden">
										{#each step.logs as line}
											<div class="text-muted-foreground break-all">{line}</div>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				<!-- Error message -->
				{#if phase === 'error' && errorMessage}
					<div class="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 p-3 bg-red-50 dark:bg-red-950/30 rounded-lg overflow-hidden shrink-0">
						<AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
						<span class="break-all">{errorMessage}</span>
					</div>
				{/if}
			</div>

			<Dialog.Footer class="shrink-0">
				{#if phase === 'completed'}
					<Button onclick={() => window.location.reload()}>
						<RotateCcw class="w-4 h-4 mr-2" />
						Reload
					</Button>
				{:else if phase === 'error'}
					<Button variant="outline" onclick={handleClose}>
						Close
					</Button>
				{:else}
					<Button variant="outline" disabled>
						<Loader2 class="w-4 h-4 mr-2 animate-spin" />
						Updating...
					</Button>
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
