<script lang="ts">
	import { Loader2 } from 'lucide-svelte';

	// Progress indicator for the per-destination snapshot sweep. Each backup repo is
	// queried separately and a slow/unreachable one can take up to the backend's restic
	// timeout (5 min), so we show "X of N repos" rather than an indeterminate spinner -
	// the user sees it advancing instead of wondering if it hung. Shared across the
	// Backups page and the container/stack snapshot panels.
	interface Props {
		done: number;
		total: number;
		/** Extra classes for the wrapper (sizing/spacing per call site). */
		class?: string;
	}
	let { done, total, class: className = '' }: Props = $props();
</script>

<span class="flex items-center gap-1.5 text-xs text-muted-foreground {className}">
	<Loader2 class="w-3.5 h-3.5 animate-spin" />
	<!-- The "X of N repos" count only adds information with more than one repo; with a
	     single repo it reads oddly ("1 of 1"), so just say "Loading snapshots…". -->
	Loading snapshots…{#if total > 1} {done} of {total} repos{/if}
</span>
