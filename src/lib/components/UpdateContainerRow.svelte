<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { m } from '$lib/paraglide/messages.js';
	import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2 } from 'lucide-svelte';
	import type { StepType } from '$lib/utils/update-steps';
	import { getStepIcon, getStepLabel, getStepColor } from '$lib/utils/update-steps';
	import ScannerSeverityPills from '$lib/components/ScannerSeverityPills.svelte';

	interface ScannerResult {
		scanner: 'grype' | 'trivy';
		critical: number;
		high: number;
		medium: number;
		low: number;
		negligible?: number;
		unknown?: number;
	}

	interface Props {
		name: string;
		status: StepType;
		error?: string;
		blockReason?: string;
		scannerResults?: ScannerResult[];
		isActive?: boolean;
		showLogs?: boolean;
		isForceUpdating?: boolean;
		onToggleLogs?: () => void;
		onForceUpdate?: () => void;
	}

	let {
		name,
		status,
		error,
		blockReason,
		scannerResults,
		isActive = false,
		showLogs = false,
		isForceUpdating = false,
		onToggleLogs,
		onForceUpdate
	}: Props = $props();

	const StepIcon = $derived(getStepIcon(status));
	const stepLabel = $derived(getStepLabel(status));
	const colorClass = $derived(getStepColor(status));
	const hasToggle = $derived(onToggleLogs !== undefined);
</script>

<div class="flex items-center gap-3 p-3">
	<svelte:component
		this={StepIcon}
		class="w-4 h-4 shrink-0 {colorClass} {isActive ? 'animate-spin' : ''}"
	/>
	<div class="flex-1 min-w-0">
		<div class="font-medium truncate">{name}</div>
		{#if error}
			<div class="text-xs text-red-600 dark:text-red-400 truncate">{error}</div>
		{:else if blockReason}
			<div class="text-xs text-amber-600 dark:text-amber-400 truncate">{blockReason}</div>
		{:else}
			<div class="text-xs text-muted-foreground">{stepLabel}</div>
		{/if}
	</div>

	<!-- Scan result badges -->
	{#if scannerResults && scannerResults.length > 0}
		<ScannerSeverityPills results={scannerResults} />
	{/if}

	<!-- Status/action icons -->
	{#if status === 'done' || status === 'updated'}
		<CheckCircle2 class="w-4 h-4 text-green-600 shrink-0" />
	{:else if status === 'failed'}
		<XCircle class="w-4 h-4 text-red-600 shrink-0" />
	{:else if status === 'blocked' && onForceUpdate}
		{#if isForceUpdating}
			<Loader2 class="w-4 h-4 text-blue-500 shrink-0 animate-spin" />
		{:else}
			<Button
				variant="ghost"
				size="sm"
				class="h-6 px-2 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-950/50"
				onclick={onForceUpdate}
			>
				{m.containers_batchupdate_update_anyway()}
			</Button>
		{/if}
	{/if}

	<!-- Toggle logs button -->
	{#if hasToggle}
		<button
			type="button"
			onclick={onToggleLogs}
			class="p-1 hover:bg-muted rounded cursor-pointer"
			title={showLogs ? m.containers_batchupdate_hide_logs() : m.containers_batchupdate_show_logs()}
		>
			{#if showLogs}
				<ChevronDown class="w-4 h-4 text-muted-foreground" />
			{:else}
				<ChevronRight class="w-4 h-4 text-muted-foreground" />
			{/if}
		</button>
	{/if}
</div>
