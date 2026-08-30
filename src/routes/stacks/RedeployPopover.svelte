<script lang="ts">
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { Loader2 } from 'lucide-svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		stackName: string;
		envId: number | null;
		disabled?: boolean;
		side?: 'top' | 'bottom';
		align?: 'start' | 'center' | 'end';
		/**
		 * 'icon' (default): small icon-only trigger, as used in the stack grid rows.
		 * 'button': a full labeled trigger styled like the shadcn Button component, as
		 * used next to "Save & redeploy" / "Create & Start" in StackModal.
		 */
		triggerVariant?: 'icon' | 'button';
		/** Extra classes merged onto the trigger (mainly useful with triggerVariant="button", e.g. a fixed width). */
		triggerClass?: string;
		/**
		 * Initial state of the "Pull images" / "Build images" checkboxes each time the
		 * popover opens. Re-read on every open (not just at mount) so a caller whose
		 * default is derived from live content (e.g. "does the compose have a build:
		 * section right now") stays correct across repeated opens.
		 */
		defaultPull?: boolean;
		defaultBuild?: boolean;
		defaultForceRecreate?: boolean;
		/** Short note shown under the checkboxes, e.g. explaining why Build is pre-checked. */
		reason?: string;
		onDeploy: (options: { pull: boolean; build: boolean; forceRecreate: boolean }) => Promise<void>;
		children: Snippet;
	}

	let {
		stackName,
		envId,
		disabled = false,
		side = 'top',
		align = 'end',
		triggerVariant = 'icon',
		triggerClass = '',
		defaultPull = true,
		defaultBuild = false,
		defaultForceRecreate = false,
		reason,
		onDeploy,
		children
	}: Props = $props();

	let open = $state(false);
	let pull = $state(defaultPull);
	let build = $state(defaultBuild);
	let forceRecreate = $state(defaultForceRecreate);
	let deploying = $state(false);

	async function handleDeploy() {
		deploying = true;
		try {
			await onDeploy({ pull, build, forceRecreate });
		} finally {
			deploying = false;
			open = false;
		}
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
</script>

<Popover.Root bind:open>
	<Popover.Trigger asChild>
		{#snippet child({ props })}
			<button
				type="button"
				title={triggerVariant === 'icon' ? 'Redeploy' : undefined}
				{...props}
				onclick={handleTriggerClick}
				{disabled}
				class={triggerVariant === 'button'
					? cn(buttonVariants({ variant: 'default' }), triggerClass)
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
		class="w-56 p-3 z-[200]"
		{side}
		{align}
		sideOffset={8}
	>
		<div class="space-y-3">
			<p class="text-xs font-medium">Redeploy stack</p>
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
			</div>
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
