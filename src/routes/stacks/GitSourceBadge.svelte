<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { GitBranch, GitCommitHorizontal } from 'lucide-svelte';
	import { forgeIcon } from '$lib/utils/git-forge';
	import { appSettings } from '$lib/stores/settings';
import { effectiveStackBranch } from '$lib/git-stack-branch';

	interface Props {
		source: { repository?: { url?: string; branch?: string } | null; gitStack?: { lastCommit?: string | null; branch?: string | null } | null };
	}
	let { source }: Props = $props();

	const ForgeIcon = $derived(forgeIcon(source.repository?.url));
	const showHash = $derived(!!source.gitStack?.lastCommit && $appSettings.showGitCommitHash);
	// Effective branch: per-stack override wins, else repository default
	// (shared with the server-side resolver in src/lib/git-stack-branch.ts).
	const eff = $derived(
		effectiveStackBranch(source.gitStack ?? null, source.repository ?? undefined)
	);
	const effectiveBranch = eff.branch;
	const isPerStackBranch = eff.perStack === true;
	// A tooltip is only worth showing when there's real git info in it.
	const hasGitInfo = $derived(!!source.gitStack?.lastCommit || !!source.repository);
</script>

{#snippet badge()}
	<span
		class="inline-flex max-w-full items-center justify-center gap-1 overflow-hidden text-xs px-1.5 py-0.5 rounded-sm bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 shadow-sm {showHash ? '' : 'min-w-[5.5rem]'}"
	>
		<ForgeIcon class="w-3 h-3 shrink-0" />
		<span class="shrink-0">Git</span>
		{#if showHash}
			<span class="font-mono text-[10px] opacity-75 truncate">{source.gitStack!.lastCommit}</span>
		{/if}
	</span>
{/snippet}

{#if hasGitInfo}
	<Tooltip.Root>
		<Tooltip.Trigger class="block max-w-full overflow-hidden">
			{@render badge()}
		</Tooltip.Trigger>
		<Tooltip.Content class="p-0">
			<div class="flex flex-col gap-1.5 px-3 py-2">
				{#if source.gitStack?.lastCommit}
					<div class="flex items-center gap-2">
						<GitCommitHorizontal class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
						<code class="text-xs">{source.gitStack.lastCommit}</code>
					</div>
				{/if}
				{#if source.repository}
					{#if effectiveBranch}
						<div class="flex items-center gap-2">
							<GitBranch class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
							<span class="text-xs">{effectiveBranch}</span>
							{#if isPerStackBranch}
								<span class="text-[10px] text-muted-foreground">(per-stack)</span>
							{/if}
						</div>
					{/if}
					<div class="flex items-center gap-2">
						<ForgeIcon class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
						<span class="text-xs">{source.repository.url}</span>
					</div>
				{/if}
			</div>
		</Tooltip.Content>
	</Tooltip.Root>
{:else}
	{@render badge()}
{/if}
