<script lang="ts">
	import { DataGrid } from '$lib/components/data-grid';
	import { Badge } from '$lib/components/ui/badge';
	import { appendEnvParam } from '$lib/stores/environment';
	import { getSeverityColor } from '$lib/utils/vulnerability';
	import type { Finding, FindingContainer, VulnerabilitySummary as Summary, SortField } from '$lib/utils/vulnerability';
	import { formatDateTime } from '$lib/stores/settings';
	import { goto } from '$app/navigation';
	import ContainerInspectModal from '../containers/ContainerInspectModal.svelte';
	import SeveritySummaryPills from '$lib/components/SeveritySummaryPills.svelte';
	import {
		ShieldCheck, ExternalLink,
		ArrowUp, ArrowDown, ArrowUpDown, ShieldAlert, Box, Layers, NotepadText
	} from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		envId: number | null;
		scannerEnabled: boolean;
		// Server-windowed data + sort state are owned by the page (toolbar is in the header).
		findings: Finding[];
		summary: Summary;
		loading: boolean;
		/** Sliding-window: absolute index of findings[0] and the full row count. */
		dataOffset?: number;
		virtualTotal?: number;
		sortField?: SortField;
		sortDirection?: 'asc' | 'desc';
		/** The grid scrolled outside the loaded window — shift it to this row. */
		onWindowShift?: (targetStart: number) => void;
		/** A grid header sort click — the page refetches from the server. */
		onSortChange?: (field: SortField, direction: 'asc' | 'desc') => void;
		/** Reports the visible row range for the header counter. */
		onRangeChange?: (start: number, end: number) => void;
	}

	let {
		envId,
		scannerEnabled,
		findings,
		summary,
		loading,
		dataOffset = 0,
		virtualTotal,
		sortField = 'severity',
		sortDirection = 'asc',
		onWindowShift,
		onSortChange,
		onRangeChange
	}: Props = $props();

	// Container inspect modal
	let showInspectModal = $state(false);
	let inspectContainerId = $state('');
	let inspectContainerName = $state('');

	function inspectContainer(c: FindingContainer) {
		inspectContainerId = c.id;
		inspectContainerName = c.name;
		showInspectModal = true;
	}

	function openStack(stack: string) {
		goto(appendEnvParam(`/stacks?search=${encodeURIComponent(stack)}`, envId));
	}

	function toggleSort(field: SortField) {
		const dir = field === sortField && sortDirection === 'asc' ? 'desc' : 'asc';
		onSortChange?.(field, dir);
	}

</script>

<div class="flex-1 min-h-0 flex flex-col gap-2">
	<!-- Summary row: scanned count + severity pills -->
	<div class="shrink-0 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
		<span>{m.images_scan_tab_images_scanned()} <span class="font-medium text-foreground">{summary.imagesScanned}/{summary.totalImages}</span></span>
		<span>{m.images_scan_tab_total()} <span class="font-medium text-foreground">{summary.total}</span></span>
		<SeveritySummaryPills counts={summary} />
	</div>

	{#if !scannerEnabled}
		<div class="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-2 text-muted-foreground">
			<ShieldAlert class="w-10 h-10 opacity-40" />
			<p class="text-sm">{m.images_scan_tab_no_scanner()}</p>
			<a href="/settings?tab=environments" class="text-sm text-primary hover:underline">{m.images_scan_tab_configure_scanner()}</a>
		</div>
	{:else}
		{#if !loading && findings.length === 0}
			<div class="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-2 text-muted-foreground">
				<ShieldCheck class="w-10 h-10 opacity-40" />
				<p class="text-sm">{m.images_scan_tab_no_vulnerabilities()}</p>
				<p class="text-xs">{m.images_scan_tab_empty_hint()}</p>
			</div>
		{:else}
			<div class="flex-1 min-h-0 flex flex-col">
				<!-- Findings arrive already filtered + sorted + paged from the server. -->
				<DataGrid
					data={findings}
					keyField="key"
					gridId="vulnerabilities"
					virtualScroll
					windowed
					loading={loading}
					windowOffset={dataOffset}
					windowTotal={virtualTotal}
					onWindowShift={onWindowShift}
					wrapperClass="border rounded-lg"
					sortState={{ field: sortField, direction: sortDirection }}
					onSortChange={(state) => onSortChange?.(state.field as SortField, state.direction)}
					onVisibleRangeChange={(start, end) => onRangeChange?.(start, end)}
				>
					{#snippet headerCell(column, sortState)}
						{#if column.sortable}
							<button
								type="button"
								onclick={() => toggleSort((column.sortField ?? column.id) as SortField)}
								class="flex items-center gap-1 hover:text-foreground transition-colors w-full"
							>
								{column.label}
								{#if sortState?.field === (column.sortField ?? column.id)}
									{#if sortState.direction === 'asc'}
										<ArrowUp class="w-3 h-3" />
									{:else}
										<ArrowDown class="w-3 h-3" />
									{/if}
								{:else}
									<ArrowUpDown class="w-3 h-3 opacity-30" />
								{/if}
							</button>
						{:else}
							{column.label}
						{/if}
					{/snippet}
					{#snippet cell(column, finding)}
						{#if column.id === 'cve'}
							{#snippet cveLink(extra: Record<string, unknown> = {})}
								<a
									href={finding.link || `https://nvd.nist.gov/vuln/detail/${finding.cve}`}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 font-mono text-xs text-blue-500 hover:underline"
									{...extra}
								>
									{finding.cve}
									<ExternalLink class="w-3 h-3 opacity-60" />
								</a>
							{/snippet}
							{#if finding.description}
								<Tooltip.Root>
									<Tooltip.Trigger>
										{#snippet child({ props })}
											{@render cveLink(props)}
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content side="right" class="w-[28rem] max-w-[90vw] text-left">
										<div class="flex gap-2">
											<NotepadText class="w-4 h-4 mt-0.5 shrink-0 opacity-70" />
											<p class="text-xs leading-relaxed text-left [text-wrap:normal]">{finding.description}</p>
										</div>
									</Tooltip.Content>
								</Tooltip.Root>
							{:else}
								{@render cveLink()}
							{/if}
						{:else if column.id === 'package'}
							<span class="font-mono text-xs truncate" title={finding.package}>{finding.package}</span>
						{:else if column.id === 'severity'}
							<Badge variant="outline" class="{getSeverityColor(finding.severity)} text-xs py-0 px-1.5">
								{finding.severity}
							</Badge>
						{:else if column.id === 'installed'}
							<span class="font-mono text-xs truncate" title={finding.installedVersion}>{finding.installedVersion}</span>
						{:else if column.id === 'fixed'}
							{#if finding.fixedVersion}
								<span class="font-mono text-xs truncate" title={finding.fixedVersion}>{finding.fixedVersion}</span>
							{:else}
								<span class="text-xs text-muted-foreground">{m.images_scan_tab_no_fix()}</span>
							{/if}
						{:else if column.id === 'image'}
							<span class="font-mono text-xs truncate" title={finding.imageName}>{finding.imageName}</span>
						{:else if column.id === 'container'}
							{#if finding.containers && finding.containers.length}
								<div class="flex items-center gap-1 min-w-0">
									<button
										type="button"
										onclick={() => inspectContainer(finding.containers![0])}
										class="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline truncate"
										title={m.images_scan_tab_inspect_container({ name: finding.containers[0].name })}
									>
										<Box class="w-3 h-3 shrink-0 opacity-70" />
										<span class="truncate">{finding.containers[0].name}</span>
									</button>
									{#if finding.containers.length > 1}
										<Badge variant="secondary" class="text-2xs px-1 py-0 h-4 shrink-0" title={finding.containers.map((c) => c.name).join(', ')}>
											+{finding.containers.length - 1}
										</Badge>
									{/if}
								</div>
							{:else}
								<span class="text-xs text-muted-foreground">—</span>
							{/if}
						{:else if column.id === 'stack'}
							{#if finding.stacks && finding.stacks.length}
								<button
									type="button"
									onclick={() => openStack(finding.stacks![0])}
									class="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline truncate"
									title={m.images_scan_tab_view_stack({ name: finding.stacks[0] })}
								>
									<Layers class="w-3 h-3 shrink-0 opacity-70" />
									<span class="truncate">{finding.stacks[0]}</span>
								</button>
							{:else}
								<span class="text-xs text-muted-foreground">—</span>
							{/if}
						{:else if column.id === 'scannedAt'}
							{#if finding.scannedAt}
								<span class="text-xs text-muted-foreground whitespace-nowrap" title={finding.scannedAt}>{formatDateTime(finding.scannedAt)}</span>
							{:else}
								<span class="text-xs text-muted-foreground">—</span>
							{/if}
						{/if}
					{/snippet}
				</DataGrid>
			</div>
		{/if}
	{/if}
</div>

<ContainerInspectModal
	bind:open={showInspectModal}
	containerId={inspectContainerId}
	containerName={inspectContainerName}
/>
