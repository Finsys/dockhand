<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { CheckCircle2, ExternalLink, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-svelte';

	interface ScanResult {
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

	interface Props {
		results: ScanResult[];
		compact?: boolean;
	}

	let { results, compact = false }: Props = $props();

	let activeTab = $state<'grype' | 'trivy'>(results[0]?.scanner || 'grype');
	let expandedVulns = $state<Set<string>>(new Set());
	let sortBy = $state<'severity' | 'id' | 'package'>('severity');
	let sortDir = $state<'asc' | 'desc'>('asc');

	const SEVERITY_ORDER: Record<string, number> = {
		critical: 0, high: 1, medium: 2, low: 3, negligible: 4, unknown: 5
	};

	const sortedVulns = $derived.by(() => {
		if (!activeResult) return [];
		const vulns = [...activeResult.vulnerabilities];
		vulns.sort((a, b) => {
			if (sortBy === 'severity') {
				const diff = (SEVERITY_ORDER[a.severity.toLowerCase()] ?? 5) - (SEVERITY_ORDER[b.severity.toLowerCase()] ?? 5);
				return sortDir === 'asc' ? diff : -diff;
			}
			const aVal = sortBy === 'id' ? a.id : a.package;
			const bVal = sortBy === 'id' ? b.id : b.package;
			const cmp = (aVal ?? '').localeCompare(bVal ?? '');
			return sortDir === 'asc' ? cmp : -cmp;
		});
		return vulns;
	});

	function toggleSort(column: 'severity' | 'id' | 'package') {
		if (sortBy === column) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
		} else {
			sortBy = column;
			sortDir = 'asc';
		}
	}

	const activeResult = $derived(results.find(r => r.scanner === activeTab) || results[0]);

	function formatDuration(ms?: number): string {
		if (!ms) return '-';
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function getSeverityColor(severity: string): string {
		switch (severity.toLowerCase()) {
			case 'critical':
				return 'bg-red-500/10 text-red-500 border-red-500/30';
			case 'high':
				return 'bg-orange-500/10 text-orange-500 border-orange-500/30';
			case 'medium':
				return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30';
			case 'low':
				return 'bg-blue-500/10 text-blue-500 border-blue-500/30';
			case 'negligible':
			case 'unknown':
			default:
				return 'bg-gray-500/10 text-gray-500 border-gray-500/30';
		}
	}

	function toggleVulnDetails(id: string) {
		if (expandedVulns.has(id)) {
			expandedVulns.delete(id);
		} else {
			expandedVulns.add(id);
		}
		expandedVulns = new Set(expandedVulns);
	}
</script>

{#if results.length === 0}
	<div class="text-sm text-muted-foreground">No scan results available</div>
{:else}
	<div class="flex flex-col gap-2 h-full">
		<!-- Scanner tabs (only if multiple results) -->
		{#if results.length > 1}
			<div class="flex gap-1 border-b shrink-0">
				{#each results as r}
					<button
						class="px-3 py-1.5 text-xs font-medium border-b-2 transition-colors cursor-pointer {activeTab === r.scanner ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
						onclick={() => activeTab = r.scanner}
					>
						{r.scanner === 'grype' ? 'Grype' : 'Trivy'}
						{#if r.summary.critical > 0 || r.summary.high > 0}
							<Badge variant="outline" class="ml-1.5 bg-red-500/10 text-red-500 border-red-500/30 text-xs py-0">
								{r.summary.critical + r.summary.high}
							</Badge>
						{:else}
							<Badge variant="outline" class="ml-1.5 bg-green-500/10 text-green-500 border-green-500/30 text-xs py-0">
								{r.vulnerabilities.length}
							</Badge>
						{/if}
					</button>
				{/each}
			</div>
		{/if}

		{#if activeResult}
			<!-- Summary badges (compact) -->
			<div class="flex flex-wrap items-center gap-1.5 shrink-0">
				{#if activeResult.summary.critical > 0}
					<Badge variant="outline" class="bg-red-500/10 text-red-500 border-red-500/30 text-xs py-0">
						{activeResult.summary.critical} Critical
					</Badge>
				{/if}
				{#if activeResult.summary.high > 0}
					<Badge variant="outline" class="bg-orange-500/10 text-orange-500 border-orange-500/30 text-xs py-0">
						{activeResult.summary.high} High
					</Badge>
				{/if}
				{#if activeResult.summary.medium > 0}
					<Badge variant="outline" class="bg-yellow-500/10 text-yellow-600 border-yellow-500/30 text-xs py-0">
						{activeResult.summary.medium} Medium
					</Badge>
				{/if}
				{#if activeResult.summary.low > 0}
					<Badge variant="outline" class="bg-blue-500/10 text-blue-500 border-blue-500/30 text-xs py-0">
						{activeResult.summary.low} Low
					</Badge>
				{/if}
				{#if activeResult.summary.negligible > 0}
					<Badge variant="outline" class="bg-gray-500/10 text-gray-500 border-gray-500/30 text-xs py-0">
						{activeResult.summary.negligible} Negligible
					</Badge>
				{/if}
				{#if activeResult.summary.unknown > 0}
					<Badge variant="outline" class="bg-gray-500/10 text-gray-500 border-gray-500/30 text-xs py-0">
						{activeResult.summary.unknown} Unknown
					</Badge>
				{/if}
				{#if activeResult.vulnerabilities.length === 0}
					<Badge variant="outline" class="bg-green-500/10 text-green-500 border-green-500/30 text-xs py-0">
						<CheckCircle2 class="w-3 h-3 mr-1" />
						No vulnerabilities
					</Badge>
				{/if}
				<span class="text-xs text-muted-foreground ml-2">
					{activeResult.scanner === 'grype' ? 'Grype' : 'Trivy'} • {activeResult.vulnerabilities.length} total
					{#if activeResult.scanDuration}• {formatDuration(activeResult.scanDuration)}{/if}
				</span>
			</div>

			<!-- Vulnerability list (takes remaining space) -->
			{#if activeResult.vulnerabilities.length > 0 && !compact}
				<div class="border rounded-lg overflow-hidden flex-1 min-h-0 overflow-y-auto">
					<table class="w-full text-xs">
						<thead class="bg-muted sticky top-0">
							<tr>
								<th class="text-left py-1.5 px-2 font-medium w-[22%]">
									<button type="button" class="flex items-center gap-1 hover:text-foreground transition-colors" onclick={() => toggleSort('id')}>
										CVE ID
										{#if sortBy === 'id'}
											{#if sortDir === 'asc'}<ArrowUp class="w-3 h-3" />{:else}<ArrowDown class="w-3 h-3" />{/if}
										{:else}
											<ArrowUpDown class="w-3 h-3 opacity-30" />
										{/if}
									</button>
								</th>
								<th class="text-left py-1.5 px-2 font-medium w-[12%]">
									<button type="button" class="flex items-center gap-1 hover:text-foreground transition-colors" onclick={() => toggleSort('severity')}>
										Severity
										{#if sortBy === 'severity'}
											{#if sortDir === 'asc'}<ArrowUp class="w-3 h-3" />{:else}<ArrowDown class="w-3 h-3" />{/if}
										{:else}
											<ArrowUpDown class="w-3 h-3 opacity-30" />
										{/if}
									</button>
								</th>
								<th class="text-left py-1.5 px-2 font-medium w-[28%]">
									<button type="button" class="flex items-center gap-1 hover:text-foreground transition-colors" onclick={() => toggleSort('package')}>
										Package
										{#if sortBy === 'package'}
											{#if sortDir === 'asc'}<ArrowUp class="w-3 h-3" />{:else}<ArrowDown class="w-3 h-3" />{/if}
										{:else}
											<ArrowUpDown class="w-3 h-3 opacity-30" />
										{/if}
									</button>
								</th>
								<th class="text-left py-1.5 px-2 font-medium w-[18%]">Installed</th>
								<th class="text-left py-1.5 px-2 font-medium w-[20%]">Fixed in</th>
							</tr>
						</thead>
						<tbody>
							{#each sortedVulns as vuln, i}
								<tr
									class="border-t border-muted hover:bg-muted/30 cursor-pointer transition-colors"
									onclick={() => toggleVulnDetails(vuln.id + i)}
								>
									<td class="py-1 px-2">
										<div class="flex items-center gap-1">
											<code class="text-xs">{vuln.id}</code>
											{#if vuln.link}
												<a
													href={vuln.link}
													target="_blank"
													rel="noopener noreferrer"
													onclick={(e) => e.stopPropagation()}
													class="text-muted-foreground hover:text-foreground"
												>
													<ExternalLink class="w-2.5 h-2.5" />
												</a>
											{/if}
										</div>
									</td>
									<td class="py-1 px-2">
										<Badge variant="outline" class="{getSeverityColor(vuln.severity)} text-xs py-0 px-1.5">
											{vuln.severity}
										</Badge>
									</td>
									<td class="py-1 px-2">
										<code class="text-xs">{vuln.package}</code>
									</td>
									<td class="py-1 px-2">
										<code class="text-xs text-muted-foreground">{vuln.version}</code>
									</td>
									<td class="py-1 px-2">
										{#if vuln.fixedVersion}
											<code class="text-xs text-green-600">{vuln.fixedVersion}</code>
										{:else}
											<span class="text-xs text-muted-foreground italic">-</span>
										{/if}
									</td>
								</tr>
								{#if expandedVulns.has(vuln.id + i) && vuln.description}
									<tr class="bg-muted/20">
										<td colspan="5" class="py-1.5 px-2">
											<p class="text-xs text-muted-foreground">{vuln.description}</p>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/if}
	</div>
{/if}
