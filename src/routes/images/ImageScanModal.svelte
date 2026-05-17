<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Checkbox } from '$lib/components/ui/checkbox';
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
	let activeScanner = $state<'grype' | 'trivy'>('grype');
	let exportGrype = $state(true);
	let exportTrivy = $state(true);
	const hasBothScanners = $derived(scanResults.length > 1);
	const exportResults = $derived(
		scanResults.filter(r =>
			(r.scanner === 'grype' && exportGrype) || (r.scanner === 'trivy' && exportTrivy)
		)
	);

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
		if (exportResults.length === 0) return;

		const headers = ['Scanner', 'CVE ID', 'Severity', 'Package', 'Installed Version', 'Fixed Version', 'Description', 'Link'];
		const rows: string[][] = [];
		for (const result of exportResults) {
			for (const v of result.vulnerabilities) {
				rows.push([
					result.scanner,
					v.id,
					v.severity,
					v.package,
					v.version,
					v.fixedVersion || '',
					(v.description || '').replace(/"/g, '""'),
					v.link || ''
				]);
			}
		}

		const csvContent = [
			headers.join(','),
			...rows.map(row => row.map(cell => `"${cell}"`).join(','))
		].join('\n');

		const scannerSuffix = exportResults.length > 1 ? 'combined' : exportResults[0].scanner;
		const filename = `vuln-report-${sanitizeFilename(imageName)}-${scannerSuffix}-${new Date().toISOString().split('T')[0]}.csv`;
		downloadFile(csvContent, filename, 'text/csv');
	}

	function exportToMarkdown() {
		if (exportResults.length === 0) return;

		let md = `# Vulnerability Scan Report\n\n`;
		md += `**Image:** \`${imageName}\`\n\n`;

		for (const result of exportResults) {
			const scannerLabel = result.scanner === 'grype' ? 'Grype (Anchore)' : 'Trivy (Aqua Security)';

			if (exportResults.length > 1) {
				md += `---\n\n# ${scannerLabel}\n\n`;
			} else {
				md += `**Scanner:** ${scannerLabel}\n\n`;
			}
			md += `**Duration:** ${formatDuration(result.scanDuration || duration)}\n\n`;

			const summaryParts = [];
			if (result.summary.critical > 0) summaryParts.push(`**${result.summary.critical} Critical**`);
			if (result.summary.high > 0) summaryParts.push(`**${result.summary.high} High**`);
			if (result.summary.medium > 0) summaryParts.push(`${result.summary.medium} Medium`);
			if (result.summary.low > 0) summaryParts.push(`${result.summary.low} Low`);
			if (result.summary.negligible > 0) summaryParts.push(`${result.summary.negligible} Negligible`);
			if (result.summary.unknown > 0) summaryParts.push(`${result.summary.unknown} Unknown`);

			md += `## Summary\n\n`;
			md += summaryParts.length > 0 ? summaryParts.join(' | ') : 'No vulnerabilities found';
			md += `\n\n**Total:** ${result.vulnerabilities.length} vulnerabilities\n\n`;

			if (result.vulnerabilities.length > 0) {
				const bySeverity: Record<string, typeof result.vulnerabilities> = {};
				for (const vuln of result.vulnerabilities) {
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
		}

		md += `---\n\n*Report generated by Dockhand*\n`;

		const scannerSuffix = exportResults.length > 1 ? 'combined' : exportResults[0].scanner;
		const filename = `vuln-report-${sanitizeFilename(imageName)}-${scannerSuffix}-${new Date().toISOString().split('T')[0]}.md`;
		downloadFile(md, filename, 'text/markdown');
	}

	function exportToJSON() {
		if (exportResults.length === 0) return;

		const report = exportResults.length === 1
			? {
				image: imageName,
				scanner: exportResults[0].scanner,
				scanDuration: exportResults[0].scanDuration || duration,
				summary: exportResults[0].summary,
				vulnerabilities: exportResults[0].vulnerabilities
			}
			: {
				image: imageName,
				scanners: exportResults.map(r => ({
					scanner: r.scanner,
					scanDuration: r.scanDuration || duration,
					summary: r.summary,
					vulnerabilities: r.vulnerabilities
				}))
			};

		const jsonContent = JSON.stringify(report, null, 2);
		const scannerSuffix = exportResults.length > 1 ? 'combined' : exportResults[0].scanner;
		const filename = `vuln-report-${sanitizeFilename(imageName)}-${scannerSuffix}-${new Date().toISOString().split('T')[0]}.json`;
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
				bind:activeScanner
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
							{#if hasBothScanners}
								<div class="px-2 py-1.5 flex flex-col gap-1">
									<label class="flex items-center gap-2 text-xs cursor-pointer">
										<Checkbox bind:checked={exportGrype} disabled={!exportTrivy} />
										Grype
									</label>
									<label class="flex items-center gap-2 text-xs cursor-pointer">
										<Checkbox bind:checked={exportTrivy} disabled={!exportGrype} />
										Trivy
									</label>
								</div>
								<DropdownMenu.Separator />
							{/if}
							<DropdownMenu.Item onclick={exportToMarkdown} disabled={exportResults.length === 0}>
								<FileText class="w-4 h-4 mr-2 text-blue-500" />
								Markdown report (.md)
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={exportToCSV} disabled={exportResults.length === 0}>
								<FileSpreadsheet class="w-4 h-4 mr-2 text-green-500" />
								CSV spreadsheet (.csv)
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={exportToJSON} disabled={exportResults.length === 0}>
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
