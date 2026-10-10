<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { m } from '$lib/paraglide/messages.js';

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
		results: ScannerResult[];
	}

	let { results }: Props = $props();
</script>

<div class="flex items-center gap-3 shrink-0">
	{#each results as result}
		<div class="flex items-center gap-1">
			<span class="text-2xs text-muted-foreground">{result.scanner === 'grype' ? 'Grype' : 'Trivy'}:</span>
			{#if (result.critical || 0) > 0}
				<Badge variant="outline" class="px-1 py-0 text-2xs bg-red-500/10 text-red-600 border-red-500/30" title={m.scanner_severity_critical()}>{result.critical}</Badge>
			{/if}
			{#if (result.high || 0) > 0}
				<Badge variant="outline" class="px-1 py-0 text-2xs bg-orange-500/10 text-orange-600 border-orange-500/30" title={m.scanner_severity_high()}>{result.high}</Badge>
			{/if}
			{#if (result.medium || 0) > 0}
				<Badge variant="outline" class="px-1 py-0 text-2xs bg-yellow-500/10 text-yellow-600 border-yellow-500/30" title={m.scanner_severity_medium()}>{result.medium}</Badge>
			{/if}
			{#if (result.low || 0) > 0}
				<Badge variant="outline" class="px-1 py-0 text-2xs bg-blue-500/10 text-blue-600 border-blue-500/30" title={m.scanner_severity_low()}>{result.low}</Badge>
			{/if}
		</div>
	{/each}
</div>
