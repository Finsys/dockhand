<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { Loader2 } from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';
	import StackIcon from '$lib/components/StackIcon.svelte';
	import { REDEPLOY_PRESETS, isPresetActive, composeCommandFor, type RedeployPreset } from '$lib/utils/redeploy-presets';

	interface Props {
		stackName: string;
		envId: number | null;
		/** The stack's icon value (custom/selfhst/lucide/null); shown in the header. */
		stackIcon?: string | null;
		disabled?: boolean;
		side?: 'top' | 'bottom';
		align?: 'start' | 'center' | 'end';
		/**
		 * 'icon' (default): small icon-only trigger, as used standalone in the stack
		 * grid rows -- the icon itself IS the action, there is no separate main button.
		 * 'chevron': a small square trigger meant to sit flush against a separate,
		 * directly-clickable main button (a split button), as used next to
		 * "Save & redeploy" / "Create & Start" in StackModal. The main button is NOT
		 * part of this component -- the caller renders it, wraps both in one flex
		 * container, and gives the main button `rounded-r-none` / this trigger
		 * `rounded-l-none` so they read as one control with two separate, independently
		 * reachable click/focus targets (never one element that does different things
		 * depending on where exactly it's clicked).
		 */
		triggerVariant?: 'icon' | 'chevron';
		/** Extra classes merged onto the trigger. */
		triggerClass?: string;
		/**
		 * Initial state of the "Pull images" / "Build images" / "Force recreate"
		 * checkboxes each time the popover opens. Re-read on every open (not just once
		 * at mount) so a caller whose default is derived from live content (e.g. "does
		 * the compose have a build: section right now") stays correct across repeated
		 * opens.
		 */
		defaultPull?: boolean;
		defaultBuild?: boolean;
		defaultForceRecreate?: boolean;
		/** Short note shown under the checkboxes, e.g. explaining why Build is pre-checked. */
		reason?: string;
		/** Short note under Force recreate, saying what it changes for this stack. */
		forceRecreateReason?: string;
		/**
		 * Show the one-click presets. Off by default: they are named for the choices the
		 * stack editor offers, and a caller whose defaults fall outside that set would
		 * open with no preset highlighted and nothing to tell the user where they are.
		 */
		showPresets?: boolean;
		onDeploy: (options: { pull: boolean; build: boolean; forceRecreate: boolean }) => Promise<void>;
		children: Snippet;
	}

	let {
		stackName,
		envId,
		stackIcon = null,
		disabled = false,
		side = 'top',
		align = 'end',
		triggerVariant = 'icon',
		triggerClass = '',
		defaultPull = true,
		defaultBuild = false,
		defaultForceRecreate = false,
		reason,
		forceRecreateReason,
		showPresets = false,
		onDeploy,
		children
	}: Props = $props();

	let open = $state(false);
	let pull = $state(defaultPull);
	let build = $state(defaultBuild);
	let forceRecreate = $state(defaultForceRecreate);
	let deploying = $state(false);

	async function handleDeploy() {
		// Close the popover immediately: the output modal opens and owns the progress
		// display, so leaving the popover stuck on "Deploying..." behind it is noise.
		const opts = { pull, build, forceRecreate };
		open = false;
		await onDeploy(opts);
	}

	function handleTriggerClick(e: MouseEvent) {
		e.stopPropagation();
		if (disabled) return;
		if (!open) {
			// Re-seed from the current defaults on every open, not just once at mount --
			// defaultBuild in particular tracks the live compose content and can change
			// between two opens of the same popover.
			pull = defaultPull;
			build = defaultBuild;
			forceRecreate = defaultForceRecreate;
		}
		open = !open;
	}

	// Shortcuts for the three combinations people reach for; the checkboxes stay the
	// source of truth, so every other combination is still one click away.
	function applyPreset(p: RedeployPreset) {
		pull = p.pull;
		forceRecreate = p.forceRecreate;
	}

	const composeCommand = $derived(composeCommandFor({ pull, build, forceRecreate }));
</script>

<Popover.Root bind:open>
	<Popover.Trigger asChild>
		{#snippet child({ props })}
			<button
				type="button"
				title={triggerVariant === 'icon' ? 'Redeploy' : 'More deploy options'}
				{...props}
				onclick={handleTriggerClick}
				{disabled}
				class={triggerVariant === 'chevron'
					? cn(buttonVariants({ variant: 'default', size: 'icon' }), 'rounded-l-none border-l border-primary-foreground/20', triggerClass)
					: cn(
							'p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer inline-flex items-center',
							triggerClass
						)}
			>
				{@render children()}
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		class="w-[26rem] p-3 z-[200]"
		{side}
		{align}
		sideOffset={8}
	>
		<div class="space-y-3">
			<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<StackIcon icon={stackIcon} {stackName} {envId} class="w-4 h-4 shrink-0" />
				<span class="truncate">Redeploy stack <strong class="font-semibold text-foreground">{stackName}</strong></span>
			</p>
			{#if showPresets}
			<div class="flex gap-1">
				{#each REDEPLOY_PRESETS as p}
					<button
						type="button"
						disabled={deploying}
						onclick={() => applyPreset(p)}
						class="flex-1 rounded border px-1.5 py-1 text-2xs transition-colors disabled:opacity-50 {isPresetActive(p, { pull, forceRecreate })
							? 'border-primary/50 bg-primary/10 text-foreground'
							: 'border-border text-muted-foreground hover:bg-muted'}"
					>{p.label}</button>
				{/each}
			</div>
			{/if}
			<div class="space-y-2">
				<label class="flex items-center gap-2 cursor-pointer">
					<Checkbox bind:checked={pull} disabled={deploying} />
					<span class="text-xs">Pull images</span>
				</label>
				<label class="flex items-center gap-2 cursor-pointer">
					<Checkbox bind:checked={build} disabled={deploying} />
					<span class="text-xs">Build images</span>
				</label>
				{#if reason}
					<p class="text-2xs text-muted-foreground pl-6 -mt-1">{reason}</p>
				{/if}
				<label class="flex items-center gap-2 cursor-pointer">
					<Checkbox bind:checked={forceRecreate} disabled={deploying} />
					<span class="text-xs">Force recreate</span>
				</label>
				{#if forceRecreateReason}
					<p class="text-2xs text-muted-foreground pl-6 -mt-1">{forceRecreateReason}</p>
				{/if}
			</div>
			<p class="min-h-[2.25rem] border-t pt-2 font-mono text-2xs leading-snug text-muted-foreground">{composeCommand}</p>
			<Button
				size="sm"
				class="w-full h-7 text-xs"
				onclick={handleDeploy}
				disabled={deploying}
			>
				{#if deploying}
					<Loader2 class="w-3 h-3 mr-1 animate-spin" />
					Deploying...
				{:else}
					Deploy
				{/if}
			</Button>
		</div>
	</Popover.Content>
</Popover.Root>
