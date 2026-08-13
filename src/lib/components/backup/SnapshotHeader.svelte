<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Clock, Box, Layers } from 'lucide-svelte';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import { getRepoTypeIcon } from '$lib/utils/backup';
	import { formatDateTime, formatRelativeTime } from '$lib/stores/settings';

	// Shared header line for the snapshot Browse and Restore dialogs, so both read the
	// same: "<verb> <name> from <repo>  <shortId>  taken on <env> <timestamp>". A modal
	// passes its own leading icon/verb and (for Restore) a trailing target-env clause via
	// the `trailing` snippet; everything else - name, source repo, source env, id, time -
	// is rendered identically here.
	interface EnvRef { id: number; icon?: string | null }
	interface Props {
		// A lucide icon component. Typed loosely: lucide's component type doesn't line up
		// with svelte's `Component` (same known mismatch PageHeader lives with).
		icon: any;
		verb: string;
		name: string;
		/** container | stack - picks the little box/layers glyph next to the name. */
		nameType?: 'container' | 'stack';
		/** Source repository this snapshot lives in (name + repo URL for the icon). */
		destinationName?: string;
		destinationRepository?: string;
		/** Environment the snapshot was TAKEN on (null/absent for a local snapshot). */
		sourceEnv?: EnvRef;
		sourceEnvName?: string;
		snapshotId?: string;
		snapshotTime?: string | null;
		/** Extra header content (e.g. Restore's "to <targetEnv>") rendered after the id. */
		trailing?: import('svelte').Snippet;
	}
	let {
		icon: Icon, verb, name, nameType = 'container',
		destinationName, destinationRepository,
		sourceEnv, sourceEnvName, snapshotId, snapshotTime, trailing
	}: Props = $props();
</script>

<div class="flex items-center gap-2 flex-wrap text-lg font-semibold">
	<Icon class="h-5 w-5" />
	{verb}
	{#if nameType === 'stack'}<Layers class="h-4 w-4 text-purple-500" />{:else}<Box class="h-4 w-4 text-blue-500" />{/if}
	<span>{name}</span>
	{#if destinationName}
		{@const RepoIcon = getRepoTypeIcon(destinationRepository ?? '')}
		<span class="text-muted-foreground">from</span>
		<span class="flex items-center gap-1"><RepoIcon class="h-4 w-4 text-muted-foreground" />{destinationName}</span>
	{/if}
	<!-- Trailing clause (e.g. Restore's "to <targetEnv>") sits right after the source
	     repo, before the id/timestamp, so it reads "from <repo> to <env>". -->
	{@render trailing?.()}
	{#if snapshotId}<Badge variant="outline" class="font-mono text-[10px] font-normal">{snapshotId.slice(0, 8)}</Badge>{/if}
	{#if snapshotTime}
		<span class="flex items-center gap-1 text-xs font-normal text-muted-foreground">
			<Clock class="h-3 w-3" />
			taken{#if sourceEnvName}&nbsp;on <EnvironmentIcon icon={sourceEnv?.icon || 'globe'} envId={sourceEnv?.id ?? 0} class="h-3.5 w-3.5 text-amber-500" /><span class="text-amber-500 font-medium">{sourceEnvName}</span>{/if}
			{formatDateTime(snapshotTime)}
			<span class="opacity-60">({formatRelativeTime(snapshotTime)})</span>
		</span>
	{/if}
</div>
