<script lang="ts">
	import { pullLogStatus } from '$lib/utils/pull-warning';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';

	import { CircleArrowUp, Loader2, AlertCircle, CheckCircle2, XCircle, ChevronDown, ChevronRight, ExternalLink } from 'lucide-svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { untrack } from 'svelte';
	import type { VulnerabilityCriteria } from '$lib/server/db';
	import type { StepType } from '$lib/utils/update-steps';
	import { getStepLabel, getStepIcon, getStepColor } from '$lib/utils/update-steps';
	import VulnerabilityCriteriaBadge from '$lib/components/VulnerabilityCriteriaBadge.svelte';
	import UpdateSummaryStats from '$lib/components/UpdateSummaryStats.svelte';
	import ScannerSeverityPills from '$lib/components/ScannerSeverityPills.svelte';
	import { watchJob } from '$lib/utils/sse-fetch';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		containerIds: string[];
		containerNames: Map<string, string>;
		envId: number | null;
		vulnerabilityCriteria?: VulnerabilityCriteria;
		onClose: () => void;
		onComplete: (results: { success: string[]; failed: string[]; blocked: string[] }) => void;
	}

	let { open = $bindable(), containerIds, containerNames, envId, vulnerabilityCriteria = 'never', onClose, onComplete }: Props = $props();

	interface PullLogEntry {
		status: string;
		id?: string;
		progress?: string;
	}

	interface ScanLogEntry {
		scanner?: string;
		message: string;
	}

	interface ScanResult {
		critical: number;
		high: number;
		medium: number;
		low: number;
		negligible?: number;
		unknown?: number;
	}

	interface ScannerResult extends ScanResult {
		scanner: 'grype' | 'trivy';
	}

	interface VulnerabilityEntry {
		id: string;
		severity: string;
		package: string;
		version: string;
		fixedVersion?: string;
		link?: string;
		scanner: string;
	}

	interface ContainerProgress {
		containerId: string;
		containerName: string;
		step: StepType;
		success?: boolean;
		error?: string;
		pullLogs: PullLogEntry[];
		scanLogs: ScanLogEntry[];
		scannerResults?: ScannerResult[];
		vulnerabilities?: VulnerabilityEntry[];
		blockReason?: string;
		showLogs: boolean;
	}

	let status = $state<'idle' | 'updating' | 'complete' | 'error'>('idle');
	// Incremented on each close. The startUpdate() poll loop captures the
	// run id at start and stops mutating state once it no longer matches —
	// prevents a stale background poll from clobbering the next run (#1094).
	let runId = 0;
	let progress = $state<ContainerProgress[]>([]);
	let progressListEl = $state<HTMLDivElement | null>(null);
	let scrollTick = $state(0);
	let userScrolledUp = $state(false);
	let currentIndex = $state(0);
	let totalCount = $state(0);
	let summary = $state<{ total: number; success: number; failed: number; blocked: number } | null>(null);
	let errorMessage = $state('');
	let forceUpdating = $state<Set<string>>(new Set()); // Track containers being force-updated
	let filterMode = $state<'updated' | 'failed'>('updated');

	let showFilterButtons = $derived(
		summary && (summary.failed > 0 || summary.blocked > 0) && summary.success > 0
	);

	let filteredProgress = $derived(
		!summary || !showFilterButtons
			? progress
			: filterMode === 'failed'
				? progress.filter(p => p.step === 'failed' || p.step === 'blocked')
				: progress.filter(p => p.step === 'done' || p.success)
	);

	$effect(() => {
		// Only track filterMode, not progress — avoid re-running on every SSE update
		const mode = filterMode;
		if (mode === 'updated') {
			untrack(() => {
				for (const item of progress) {
					item.showLogs = false;
				}
			});
		}
	});

	function formatPullLog(entry: PullLogEntry): string {
		// Clarify potentially confusing Docker messages
		let status = entry.status;
		if (status.toLowerCase().includes('image is up to date')) {
			status = m.containers_batchupdate_image_cached();
		} else if (status.toLowerCase().includes('status: image is up to date')) {
			status = m.containers_batchupdate_image_cached();
		}

		if (entry.id && entry.progress) {
			return `${entry.id}: ${status} ${entry.progress}`;
		}
		if (entry.id) {
			return `${entry.id}: ${status}`;
		}
		return status;
	}

	function formatScanLog(entry: ScanLogEntry): string {
		if (entry.scanner) {
			return `[${entry.scanner}] ${entry.message}`;
		}
		return entry.message;
	}

	async function startUpdate() {
		if (containerIds.length === 0) return;

		const myRunId = ++runId;
		status = 'updating';
		progress = [];
		currentIndex = 0;
		totalCount = containerIds.length;
		summary = null;
		errorMessage = '';

		try {
			const response = await fetch(appendEnvParam('/api/containers/batch-update-stream', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ containerIds, vulnerabilityCriteria })
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.error || m.containers_batchupdate_start_failed());
			}

			const { jobId } = await response.json();
			const successIds: string[] = [];
			const failedIds: string[] = [];
			const blockedIds: string[] = [];

			await watchJob(jobId, (line) => {
				// If the user closed the modal (or started another run), drop the line.
				if (myRunId !== runId) return;
				try {
					const data = line.data as any;
					scrollTick++;

					if (data.type === 'start') {
						totalCount = data.total;
					} else if (data.type === 'progress') {
						currentIndex = data.current;

						// Update or add progress entry
						const existingIndex = progress.findIndex(p => p.containerId === data.containerId);
						if (existingIndex >= 0) {
							progress[existingIndex].step = data.step;
							progress[existingIndex].success = data.success;
							progress[existingIndex].error = data.error;
							progress = [...progress]; // Trigger reactivity
						} else {
							progress = [...progress, {
								containerId: data.containerId,
								containerName: data.containerName,
								step: data.step,
								success: data.success,
								error: data.error,
								pullLogs: [],
								scanLogs: [],
								showLogs: true,
							}];
						}

						// Track success/failed for onComplete callback
						if (data.success === true) {
							successIds.push(data.containerId);
						} else if (data.success === false && data.step === 'failed') {
							failedIds.push(data.containerId);
						}
					} else if (data.type === 'pull_log') {
					const pullStatus = pullLogStatus({ status: data.pullStatus, message: data.pullMessage }) ?? data.pullStatus;
						// Add pull log to the container's log list
						const containerProgress = progress.find(p => p.containerId === data.containerId);
						if (containerProgress) {
							// For layer progress, update existing entry or add new
							if (data.pullId) {
								const existingLog = containerProgress.pullLogs.find((l: any) => l.id === data.pullId);
								if (existingLog) {
									existingLog.status = pullStatus;
									existingLog.progress = data.pullProgress;
								} else {
									containerProgress.pullLogs.push({
										status: pullStatus,
										id: data.pullId,
										progress: data.pullProgress
									});
								}
							} else {
								// General status message (no layer ID)
								containerProgress.pullLogs.push({
									status: pullStatus
								});
							}
							progress = [...progress]; // Trigger reactivity
						}
					} else if (data.type === 'scan_start') {
						// Update step to scanning
						const containerProgress = progress.find(p => p.containerId === data.containerId);
						if (containerProgress) {
							containerProgress.step = 'scanning';
							progress = [...progress];
						}
					} else if (data.type === 'scan_log') {
						// Add scan log to the container's log list
						const containerProgress = progress.find(p => p.containerId === data.containerId);
						if (containerProgress) {
							containerProgress.scanLogs.push({
								scanner: data.scanner,
								message: data.message
							});
							progress = [...progress];
						}
					} else if (data.type === 'scan_complete') {
						// Store scan result, individual scanner results, and vulnerabilities
						const containerProgress = progress.find(p => p.containerId === data.containerId);
						if (containerProgress) {
							// Add combined summary log when multiple scanners were used
							if (data.message && data.scannerResults && data.scannerResults.length > 1) {
								containerProgress.scanLogs.push({ message: data.message });
							}
							containerProgress.scannerResults = data.scannerResults;
							containerProgress.vulnerabilities = data.vulnerabilities;
							progress = [...progress];
						}
					} else if (data.type === 'blocked') {
						// Mark container as blocked
						const existingIndex = progress.findIndex(p => p.containerId === data.containerId);
						if (existingIndex >= 0) {
							progress[existingIndex].step = 'blocked';
							progress[existingIndex].success = false;
							progress[existingIndex].scannerResults = data.scannerResults;
							progress[existingIndex].blockReason = data.blockReason;
							progress = [...progress];
						}
						blockedIds.push(data.containerId);
						currentIndex = data.current;
					} else if (data.type === 'complete') {
						status = 'complete';
						summary = data.summary;
						for (const item of progress) {
							item.showLogs = false;
						}
						onComplete({ success: successIds, failed: failedIds, blocked: blockedIds });
					} else if (data.type === 'error') {
						status = 'error';
						errorMessage = data.error || m.containers_batchupdate_unknown_error();
					}
				} catch (e) {
					console.error('Failed to process job line:', e);
				}
			});
		} catch (error: any) {
			console.error('Failed to update containers:', error);
			if (myRunId !== runId) return;
			status = 'error';
			errorMessage = error.message || m.containers_batchupdate_failed();
		}
	}

	function handleClose() {
		open = false;
		onClose();
		// Invalidate any in-flight poll so its onLine callbacks stop mutating
		// state for this modal instance (#1094).
		runId++;
		// Reset state
		status = 'idle';
		progress = [];
		currentIndex = 0;
		summary = null;
		errorMessage = '';
		filterMode = 'updated';
	}

	function handleOpenChange(isOpen: boolean) {
		// The X button (DialogPrimitive.Close) bypasses controlled close, so
		// returning early here without resetting state strands `status` at
		// 'updating' and the next open of this modal never re-triggers
		// startUpdate() (#1094). Always reset; the in-flight poll loop
		// finishes against the server but the UI is freed.
		if (!isOpen) {
			handleClose();
		}
	}

	function toggleLogs(containerId: string) {
		const item = progress.find(p => p.containerId === containerId);
		if (item) {
			item.showLogs = !item.showLogs;
			progress = [...progress];
		}
	}

const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, negligible: 4, unknown: 5 };

	function sortedVulns(vulns: VulnerabilityEntry[]): VulnerabilityEntry[] {
		return [...vulns].sort((a, b) => (severityOrder[a.severity.toLowerCase()] ?? 9) - (severityOrder[b.severity.toLowerCase()] ?? 9));
	}

	function severityColor(severity: string): string {
		switch (severity.toLowerCase()) {
			case 'critical': return 'bg-red-600 text-white';
			case 'high': return 'bg-orange-500 text-white';
			case 'medium': return 'bg-amber-500 text-white';
			case 'low': return 'bg-blue-500 text-white';
			default: return 'bg-gray-500 text-white';
		}
	}

	async function forceUpdateContainer(containerId: string) {
		const item = progress.find(p => p.containerId === containerId);
		if (!item || item.step !== 'blocked') return;

		// Mark as force-updating
		forceUpdating = new Set([...forceUpdating, containerId]);

		// Reset container state
		item.step = 'pulling';
		item.blockReason = undefined;
		item.pullLogs = [];
		item.scanLogs = [];
		progress = [...progress];

		try {
			const response = await fetch(appendEnvParam('/api/containers/batch-update-stream', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ containerIds: [containerId], vulnerabilityCriteria: 'never' })
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.error || m.containers_batchupdate_start_failed());
			}

			const { jobId } = await response.json();
			await watchJob(jobId, (line) => {
				const data = line.data as any;

				if (data.type === 'progress') {
					item.step = data.step;
					item.success = data.success;
					item.error = data.error;
					progress = [...progress];

					// Update summary if container succeeded
					if (data.success === true && summary) {
						summary.blocked--;
						summary.success++;
						summary = { ...summary };
					}
				} else if (data.type === 'pull_log') {
					const pullStatus = pullLogStatus({ status: data.pullStatus, message: data.pullMessage }) ?? data.pullStatus;
					if (data.pullId) {
						const existingLog = item.pullLogs.find(l => l.id === data.pullId);
						if (existingLog) {
							existingLog.status = pullStatus;
							existingLog.progress = data.pullProgress;
						} else {
							item.pullLogs.push({
								status: pullStatus,
								id: data.pullId,
								progress: data.pullProgress
							});
						}
					} else {
						item.pullLogs.push({ status: pullStatus });
					}
					progress = [...progress];
				}
			});
		} catch (error: any) {
			console.error('Failed to force update container:', error);
			item.step = 'failed';
			item.error = error.message || m.containers_batchupdate_force_failed();
			progress = [...progress];
		} finally {
			forceUpdating = new Set([...forceUpdating].filter(id => id !== containerId));
		}
	}

	const progressPercentage = $derived(
		totalCount > 0 ? Math.round((currentIndex / totalCount) * 100) : 0
	);

	// Start update when modal opens
	$effect(() => {
		if (open && status === 'idle' && containerIds.length > 0) {
			startUpdate();
		}
	});

	// Track whether user has scrolled up to read earlier output
	function handleProgressScroll() {
		if (!progressListEl) return;
		const { scrollTop, scrollHeight, clientHeight } = progressListEl;
		// Consider "at bottom" if within 50px of the end
		userScrolledUp = scrollHeight - scrollTop - clientHeight > 50;
	}

	// Auto-scroll progress list to bottom on SSE data, but only if user hasn't scrolled up
	$effect(() => {
		scrollTick;
		if (progressListEl && !userScrolledUp) {
			requestAnimationFrame(() => {
				progressListEl?.scrollTo({ top: progressListEl.scrollHeight, behavior: 'smooth' });
			});
		}
	});
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-5xl h-[70vh] overflow-hidden flex flex-col" onInteractOutside={(e) => { if (status === 'updating') e.preventDefault(); }}>
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				<CircleArrowUp class="w-5 h-5 text-amber-500" />
				{m.containers_batchupdate_title()}
				{#if vulnerabilityCriteria !== 'never'}
					<span class="ml-2">
						<VulnerabilityCriteriaBadge criteria={vulnerabilityCriteria} />
					</span>
				{/if}
			</Dialog.Title>
			<Dialog.Description>
				{#if status === 'updating'}
					{@const activeContainer = progress.find(p => p.step !== 'done' && p.step !== 'failed' && p.step !== 'blocked')}
					{#if activeContainer}
						<span class="text-primary font-medium">
							{getStepLabel(activeContainer.step)} {activeContainer.containerName}...
						</span>
						<span class="text-muted-foreground ml-2">({currentIndex}/{totalCount})</span>
					{:else}
						{m.containers_batchupdate_processing({ current: currentIndex, total: totalCount })}
					{/if}
				{:else if status === 'complete'}
					{m.containers_batchupdate_status_complete()}
				{:else if status === 'error'}
					{m.containers_batchupdate_status_failed()}
				{:else}
					{m.containers_batchupdate_preparing({ count: containerIds.length })}
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex-1 min-h-0 space-y-4 py-4 overflow-hidden flex flex-col">
			<!-- Progress bar -->
			<div class="space-y-2 shrink-0">
				<div class="flex items-center justify-between text-sm">
					<span class="text-muted-foreground">{m.containers_batchupdate_progress()}</span>
					<Badge variant="secondary">{currentIndex}/{totalCount}</Badge>
				</div>
				<Progress value={progressPercentage} class="h-2" />
			</div>

			<!-- Filter toggle + Container list with status - scrollable area -->
			{#if progress.length > 0}
				{#if showFilterButtons}
					<div class="flex items-center gap-1 shrink-0">
						<Button
							variant={filterMode === 'updated' ? 'default' : 'outline'}
							size="sm"
							class="h-7 text-xs"
							onclick={() => filterMode = 'updated'}
						>
							<CheckCircle2 class="w-3 h-3 mr-1" />
							{m.containers_batchupdate_filter_updated({ count: summary.success })}
						</Button>
						<Button
							variant={filterMode === 'failed' ? 'destructive' : 'outline'}
							size="sm"
							class="h-7 text-xs"
							onclick={() => filterMode = 'failed'}
						>
							<XCircle class="w-3 h-3 mr-1" />
							{m.containers_batchupdate_filter_failed({ count: summary.failed + summary.blocked })}
						</Button>
					</div>
				{/if}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div bind:this={progressListEl} onscroll={handleProgressScroll} class="border rounded-lg divide-y flex-1 min-h-0 overflow-auto">
					{#each filteredProgress as item (item.containerId)}
						{@const StepIcon = getStepIcon(item.step)}
						{@const isActive = item.step !== 'done' && item.step !== 'failed' && item.step !== 'blocked'}
						{@const hasLogs = item.pullLogs.length > 0 || item.scanLogs.length > 0 || (item.vulnerabilities && item.vulnerabilities.length > 0)}
						<div class="text-sm">
							<!-- Container header -->
							<div class="flex items-center gap-3 p-3">
								<StepIcon
									class="w-4 h-4 shrink-0 {getStepColor(item.step)} {isActive ? 'animate-spin' : ''}"
								/>
								<div class="flex-1 min-w-0">
									<div class="font-medium truncate">{item.containerName}</div>
									{#if item.error}
										<div class="text-xs text-red-600 dark:text-red-400 truncate">{item.error}</div>
									{:else if item.blockReason}
										<div class="text-xs text-amber-600 dark:text-amber-400 truncate">{item.blockReason}</div>
									{:else}
										<div class="text-xs text-muted-foreground">{getStepLabel(item.step)}</div>
									{/if}
								</div>

								<!-- Scan result badges per scanner -->
								{#if item.scannerResults && item.scannerResults.length > 0}
									<ScannerSeverityPills results={item.scannerResults} />
								{/if}

								{#if item.success === true}
									<CheckCircle2 class="w-4 h-4 text-green-600 shrink-0" />
								{:else if item.step === 'failed'}
									<XCircle class="w-4 h-4 text-red-600 shrink-0" />
								{:else if item.step === 'blocked'}
									{#if forceUpdating.has(item.containerId)}
										<Loader2 class="w-4 h-4 text-blue-500 shrink-0 animate-spin" />
									{:else}
										<Button
											variant="ghost"
											size="sm"
											class="h-6 px-2 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/50"
											onclick={() => forceUpdateContainer(item.containerId)}
										>
											{m.containers_batchupdate_update_anyway()}
										</Button>
									{/if}
								{/if}
								{#if hasLogs}
									<button
										type="button"
										onclick={() => toggleLogs(item.containerId)}
										class="p-1 hover:bg-muted rounded cursor-pointer"
										title={item.showLogs ? m.containers_batchupdate_hide_logs() : m.containers_batchupdate_show_logs()}
									>
										{#if item.showLogs}
											<ChevronDown class="w-4 h-4 text-muted-foreground" />
										{:else}
											<ChevronRight class="w-4 h-4 text-muted-foreground" />
										{/if}
									</button>
								{/if}
							</div>

							<!-- Pull and Scan logs (collapsible) -->
							{#if item.showLogs && hasLogs}
								<div
									class="bg-muted/50 px-3 py-2 font-mono text-xs border-t overflow-x-hidden"
								>
									{#each item.pullLogs as log}
										<div class="text-muted-foreground break-all">
											{formatPullLog(log)}
										</div>
									{/each}
									{#if item.scanLogs.length > 0}
										{#if item.pullLogs.length > 0}
											<div class="border-t border-dashed my-1 border-muted-foreground/30"></div>
										{/if}
										{#each item.scanLogs as log}
											<div class="text-purple-600 dark:text-purple-400 break-all">
												{formatScanLog(log)}
											</div>
										{/each}
									{/if}
									{#if item.vulnerabilities && item.vulnerabilities.length > 0}
										<div class="border-t border-dashed my-1 border-muted-foreground/30"></div>
										<div class="text-muted-foreground text-[10px] uppercase tracking-wider font-medium mb-1">
											{item.vulnerabilities.length >= 100 ? m.containers_batchupdate_vulnerabilities_found_capped({ count: item.vulnerabilities.length }) : m.containers_batchupdate_vulnerabilities_found({ count: item.vulnerabilities.length })}
										</div>
										<div>
											<table class="w-full">
												<thead>
													<tr class="text-left text-muted-foreground border-b">
														<th class="pb-1 pr-2 font-medium">CVE</th>
														<th class="pb-1 pr-2 font-medium">{m.containers_batchupdate_col_severity()}</th>
														<th class="pb-1 pr-2 font-medium">{m.containers_batchupdate_col_package()}</th>
														<th class="pb-1 pr-2 font-medium">{m.containers_batchupdate_col_version()}</th>
														<th class="pb-1 font-medium">{m.containers_batchupdate_col_fixed()}</th>
													</tr>
												</thead>
												<tbody>
													{#each sortedVulns(item.vulnerabilities).slice(0, 50) as vuln}
														<tr class="border-b border-muted/50">
															<td class="py-1 pr-2 font-mono">
																{#if item.scannerResults && item.scannerResults.length > 1 && vuln.scanner}
																	<Badge variant="outline" class="px-1 py-0 text-[9px] mr-1 {vuln.scanner === 'grype' ? 'border-blue-400 text-blue-500' : 'border-emerald-400 text-emerald-500'}">{vuln.scanner === 'grype' ? 'G' : 'T'}</Badge>
																{/if}
																{#if vuln.link}
																	<a href={vuln.link} target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5">
																		{vuln.id}
																		<ExternalLink class="w-2.5 h-2.5" />
																	</a>
																{:else}
																	{vuln.id}
																{/if}
															</td>
															<td class="py-1 pr-2">
																<span class="inline-block px-1.5 py-0 rounded text-[10px] font-medium {severityColor(vuln.severity)}">
																	{vuln.severity}
																</span>
															</td>
															<td class="py-1 pr-2 font-mono truncate max-w-[150px]">{vuln.package}</td>
															<td class="py-1 pr-2 font-mono truncate max-w-[100px]">{vuln.version}</td>
															<td class="py-1 font-mono truncate max-w-[100px]">{vuln.fixedVersion || '\u2014'}</td>
														</tr>
													{/each}
												</tbody>
											</table>
											{#if item.vulnerabilities.length > 50}
												<div class="text-muted-foreground mt-1">
													{m.containers_batchupdate_and_more({ count: item.vulnerabilities.length - 50 })}
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}

			<!-- Summary - shrink-0 to stay visible -->
			{#if summary}
				<div class="shrink-0 pt-2 border-t">
					<UpdateSummaryStats
						updated={summary.success}
						blocked={summary.blocked}
						failed={summary.failed}
						compact
					/>
				</div>
			{/if}

			<!-- Error message - shrink-0 to stay visible -->
			{#if errorMessage}
				<div class="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 p-3 bg-red-50 dark:bg-red-950/30 rounded-lg overflow-hidden shrink-0">
					<AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
					<span class="break-all">{errorMessage}</span>
				</div>
			{/if}
		</div>

		<Dialog.Footer class="shrink-0">
			{#if status === 'updating'}
				<Button variant="outline" disabled>
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
					{m.containers_batchupdate_updating()}
				</Button>
			{:else}
				<Button variant="outline" onclick={handleClose}>
					{m.ui_close()}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
