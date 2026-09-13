<script lang="ts">
	import { Loader2, CheckCircle2, XCircle, Rocket, Layers } from 'lucide-svelte';
	import StackIcon from '$lib/components/StackIcon.svelte';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import { environments } from '$lib/stores/environment';

	// The one identity line shared by every deploy/compose output view (the docked panel
	// in StackModal, the standalone ComposeOutputModal, and the git-deploy popover), so
	// they all read the same and stay aligned:
	//   "<state icon> <verb> <stack icon> <name> on <env icon> <env> <status>"
	// One component = one place to change sizing/spacing/fallback (no per-dialog drift).
	interface Props {
		// The action word, e.g. "Bringing down" or "Git deploy".
		verb: string;
		stackName?: string;
		// Icon value (lucide/selfhst/custom). When unset, a generic Layers glyph shows --
		// never StackIcon's Boxes fallback, which reads as a different icon.
		stackIcon?: string | null;
		envId?: number | null;
		// Drives the leading icon. 'idle' shows a rocket (a not-yet-started deploy prompt).
		state: 'idle' | 'running' | 'complete' | 'error';
		// Optional run status ("Running...", "Succeeded - 1.2s"), muted, same size/baseline.
		statusLine?: string;
		// Icon box size; the docked panel is denser than the modals.
		iconClass?: string;
	}
	let { verb, stackName, stackIcon = null, envId = null, state, statusLine, iconClass = 'w-4 h-4' }: Props = $props();

	let env = $derived(envId != null ? $environments.find((e) => e.id === envId) ?? null : null);
</script>

<span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-normal">
	{#if state === 'running'}
		<Loader2 class="{iconClass} shrink-0 animate-spin text-muted-foreground" />
	{:else if state === 'complete'}
		<CheckCircle2 class="{iconClass} shrink-0 text-emerald-500" />
	{:else if state === 'error'}
		<XCircle class="{iconClass} shrink-0 text-destructive" />
	{:else}
		<Rocket class="{iconClass} shrink-0 text-violet-500" />
	{/if}
	<span class="shrink-0 font-medium">{verb}</span>
	{#if stackName}
		{#if stackIcon}
			<StackIcon icon={stackIcon} {stackName} {envId} class="{iconClass} shrink-0 text-muted-foreground" />
		{:else}
			<Layers class="{iconClass} shrink-0 text-muted-foreground" />
		{/if}
		<span class="truncate font-medium">{stackName}</span>
	{/if}
	{#if env}
		<span class="shrink-0 text-muted-foreground">on</span>
		<EnvironmentIcon icon={env.icon || 'server'} envId={env.id} class="{iconClass} shrink-0 text-muted-foreground" />
		<span class="truncate font-medium text-amber-600 dark:text-amber-400">{env.name}</span>
	{/if}
	{#if statusLine}
		<span class="ml-1 shrink-0 truncate text-muted-foreground">{statusLine}</span>
	{/if}
</span>
