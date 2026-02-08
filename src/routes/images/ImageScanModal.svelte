<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Download, CheckCircle2, XCircle, ShieldCheck, ShieldAlert, ShieldX, FileText, FileSpreadsheet } from 'lucide-svelte';
	import { currentEnvironment } from '$lib/stores/environment';
	import ScanTab from '$lib/components/ScanTab.svelte';
	import type { ScanResult } from '$lib/components/ScanTab.svelte';

	interface Props {
		open: boolean;
		imageName: string;
		envId?: number | null;
		onClose?: () => void;
		onComplete?: () => void;
	}

	let { open = $bindable(), imageName, envId, onClose, onComplete }: Props = $props();

	// Component ref
	let scanTabRef = $state<ScanTab | undefined>();

	// Track status and results from ScanTab
	let scanStatus = $state<'idle' | 'scanning' | 'complete' | 'error'>('idle');
	let scanResults = $state<ScanResult[]>([]);
	let duration = $state(0);
	let hasStarted = $state(false);

	$effect(() => {
		if (open && imageName && !hasStarted) {
			hasStarted = true;
		}
		if (!open && hasStarted) {
			// Reset when modal closes
			hasStarted = false;
			scanStatus = 'idle';
			scanResults = [];
			duration = 0;
			scanTabRef?.reset();
		}
	});

	function handleScanComplete(results: ScanResult[]) {
		scanResults = results;
		if (results.length > 0 && results[0].scanDuration) {
			duration = results[0].scanDuration;
		}
		onComplete?.();
	}

	function handleScanError(_error: string) {
		// Error is handled by ScanTab display
	}

	function handleStatusChange(status: 'idle' | 'scanning' | 'complete' | 'error') {
		scanStatus = status;
	}

	function handleClose() {
		if (scanStatus !== 'scanning') {
			open = false;
			onClose?.();
		}
	}

	// Export functions
	function downloadFile(content: string, filename: string, mimeType: string) {
		const blob = new Blob([content], { type: mimeType });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	function sanitizeFilename(name: string): string {
		return name.replace(/[/:]/g, '-').replace(/[^a-zA-Z0-9.-]/g, '_');
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function exportToCSV() {
		const activeResult = scanResults[0];
		if (!activeResult) return;

		const headers = ['CVE ID', 'Severity', 'Package', 'Installed Version', 'Fixed Version', 'Description', 'Link'];
		const rows = activeResult.vulnerabilities.map(v => [
			v.id,
			v.severity,
			v.package,
			v.version,
			v.fixedVersion || '',
			(v.description || '').replace(/"/g, '""'),
			v.link || ''
		]);

		const csvContent = [
			headers.join(','),
			...rows.map(row => row.map(cell => `"${cell}"`).join(','))
		].join('\n');

		const filename = `vuln-report-${sanitizeFilename(imageName)}-${activeResult.scanner}-${new Date().toISOString().split('T')[0]}.csv`;
		downloadFile(csvContent, filename, 'text/csv');
	}

	function exportToMarkdown() {
		const activeResult = scanResults[0];
		if (!activeResult) return;

		const summaryParts = [];
		if (activeResult.summary.critical > 0) summaryParts.push(`**${activeResult.summary.critical} Critical**`);
		if (activeResult.summary.high > 0) summaryParts.push(`**${activeResult.summary.high} High**`);
		if (activeResult.summary.medium > 0) summaryParts.push(`${activeResult.summary.medium} Medium`);
		if (activeResult.summary.low > 0) summaryParts.push(`${activeResult.summary.low} Low`);
		if (activeResult.summary.negligible > 0) summaryParts.push(`${activeResult.summary.negligible} Negligible`);
		if (activeResult.summary.unknown > 0) summaryParts.push(`${activeResult.summary.unknown} Unknown`);

		let md = `# Vulnerability Scan Report\n\n`;
		md += `**Image:** \`${imageName}\`\n\n`;
		md += `**Scanner:** ${activeResult.scanner === 'grype' ? 'Grype (Anchore)' : 'Trivy (Aqua Security)'}\n\n`;
		md += `**Duration:** ${formatDuration(activeResult.scanDuration || duration)}\n\n`;
		md += `## Summary\n\n`;
		md += summaryParts.length > 0 ? summaryParts.join(' | ') : 'No vulnerabilities found';
		md += `\n\n**Total:** ${activeResult.vulnerabilities.length} vulnerabilities\n\n`;

		if (activeResult.vulnerabilities.length > 0) {
			const bySeverity: Record<string, typeof activeResult.vulnerabilities> = {};
			for (const vuln of activeResult.vulnerabilities) {
				const sev = vuln.severity.toLowerCase();
				if (!bySeverity[sev]) bySeverity[sev] = [];
				bySeverity[sev].push(vuln);
			}

			const severityOrder = ['critical', 'high', 'medium', 'low', 'negligible', 'unknown'];

			for (const severity of severityOrder) {
				const vulns = bySeverity[severity];
				if (!vulns || vulns.length === 0) continue;

				md += `## ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${vulns.length})\n\n`;

				for (const vuln of vulns) {
					md += `### ${vuln.id}\n\n`;
					md += `- **Package:** \`${vuln.package}\`\n`;
					md += `- **Installed:** \`${vuln.version}\`\n`;
					if (vuln.fixedVersion) {
						md += `- **Fixed in:** \`${vuln.fixedVersion}\`\n`;
					} else {
						md += `- **Fixed in:** *No fix available*\n`;
					}
					if (vuln.link) {
						md += `- **Reference:** [${vuln.id}](${vuln.link})\n`;
					}
					if (vuln.description) {
						md += `\n${vuln.description}\n`;
					}
					md += `\n`;
				}
			}
		}

		md += `---\n\n*Report generated by Dockhand*\n`;

		const filename = `vuln-report-${sanitizeFilename(imageName)}-${activeResult.scanner}-${new Date().toISOString().split('T')[0]}.md`;
		downloadFile(md, filename, 'text/markdown');
	}

	function exportToJSON() {
		const activeResult = scanResults[0];
		if (!activeResult) return;

		const report = {
			image: imageName,
			scanner: activeResult.scanner,
			scanDuration: activeResult.scanDuration || duration,
			summary: activeResult.summary,
			vulnerabilities: activeResult.vulnerabilities
		};

		const jsonContent = JSON.stringify(report, null, 2);
		const filename = `vuln-report-${sanitizeFilename(imageName)}-${activeResult.scanner}-${new Date().toISOString().split('T')[0]}.json`;
		downloadFile(jsonContent, filename, 'application/json');
	}

	const totalVulnerabilities = $derived(
		scanResults.reduce((total, r) => total + r.vulnerabilities.length, 0)
	);

	const hasCriticalOrHigh = $derived(
		scanResults.some(r => r.summary.critical > 0 || r.summary.high > 0)
	);

	const effectiveEnvId = $derived(envId ?? $currentEnvironment?.id ?? null);
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
				{:else if scanStatus === 'complete'}
					<CheckCircle2 class="w-5 h-5 text-green-500" />
				{:else if scanStatus === 'error'}
					<XCircle class="w-5 h-5 text-red-500" />
				{:else}
					<ShieldCheck class="w-5 h-5" />
				{/if}
				Vulnerability scan
				<code class="text-sm font-normal bg-muted px-1.5 py-0.5 rounded ml-1">{imageName}</code>
			</Dialog.Title>
		</Dialog.Header>

		<div class="flex-1 min-h-0 flex flex-col overflow-hidden py-2">
			<ScanTab
				bind:this={scanTabRef}
				{imageName}
				envId={effectiveEnvId}
				autoStart={hasStarted}
				onComplete={handleScanComplete}
				onError={handleScanError}
				onStatusChange={handleStatusChange}
			/>
		</div>

		<Dialog.Footer class="shrink-0 flex justify-between">
			<div class="flex gap-2">
				{#if scanStatus === 'error'}
					<Button variant="outline" onclick={() => scanTabRef?.startScan()}>
						Retry
					</Button>
				{/if}
				{#if scanStatus === 'complete' && scanResults.length > 0 && totalVulnerabilities > 0}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button variant="outline" {...props}>
									<Download class="w-4 h-4" />
									Export
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start">
							<DropdownMenu.Item onclick={exportToMarkdown}>
								<FileText class="w-4 h-4 mr-2 text-blue-500" />
								Markdown report (.md)
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={exportToCSV}>
								<FileSpreadsheet class="w-4 h-4 mr-2 text-green-500" />
								CSV spreadsheet (.csv)
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={exportToJSON}>
								<FileText class="w-4 h-4 mr-2 text-amber-500" />
								JSON data (.json)
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}
			</div>
			<Button
				variant={scanStatus === 'complete' ? 'default' : 'secondary'}
				onclick={handleClose}
				disabled={scanStatus === 'scanning'}
			>
				{#if scanStatus === 'scanning'}
					Scanning...
				{:else}
					Close
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
