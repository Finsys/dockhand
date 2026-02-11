<script lang="ts">
	import { tick } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Loader2, AlertCircle, Terminal, Sun, Moon, ShieldCheck, ShieldAlert, ShieldX, Shield } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import ScanResultsView from '../../routes/images/ScanResultsView.svelte';

	export interface ScanResult {
		scanner: 'grype' | 'trivy';
		imageId?: string;
		imageName?: string;
		scanDuration?: number;
		summary: {
			critical: number;
			high: number;
			medium: number;
			low: number;
			negligible: number;
			unknown: number;
		};
		vulnerabilities: Array<{
			id: string;
			severity: string;
			package: string;
			version: string;
			fixedVersion?: string;
			description?: string;
			link?: string;
		}>;
	}

	type ScanStatus = 'idle' | 'scanning' | 'complete' | 'error';

	interface Props {
		imageName: string;
		envId?: number | null;
		autoStart?: boolean;
		onComplete?: (results: ScanResult[]) => void;
		onError?: (error: string) => void;
		onStatusChange?: (status: ScanStatus) => void;
	}

	let {
		imageName,
		envId = null,
		autoStart = false,
		onComplete,
		onError,
		onStatusChange
	}: Props = $props();

	let status = $state<ScanStatus>('idle');
	let results = $state<ScanResult[]>([]);
	let duration = $state(0);

	// Notify parent of status changes
	$effect(() => {
		onStatusChange?.(status);
	});

	let errorMessage = $state('');
	let scanMessage = $state('');
	let outputLines = $state<string[]>([]);
	let outputContainer: HTMLDivElement | undefined;
	let logDarkMode = $state(true);
	let startTime = $state(0);
	let activeTab = $state<'output' | 'results'>('output');
	let hasStarted = $state(false);

	onMount(() => {
		const saved = localStorage.getItem('logTheme');
		if (saved !== null) {
			logDarkMode = saved === 'dark';
		}
	});

	$effect(() => {
		if (autoStart && imageName && !hasStarted && status === 'idle') {
			hasStarted = true;
			startScan();
		}
	});

	function toggleLogTheme() {
		logDarkMode = !logDarkMode;
		localStorage.setItem('logTheme', logDarkMode ? 'dark' : 'light');
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	async function scrollOutputToBottom() {
		await tick();
		if (outputContainer) {
			outputContainer.scrollTop = outputContainer.scrollHeight;
		}
	}

	function addOutputLine(line: string) {
		outputLines = [...outputLines, line];
		scrollOutputToBottom();
	}

	export function reset() {
		status = 'idle';
		results = [];
		errorMessage = '';
		scanMessage = '';
		outputLines = [];
		duration = 0;
		activeTab = 'output';
		hasStarted = false;
	}

	export function getResults(): ScanResult[] {
		return results;
	}

	export function getStatus(): ScanStatus {
		return status;
	}

	export async function startScan() {
		if (!imageName) return;

		status = 'scanning';
		errorMessage = '';
		scanMessage = 'Starting vulnerability scan...';
		outputLines = [];
		startTime = Date.now();
		results = [];

		addOutputLine(`[dockhand] Starting vulnerability scan for ${imageName}`);

		try {
			const url = appendEnvParam('/api/images/scan', envId);
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageName })
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error('No response body');

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						try {
							const data = JSON.parse(line.slice(6));
							handleScanProgress(data);
						} catch (e) {
							// Ignore parse errors
						}
					}
				}
			}

			// If stream ended without complete status
			if (status === 'scanning') {
				duration = Date.now() - startTime;
				status = results.length > 0 ? 'complete' : 'error';
				if (status === 'complete') {
					activeTab = 'results';
					onComplete?.(results);
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			status = 'error';
			addOutputLine(`[error] ${errorMessage}`);
			onError?.(errorMessage);
		}
	}

	function handleScanProgress(data: any) {
		if (data.message) {
			scanMessage = data.message;
			const scanner = data.scanner || 'dockhand';
			addOutputLine(`[${scanner}] ${data.message}`);
		}

		if (data.output) {
			const scanner = data.scanner || 'dockhand';
			addOutputLine(`[${scanner}] ${data.output}`);
		}

		if (data.stage === 'complete' || data.status === 'complete') {
			duration = Date.now() - startTime;
			status = 'complete';
			if (data.results) {
				results = data.results;
			} else if (data.result) {
				results = [data.result];
			}
			activeTab = 'results';
			onComplete?.(results);
		}

		if (data.stage === 'error' || data.status === 'error') {
			if (!data.scanner) {
				// Global error
				duration = Date.now() - startTime;
				status = 'error';
				errorMessage = data.error || data.message || 'Scan failed';
				onError?.(errorMessage);
			}
		}
	}

	const totalVulnerabilities = $derived(
		results.reduce((total, r) => total + r.vulnerabilities.length, 0)
	);

	const hasCriticalOrHigh = $derived(
		results.some(r => r.summary.critical > 0 || r.summary.high > 0)
	);

	const isScanning = $derived(status === 'scanning');
</script>

<div class="flex flex-col gap-3 flex-1 min-h-0">
	<!-- Status Section -->
	<div class="space-y-2 shrink-0">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2">
				{#if status === 'idle'}
					<Shield class="w-4 h-4 text-muted-foreground" />
					<span class="text-sm text-muted-foreground">Ready to scan</span>
				{:else if status === 'scanning'}
					<Loader2 class="w-4 h-4 animate-spin text-blue-600" />
					<span class="text-sm">Scanning for vulnerabilities...</span>
				{:else if status === 'complete'}
					{#if hasCriticalOrHigh}
						<ShieldX class="w-4 h-4 text-red-500" />
						<span class="text-sm text-red-500">Vulnerabilities found</span>
					{:else if totalVulnerabilities > 0}
						<ShieldAlert class="w-4 h-4 text-yellow-500" />
						<span class="text-sm text-yellow-500">Some vulnerabilities found</span>
					{:else}
						<ShieldCheck class="w-4 h-4 text-green-600" />
						<span class="text-sm text-green-600">No vulnerabilities!</span>
					{/if}
				{:else if status === 'error'}
					<ShieldX class="w-4 h-4 text-red-600" />
					<span class="text-sm text-red-600">Scan failed</span>
				{/if}
			</div>
			<div class="flex items-center gap-3">
				{#if status === 'complete' && results.length > 0}
					<Badge variant={hasCriticalOrHigh ? 'destructive' : totalVulnerabilities > 0 ? 'secondary' : 'outline'} class="text-xs">
						{totalVulnerabilities} vulnerabilities
					</Badge>
				{/if}
				<span class="text-xs text-muted-foreground min-w-12">
					{#if duration > 0}{formatDuration(duration)}{/if}
				</span>
			</div>
		</div>

		<!-- Scan Message -->
		{#if scanMessage && status === 'scanning'}
			<p class="text-xs text-muted-foreground">{scanMessage}</p>
		{/if}

		<!-- Error Message -->
		{#if errorMessage}
			<div class="p-3 rounded-lg bg-destructive/10 border border-destructive/30">
				<div class="flex items-start gap-2">
					<AlertCircle class="w-4 h-4 text-destructive mt-0.5 shrink-0" />
					<span class="text-sm text-destructive break-all">{errorMessage}</span>
				</div>
			</div>
		{/if}
	</div>

	<!-- Idle state with scan button -->
	{#if status === 'idle'}
		<div class="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
			<Shield class="w-12 h-12 opacity-50" />
			<p class="text-sm">Scan <code class="bg-muted px-1.5 py-0.5 rounded">{imageName}</code> for vulnerabilities</p>
			<Button onclick={startScan}>
				<Shield class="w-4 h-4" />
				Start scan
			</Button>
		</div>
	{/if}

	<!-- Scanning/Complete state -->
	{#if status !== 'idle'}
		<!-- Tabs for Output/Results -->
		{#if results.length > 0}
			<div class="flex gap-1 border-b shrink-0">
				<button
					class="px-3 py-1.5 text-xs font-medium border-b-2 transition-colors cursor-pointer {activeTab === 'output' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => activeTab = 'output'}
				>
					<Terminal class="w-3 h-3 inline mr-1" />
					Output
				</button>
				<button
					class="px-3 py-1.5 text-xs font-medium border-b-2 transition-colors cursor-pointer {activeTab === 'results' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => activeTab = 'results'}
				>
					{#if hasCriticalOrHigh}
						<ShieldX class="w-3 h-3 inline mr-1 text-red-500" />
					{:else if totalVulnerabilities > 0}
						<ShieldAlert class="w-3 h-3 inline mr-1 text-yellow-500" />
					{:else}
						<ShieldCheck class="w-3 h-3 inline mr-1 text-green-500" />
					{/if}
					Scan results
					<Badge variant={hasCriticalOrHigh ? 'destructive' : 'secondary'} class="ml-1 text-2xs py-0">
						{totalVulnerabilities}
					</Badge>
				</button>
			</div>
		{/if}

		<!-- Tab Content -->
		<div class="flex-1 min-h-0 flex flex-col">
			{#if activeTab === 'output' || results.length === 0}
				<!-- Output Log -->
				<div class="flex items-center justify-between text-xs text-muted-foreground mb-2 shrink-0">
					<div class="flex items-center gap-2">
						<Terminal class="w-3.5 h-3.5" />
						<span>Output ({outputLines.length} lines)</span>
					</div>
					<button type="button" onclick={toggleLogTheme} class="p-1 rounded hover:bg-muted transition-colors cursor-pointer" title="Toggle log theme">
						{#if logDarkMode}
							<Sun class="w-3.5 h-3.5" />
						{:else}
							<Moon class="w-3.5 h-3.5" />
						{/if}
					</button>
				</div>
				<div
					bind:this={outputContainer}
					class="{logDarkMode ? 'bg-zinc-950 text-zinc-300' : 'bg-zinc-100 text-zinc-700'} rounded-lg p-3 font-mono text-xs flex-1 min-h-0 overflow-auto"
				>
					{#each outputLines as line}
						<div class="whitespace-pre-wrap break-all leading-relaxed flex items-start gap-1.5">
							{#if line.startsWith('[grype]')}
								<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-violet-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">grype</span>
								<span>{line.slice(8)}</span>
							{:else if line.startsWith('[trivy]')}
								<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-teal-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">trivy</span>
								<span>{line.slice(8)}</span>
							{:else if line.startsWith('[dockhand]')}
								<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-slate-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">dockhand</span>
								<span>{line.slice(11)}</span>
							{:else if line.startsWith('[scan]')}
								<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-violet-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">scan</span>
								<span>{line.slice(7)}</span>
							{:else if line.startsWith('[error]')}
								<span class="inline-flex items-center px-1 rounded text-[8px] font-medium bg-red-500 text-white shadow-[0_1px_1px_rgba(0,0,0,0.2)] shrink-0 mt-[3px]">error</span>
								<span class="text-red-400">{line.slice(8)}</span>
							{:else}
								<span>{line}</span>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<!-- Scan Results -->
				<div class="flex-1 min-h-0 overflow-auto">
					<ScanResultsView {results} />
				</div>
			{/if}
		</div>
	{/if}
</div>
