<script lang="ts">
	import { ArrowRight } from 'lucide-svelte';
	import { formatFieldName, type AuditDiff, type FieldChange } from '$lib/utils/diff';

	interface Props {
		diff: AuditDiff | null;
	}

	let { diff }: Props = $props();

	function formatDisplayValue(value: any): string {
		if (value === null || value === undefined) {
			return '—';
		}
		if (typeof value === 'boolean') {
			return value ? 'Yes' : 'No';
		}
		if (Array.isArray(value)) {
			if (value.length === 0) return '(empty)';
			if (value.every(v => typeof v === 'string' || typeof v === 'number')) {
				return value.join(', ');
			}
			return JSON.stringify(value, null, 2);
		}
		if (typeof value === 'object') {
			return JSON.stringify(value, null, 2);
		}
		return String(value);
	}

	function isComplex(value: any): boolean {
		if (value === null || value === undefined) return false;
		if (Array.isArray(value) && value.length > 0) {
			return !value.every(v => typeof v === 'string' || typeof v === 'number');
		}
		if (typeof value === 'object') return true;
		return false;
	}
</script>

{#if diff && diff.changes.length > 0}
	<div class="max-h-64 overflow-y-auto border rounded-md divide-y">
		{#each diff.changes as change}
			{@const oldComplex = isComplex(change.oldValue)}
			{@const newComplex = isComplex(change.newValue)}

			<div class="flex items-start gap-3 px-3 py-2 text-sm hover:bg-muted/30">
				<span class="font-medium text-muted-foreground shrink-0 w-32 truncate" title={formatFieldName(change.field)}>
					{formatFieldName(change.field)}
				</span>

				{#if oldComplex || newComplex}
					<!-- Complex values: stacked -->
					<div class="flex-1 min-w-0 space-y-1">
						<pre class="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap">{formatDisplayValue(change.oldValue)}</pre>
						<pre class="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap">{formatDisplayValue(change.newValue)}</pre>
					</div>
				{:else}
					<!-- Simple values: inline -->
					<div class="flex items-center gap-2 flex-1 min-w-0">
						<span class="text-muted-foreground truncate" title={formatDisplayValue(change.oldValue)}>
							{formatDisplayValue(change.oldValue)}
						</span>
						<ArrowRight class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
						<span class="text-amber-600 dark:text-amber-400 font-medium truncate" title={formatDisplayValue(change.newValue)}>
							{formatDisplayValue(change.newValue)}
						</span>
					</div>
				{/if}
			</div>
		{/each}
	</div>
{:else}
	<p class="text-sm text-muted-foreground italic">No changes recorded</p>
{/if}
