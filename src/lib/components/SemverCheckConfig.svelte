<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Tag, Info } from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { splitAtName } from '$lib/i18n/split';

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
		/** Drop a candidate whose image was built before the running one. */
		rejectOlderImages: boolean;
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
		rejectOlderImages = $bindable(),
		floatingTag
	}: Props = $props();

	const isFloating = $derived(!!floatingTag);
	const bumps: Bump[] = ['patch', 'minor', 'major'];
	const bumpLabels: Record<Bump, () => string> = {
		patch: m.semver_bump_patch,
		minor: m.semver_bump_minor,
		major: m.semver_bump_major
	};
	const checkHint = splitAtName(m.semver_check_hint);
	const exampleRunning = splitAtName(m.semver_example_running);
	const prereleaseHint = splitAtName(m.semver_include_prereleases_hint);
</script>

<div class="space-y-4">
	<div class="flex items-start gap-2" class:opacity-55={isFloating}>
		<Tag class="w-4 h-4 text-green-500 glow-green mt-0.5 shrink-0" />
		<div class="flex-1">
			<Label>{m.semver_check_newer_tags()}</Label>
			<p class="text-xs text-muted-foreground mt-0.5">
				{checkHint[0]}<code>16.2</code>, <code>v3.0</code>{checkHint[1]}
			</p>
		</div>
		<TogglePill bind:checked={enabled} disabled={isFloating} />
	</div>

	{#if isFloating}
		<div class="ml-6 flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
			<Info class="w-3.5 h-3.5 mt-0.5 shrink-0" />
			<span><code>{floatingTag}</code> {m.semver_floating_hint_before()} <code>1.26</code>{m.semver_floating_hint_after()}</span>
		</div>
	{:else if enabled}
		<!-- Indented under the header so it reads as "all this belongs to the toggle
		     above"; the boxes inside are full-width of THIS container so they line up. -->
		<div class="ml-6 space-y-4">
			<!-- max bump -->
			<div class="space-y-2">
				<div class="flex items-center gap-4">
					<Label class="flex-1">{m.semver_which_updates()}</Label>
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
								{bumpLabels[bump]()}
							</button>
						{/each}
					</div>
				</div>
				<div class="rounded-md border border-border bg-muted/40 p-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
					{exampleRunning[0]}<code>1.4.2</code>{exampleRunning[1]}<br />
					<span class="font-bold text-foreground">{m.semver_bump_patch()}</span> {m.semver_example_patch()} → <code>1.4.3</code><br />
					<span class="font-bold text-foreground">{m.semver_bump_minor()}</span> {m.semver_example_minor()} → <code>1.4.3</code>, <code>1.5.0</code><br />
					<span class="font-bold text-foreground">{m.semver_bump_major()}</span> {m.semver_example_major()} → <code>1.4.3</code>, <code>1.5.0</code>, <code>2.0.0</code>
				</div>
			</div>

			<!-- match flavor -->
			<div class="space-y-2 border-t border-border/60 pt-3">
				<div class="flex items-start gap-4">
					<div class="flex-1">
						<Label>{m.semver_match_flavor()}</Label>
						<p class="text-xs text-muted-foreground mt-0.5">
							{m.semver_match_flavor_hint_before()}
							<code>-alpine</code> {m.imagepull_format_hint_or()} <code>-ls123</code>{m.semver_match_flavor_hint_after()}
						</p>
					</div>
					<div class="shrink-0"><TogglePill bind:checked={matchFlavor} /></div>
				</div>
				<div class="rounded-md border border-border bg-muted/40 p-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
					<span class="font-bold text-foreground">{m.semver_on()}</span> <code>1.2-alpine</code> → <code>1.5-alpine</code>, {m.semver_flavor_on_never_bare()} <code>1.5</code><br />
					<span class="font-bold text-foreground">{m.semver_off()}</span> {m.semver_flavor_off_example()}
				</div>
			</div>

			<!-- include prereleases -->
			<div class="flex items-start gap-4 border-t border-border/60 pt-3">
				<div class="flex-1">
					<Label>{m.semver_include_prereleases()}</Label>
					<p class="text-xs text-muted-foreground mt-0.5">
						{prereleaseHint[0]}<code>-rc</code> / <code>-beta</code>{prereleaseHint[1]}
					</p>
				</div>
				<div class="shrink-0"><TogglePill bind:checked={includePrerelease} /></div>
			</div>

			<!-- ignore older images -->
			<div class="space-y-2 border-t border-border/60 pt-3">
				<div class="flex items-start gap-4">
					<div class="flex-1">
						<Label>{m.semver_ignore_older()}</Label>
						<p class="text-xs text-muted-foreground mt-0.5">
							{m.semver_ignore_older_hint()}
						</p>
					</div>
					<div class="shrink-0"><TogglePill bind:checked={rejectOlderImages} /></div>
				</div>
				<div class="rounded-md border border-border bg-muted/40 p-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
					{m.semver_old_tags_before()} <code>lidarr:8.1.2135</code> {m.semver_old_tags_is_really()} <code>0.8.1.2135</code> {m.semver_old_tags_from()}
					<code>3.1.0</code>{m.semver_old_tags_after()}<br />
					<span class="font-bold text-foreground">{m.semver_on()}</span> {m.semver_old_tags_on()}<br />
					<span class="font-bold text-foreground">{m.semver_off()}</span> {m.semver_old_tags_off()}
				</div>
			</div>
		</div>
	{/if}

	{#if enabled && !isFloating}
		<div class="ml-6 flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
			<Info class="w-3.5 h-3.5 mt-0.5 shrink-0" />
			<span>{m.semver_badge_note_before()} <strong class="text-foreground font-semibold">{m.semver_badge_note_strong()}</strong>{m.semver_badge_note_after()}</span>
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
