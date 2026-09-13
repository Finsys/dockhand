<script lang="ts">
	import type { Component } from 'svelte';
	import { Box } from 'lucide-svelte';
	import { appSettings } from '$lib/stores/settings';
	import { selfhstMatcher, ensureSelfhstMatcher } from '$lib/stores/selfhst-refs';
	import { selfhstIcons, requestSelfhst } from '$lib/stores/selfhst-icons';
	import { isSelfhstIcon, selfhstRef, isCustomIcon, getStackIconComponent, isDockhandImage } from '$lib/utils/icons';

	interface Props {
		image: string;
		/** Container name, used as a fallback match when the image does not resolve. */
		name?: string;
		/**
		 * A user-set icon override (lucide name / 'selfhst:<ref>' / 'custom:container').
		 * When present it WINS over automatic matching and renders even with the app-logo
		 * toggle off - an explicit choice always shows. `envId` builds the custom-icon URL.
		 */
		override?: string | null;
		/** Environment id, only needed to fetch a 'custom:' override's bytes. */
		envId?: number | null;
		/**
		 * The container name a 'custom:' override's bytes are stored under (its icon key).
		 * Defaults to `name`; pass it when `name` is a display value that differs from the
		 * real container name (e.g. the stacks view uses the compose service for matching
		 * but the override is keyed by the actual container name).
		 */
		overrideKey?: string | null;
		class?: string;
		/** Extra classes for the generic-box fallback (e.g. a running/stopped state colour). */
		fallbackClass?: string;
		/** Lucide component to render instead of the generic Box when there is no logo. */
		fallbackIcon?: Component;
		/**
		 * When the app-logo toggle is OFF, render the generic box anyway (used by places
		 * that already showed a box, e.g. the logs/terminal pickers, so they keep their
		 * icon + state colour). Default false: with the toggle off, render nothing (the
		 * container/stack lists opt into icons only when the toggle is on).
		 */
		showFallbackWhenOff?: boolean;
		/**
		 * Render nothing when there is no matched app logo (instead of the generic box).
		 * For dense inline spots (e.g. a volume's "used by" chips) where a box on every
		 * row would be noise - show a logo only when we actually have one.
		 */
		hideWhenNoMatch?: boolean;
	}

	let {
		image,
		name = '',
		override = null,
		envId = null,
		overrideKey = null,
		class: className = 'w-4 h-4',
		fallbackClass = 'text-muted-foreground',
		fallbackIcon = undefined,
		showFallbackWhenOff = false,
		hideWhenNoMatch = false
	}: Props = $props();

	const FallbackIcon = $derived(fallbackIcon ?? Box);

	// An explicit override wins over auto-matching (and the app-logo toggle).
	const hasOverride = $derived(!!override);

	// Dockhand's own container always shows the app mark (unless the user overrode it),
	// regardless of the app-logo toggle - it is our own branding, not a selfh.st match.
	const isSelf = $derived(!hasOverride && isDockhandImage(image));
	const overrideSelfhst = $derived(selfhstRef(override));
	const overrideCustom = $derived(isCustomIcon(override));
	const customIconName = $derived(overrideKey ?? name);
	const overrideCustomUrl = $derived(
		overrideCustom && customIconName
			? `/api/container-icons/${encodeURIComponent(customIconName)}${envId != null ? `?env=${envId}` : ''}`
			: ''
	);
	// A non-selfhst, non-custom override is a lucide name.
	const OverrideLucide = $derived(
		hasOverride && !isSelfhstIcon(override) && !overrideCustom ? getStackIconComponent(override || '') : null
	);

	const enabled = $derived($appSettings.useSelfhstIcons);

	// Idempotent (guards on loaded/loading); the $effect fires on mount and again if the
	// toggle flips on later, so no separate onMount is needed.
	$effect(() => {
		if (enabled) ensureSelfhstMatcher();
	});

	// Reactive match: recomputes when the matcher store loads or the image changes.
	const ref = $derived(enabled ? $selfhstMatcher(image, name) : null);

	// Show the fallback glyph when the toggle is on (no logo matched) or a caller that
	// always had an icon asked for it while off - but never on dense inline spots.
	const showFallback = $derived(!hideWhenNoMatch && (enabled || showFallbackWhenOff));

	// Resolve selfh.st refs (override OR auto-matched) through the shared batch store so a
	// list of containers makes ONE icon request, not one per row. `resolved`: data URI when
	// ready, '' if unresolvable, undefined while the batch is in flight.
	const activeSelfhst = $derived(hasOverride ? overrideSelfhst : enabled ? ref : null);
	$effect(() => {
		if (activeSelfhst) requestSelfhst(activeSelfhst);
	});
	const resolvedSelfhst = $derived(activeSelfhst ? $selfhstIcons[activeSelfhst] : undefined);
</script>

{#if isSelf}
	<img src="/dockhand-mark.svg" alt="Dockhand" class="{className} object-contain shrink-0" />
{:else if activeSelfhst && resolvedSelfhst}
	<img src={resolvedSelfhst} alt="" class="{className} object-contain shrink-0" />
{:else if activeSelfhst && resolvedSelfhst === undefined}
	<!-- batch in flight: hold the space so the row doesn't jump -->
	<span class="{className} shrink-0"></span>
{:else if hasOverride && overrideCustom && overrideCustomUrl}
	<img src={overrideCustomUrl} alt="" class="{className} object-contain shrink-0" />
{:else if hasOverride && OverrideLucide}
	<OverrideLucide class="{className} shrink-0" />
{:else if showFallback}
	<!-- Generic icon so the layout stays consistent even with no match. -->
	<FallbackIcon class="{className} shrink-0 {fallbackClass}" />
{/if}
