<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Tag, Info } from 'lucide-svelte';

	type Bump = 'patch' | 'minor' | 'major';

	interface Props {
		/** Master toggle: also detect newer version tags for pinned images. */
		enabled: boolean;
		/** Cap the surfaced bump. */
		maxBump: Bump;
		/** Require the same tag suffix (flavor) as the running tag. */
		matchFlavor: boolean;
		/** Consider -rc/-beta prerelease tags. */
		includePrerelease: boolean;
		/**
		 * When set, the current tag is floating (latest/stable/sha) so there is no
		 * version to compare — the toggle is disabled and this tag is shown in the hint.
		 * Container scope passes it; env scope leaves it undefined.
		 */
		floatingTag?: string;
	}

	let {
		enabled = $bindable(),
		maxBump = $bindable(),
		matchFlavor = $bindable(),
		includePrerelease = $bindable(),
		floatingTag
	}: Props = $props();

	const isFloating = $derived(!!floatingTag);
	const bumps: Bump[] = ['patch', 'minor', 'major'];
</script>

<div class="space-y-4">
	<div class="flex items-start gap-2" class:opacity-55={isFloating}>
		<Tag class="w-4 h-4 text-green-500 glow-green mt-0.5 shrink-0" />
		<div class="flex-1">
			<Label>Check for newer version tags</Label>
			<p class="text-xs text-muted-foreground mt-0.5">
				For a container pinned to a version tag (e.g. <code>16.2</code>, <code>v3.0</code>), also detect
				when a newer version is published. Advisory only.
			</p>
		</div>
		<TogglePill bind:checked={enabled} disabled={isFloating} />
	</div>

	{#if isFloating}
		<div class="ml-6 flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
			<Info class="w-3.5 h-3.5 mt-0.5 shrink-0" />
			<span><code>{floatingTag}</code> is a floating tag — pin a version tag (e.g. <code>1.26</code>) to enable newer-version detection.</span>
		</div>
	{:else if enabled}
		<!-- Indented under the header so it reads as "all this belongs to the toggle
		     above"; the boxes inside are full-width of THIS container so they line up. -->
		<div class="ml-6 space-y-4">
			<!-- max bump -->
			<div class="space-y-2">
				<div class="flex items-center gap-4">
					<Label class="flex-1">Which updates to show</Label>
					<div class="inline-flex shrink-0 gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5">
						{#each bumps as bump}
							<button
								type="button"
								onclick={() => (maxBump = bump)}
								class="rounded-md px-3.5 py-1.5 text-xs font-semibold capitalize transition-colors
									{maxBump === bump
										? 'bg-green-500/15 text-green-500 shadow-[inset_0_0_0_1px_rgba(34,197,94,0.3)]'
										: 'text-muted-foreground hover:text-foreground'}"
							>
								{bump}
							</button>
						{/each}
					</div>
				</div>
				<div class="rounded-md border border-border bg-muted/40 p-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
					Running <code>1.4.2</code>, you'll be told about:<br />
					<span class="font-bold text-foreground">Patch</span> bug-fix only → <code>1.4.3</code><br />
					<span class="font-bold text-foreground">Minor</span> new features too → <code>1.4.3</code>, <code>1.5.0</code><br />
					<span class="font-bold text-foreground">Major</span> everything, incl. breaking → <code>1.4.3</code>, <code>1.5.0</code>, <code>2.0.0</code>
				</div>
			</div>

			<!-- match flavor -->
			<div class="space-y-2 border-t border-border/60 pt-3">
				<div class="flex items-start gap-4">
					<div class="flex-1">
						<Label>Match the tag flavor</Label>
						<p class="text-xs text-muted-foreground mt-0.5">
							Only suggest tags with the same suffix as the one you run — the flavor, like
							<code>-alpine</code> or <code>-ls123</code>.
						</p>
					</div>
					<div class="shrink-0"><TogglePill bind:checked={matchFlavor} /></div>
				</div>
				<div class="rounded-md border border-border bg-muted/40 p-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
					<span class="font-bold text-foreground">On</span> <code>1.2-alpine</code> → <code>1.5-alpine</code>, never bare <code>1.5</code><br />
					<span class="font-bold text-foreground">Off</span> any newer version, even a different flavor — noisier
				</div>
			</div>

			<!-- include prereleases -->
			<div class="flex items-start gap-4 border-t border-border/60 pt-3">
				<div class="flex-1">
					<Label>Include prereleases</Label>
					<p class="text-xs text-muted-foreground mt-0.5">
						Consider <code>-rc</code> / <code>-beta</code> tags. Off keeps a stable deployment on
						stable releases.
					</p>
				</div>
				<div class="shrink-0"><TogglePill bind:checked={includePrerelease} /></div>
			</div>
		</div>
	{/if}

	{#if enabled && !isFloating}
		<div class="ml-6 flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
			<Info class="w-3.5 h-3.5 mt-0.5 shrink-0" />
			<span>A newer version shows as a badge on the container — it is <strong class="text-foreground font-semibold">never auto-applied</strong>.</span>
		</div>
	{/if}
</div>

<style>
	code {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.9em;
		background: hsl(var(--muted));
		border: 1px solid hsl(var(--border));
		border-radius: 4px;
		padding: 0 4px;
	}
</style>
