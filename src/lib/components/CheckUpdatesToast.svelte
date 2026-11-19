<script lang="ts">
	import { CircleArrowUp, Tag, Pin, Clock, AlertTriangle, CircleCheck } from 'lucide-svelte';
	import ContainerIcon from './ContainerIcon.svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { groupFailuresByMessage } from '$lib/utils/check-failure';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		updates: number;
		newerTags: number;
		pinned: number;
		coolingDown: number;
		/** Shown when none of the counts above apply, e.g. "Update check failed". */
		headline?: string;
		failed: { containerName: string; imageName: string; error: string }[];
		/** For the user-set container icons, as the container list shows them. */
		envId: number | null;
		closeToast?: () => void;
	}

	let { updates, newerTags, pinned, coolingDown, headline, failed, envId, closeToast }: Props = $props();

	let iconOverrides = $state<Record<string, string>>({});
	$effect(() => {
		if (failed.length === 0) return;
		fetch(appendEnvParam('/api/container-icons', envId))
			.then((res) => (res.ok ? res.json() : {}))
			.then((data) => { iconOverrides = data; })
			.catch(() => {});
	});

	const groups = $derived(groupFailuresByMessage(failed));
	const hasCounts = $derived(updates + newerTags + pinned + coolingDown > 0);
</script>

<div class="w-[38rem] max-w-[calc(100vw-2rem)] rounded-lg border bg-popover text-popover-foreground shadow-lg text-sm">
	<div class="flex items-start gap-3 p-4">
		<div class="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1.5 font-medium">
			{#if updates > 0}
				<span class="inline-flex items-center gap-1.5"><CircleArrowUp class="h-4 w-4 text-amber-500 shrink-0" />{m.updates_available_count({ count: updates })}</span>
			{/if}
			{#if newerTags > 0}
				<span class="inline-flex items-center gap-1.5"><Tag class="h-4 w-4 text-amber-500 shrink-0" />{m.updates_newer_version_tags({ count: newerTags })}</span>
			{/if}
			{#if pinned > 0}
				<span class="inline-flex items-center gap-1.5"><Pin class="h-4 w-4 text-amber-500 shrink-0" />{m.updates_pinned_digest_short({ count: pinned })}</span>
			{/if}
			{#if coolingDown > 0}
				<span class="inline-flex items-center gap-1.5"><Clock class="h-4 w-4 text-muted-foreground shrink-0" />{m.updates_cooling_down_short({ count: coolingDown })}</span>
			{/if}
			{#if !hasCounts && headline}
				<span class="inline-flex items-center gap-1.5">
					{#if failed.length > 0}<AlertTriangle class="h-4 w-4 text-red-500 shrink-0" />{:else}<CircleCheck class="h-4 w-4 text-green-500 shrink-0" />{/if}
					{headline}
				</span>
			{/if}
		</div>
		<button
			type="button"
			class="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
			onclick={() => closeToast?.()}
		>OK</button>
	</div>

	{#if failed.length > 0}
		<div class="border-t px-4 pb-4 pt-3">
			<div class="mb-2 flex items-center gap-1.5 font-medium text-red-500">
				<AlertTriangle class="h-4 w-4 shrink-0" />{m.updates_failed_checks_header({ count: failed.length })}
			</div>
			<div class="max-h-72 space-y-2 overflow-y-auto">
				{#each groups as group, i (i)}
					<div class="rounded-md border px-3 py-2">
						<div class="break-words text-xs text-foreground">{group.error}</div>
						<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
							{#each group.items as item, j (j)}
								<span class="inline-flex items-center gap-1 whitespace-nowrap">
									<ContainerIcon image={item.imageName} name={item.containerName} override={iconOverrides[item.containerName]} {envId} showFallbackWhenOff class="h-3.5 w-3.5 shrink-0" />
									{item.containerName}
								</span>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
