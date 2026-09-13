<script lang="ts">
	import { Box } from 'lucide-svelte';
	import { getStackIconComponent, isSelfhstIcon, selfhstRef, isCustomIcon } from '$lib/utils/icons';
	import { selfhstIcons, requestSelfhst } from '$lib/stores/selfhst-icons';

	interface Props {
		/** Icon value: a lucide name, 'selfhst:<ref>', 'custom:<file>', or null/empty. */
		icon?: string | null;
		/** Stack name, used to build the custom-icon URL. */
		stackName?: string;
		/** Environment id the stack belongs to (custom icons are keyed by name+env). */
		envId?: number | null;
		class?: string;
	}

	let { icon, stackName, envId = null, class: className = 'w-4 h-4' }: Props = $props();

	const customUrl = $derived(
		stackName
			? `/api/stacks/${encodeURIComponent(stackName)}/icon${envId != null ? `?env=${envId}` : ''}`
			: ''
	);

	const selfhst = $derived(selfhstRef(icon));
	const custom = $derived(isCustomIcon(icon));
	// Lucide is the fallback for any non-selfhst, non-custom value (incl. null).
	const LucideIcon = $derived(!isSelfhstIcon(icon) && !custom ? getStackIconComponent(icon || '') : null);

	// Resolve the selfh.st icon via the shared batch store (one request for the whole
	// list) instead of a per-icon <img src>. `resolved`: data URI when ready, '' when it
	// could not resolve, undefined while the batch is still in flight.
	$effect(() => {
		if (selfhst) requestSelfhst(selfhst);
	});
	const resolved = $derived(selfhst ? $selfhstIcons[selfhst] : undefined);
</script>

{#if selfhst && resolved}
	<img src={resolved} alt="" class="{className} object-contain shrink-0" />
{:else if selfhst && resolved === undefined}
	<!-- batch in flight: keep space so the row doesn't jump -->
	<span class="{className} shrink-0"></span>
{:else if custom && customUrl}
	<img src={customUrl} alt="" class="{className} object-contain shrink-0" />
{:else if LucideIcon}
	<LucideIcon class={className} />
{:else if selfhst}
	<!-- a selfh.st ref that could not resolve (resolved === '') - show a generic box -->
	<Box class="{className} shrink-0" />
{/if}
