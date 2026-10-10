<script lang="ts">
	import { SUMMARY_SEVERITIES, severityLabel, getSeverityColor } from '$lib/utils/vulnerability';
	import { m } from '$lib/paraglide/messages.js';

	const severityMessages: Record<string, () => string> = {
		critical: m.scanner_severity_critical,
		high: m.scanner_severity_high,
		medium: m.scanner_severity_medium,
		low: m.scanner_severity_low
	};

	interface Props {
		/** Counts keyed by severity (critical/high/medium/low). */
		counts: { critical: number; high: number; medium: number; low: number };
		/** Hide pills whose count is 0 (default: always show all four). */
		hideZero?: boolean;
		/** Pill size preset. */
		size?: 'sm' | 'xs';
		class?: string;
	}

	let { counts, hideZero = false, size = 'sm', class: className = '' }: Props = $props();

	const pad = $derived(size === 'xs' ? 'px-2 py-0.5 text-2xs' : 'px-2.5 py-0.5 text-xs');
	const pills = $derived(
		SUMMARY_SEVERITIES.map((sev) => ({ sev, label: severityMessages[sev]?.() ?? severityLabel(sev), count: counts[sev] }))
			.filter((p) => !hideZero || p.count > 0)
	);
</script>

<div class="flex flex-wrap items-center gap-2 {className}">
	{#each pills as p (p.sev)}
		<span class="inline-flex items-center gap-1.5 rounded-full border font-medium {pad} {getSeverityColor(p.sev)}">
			<span class="tabular-nums font-semibold">{p.count}</span>
			<span>{p.label}</span>
		</span>
	{/each}
</div>
