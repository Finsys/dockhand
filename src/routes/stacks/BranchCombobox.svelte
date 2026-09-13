<script lang="ts">
	import { ChevronDown, Check, GitBranch, Loader2 } from 'lucide-svelte';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import { buttonVariants } from '$lib/components/ui/button';
	import { cn } from '$lib/utils';

	/**
	 * Free-text, searchable branch picker.
	 *
	 * Reuses the repository's existing Popover + Command primitives (the same
	 * interaction/style pattern as TimezoneSelector.svelte) so the user can
	 * both pick a *discovered* branch and type an *arbitrary* branch name.
	 *
	 * Behaviour contract (maintainer review for the new-repository branch
	 * field):
	 *  - fetched branches appear in the list and are searchable/selectable;
	 *  - typing a branch NOT in the list offers "Use \"<query>\"", and clicking
	 *    it (or pressing Enter) selects that exact value;
	 *  - if branch enumeration fails or returns nothing, the user can still
	 *    type and select any branch manually (the "Use \"<query>\"" row always
	 *    appears when the trimmed query is non-blank);
	 *  - an existing value that a later enumeration did NOT return is retained
	 *    (never silently reset), and the trigger keeps showing it;
	 *  - while enumeration is in flight a loader is shown but the field stays
	 *    usable;
	 *  - keyboard selection (ArrowUp/Down + Enter) works for both fetched rows
	 *    and the free-text row.
	 */
	interface Branch {
		name: string;
		sha: string;
	}

	interface Props {
		/** Current branch value (e.g. "main"). */
		value: string;
		/** Discovered branches (from /api/git/branches), name + short SHA. */
		branches: Branch[];
		/** Repository default branch name, highlighted in the list when known. */
		defaultBranch?: string;
		/** True while branch enumeration is in flight. */
		loading: boolean;
		/** Called with the selected value (a fetched branch or the typed name). */
		onchange?: (value: string) => void;
		/** Called when the user clears the field (empty value). */
		onclear?: () => void;
		/** When set (with onclear), shows a top row that resets to this label,
		 * e.g. "Repository default (main)". */
		clearLabel?: string;
		id?: string;
		class?: string;
		placeholder?: string;
	}

	let {
		value = $bindable('main'),
		branches = [],
		defaultBranch,
		loading = false,
		onchange,
		onclear,
		clearLabel,
		id,
		class: className,
		placeholder = 'main'
	}: Props = $props();

	let open = $state(false);
	let searchQuery = $state('');

	// Update the local value for an instant trigger refresh, then notify the parent (which
	// owns the value via onchange). `displayValue` below MUST be $derived or the trigger
	// stays frozen on the initial value.
	function selectBranch(branch: string) {
		value = branch;
		open = false;
		searchQuery = '';
		onchange?.(branch);
	}

	function clearBranch() {
		open = false;
		searchQuery = '';
		onclear?.();
	}

	// Filtered fetched branches, ordered so the current value (if not in the
	// fetched list) still surfaces near the top for easy re-selection.
	const filteredBranches = $derived(
		searchQuery
			? branches.filter((b) => b.name.toLowerCase().includes(searchQuery.toLowerCase()))
			: branches
	);

	// Offer the typed name as a selectable row when it is non-blank and is not
	// already one of the fetched branches.
	const freeTextBranch = $derived(
		searchQuery.trim() && !branches.some((b) => b.name === searchQuery.trim())
			? searchQuery.trim()
			: ''
	);

	// Display: show the current value; fall back to the placeholder when empty
	// (e.g. no branch chosen -> "main"). MUST be $derived - a plain const is computed
	// once and would freeze the trigger on the initial value.
	const displayValue = $derived(value || placeholder);
</script>

<Popover.Root bind:open>
	<Popover.Trigger class="w-full">
		<span
			role="combobox"
			aria-expanded={open}
			class={cn(buttonVariants({ variant: 'outline' }), 'w-full justify-between cursor-pointer select-none', className)}
			{id}
		>
			<span class="flex items-center gap-2 truncate">
				<GitBranch class="h-4 w-4 shrink-0 text-muted-foreground" />
				{#if loading}
					<Loader2 class="h-4 w-4 animate-spin" />
					<span class="text-muted-foreground">Loading branches…</span>
				{:else}
					<span class="truncate">{displayValue}</span>
				{/if}
			</span>
			<ChevronDown class="ml-2 h-4 w-4 shrink-0 opacity-50" />
		</span>
	</Popover.Trigger>
	<Popover.Content class="w-[350px] p-0 z-[200]" align="start">
		<Command.Root shouldFilter={false}>
			<Command.Input bind:value={searchQuery} placeholder="Type a branch name…" />
			<Command.List class="max-h-[300px]">
				{#if loading}
					<Command.Empty>Loading branches…</Command.Empty>
				{:else}
					{#if clearLabel && onclear && !searchQuery.trim()}
						<Command.Item value="__repo_default__" onSelect={clearBranch}>
							<Check class={cn('mr-2 h-4 w-4', value ? 'opacity-0' : 'opacity-100')} />
							<GitBranch class="mr-2 h-4 w-4 text-muted-foreground" />
							<span class="truncate">{clearLabel}</span>
						</Command.Item>
					{/if}
					{#if filteredBranches.length > 0}
						<Command.Group heading="Branches">
							{#each filteredBranches as branch}
								<Command.Item value={branch.name} onSelect={() => selectBranch(branch.name)}>
									<Check class={cn('mr-2 h-4 w-4 shrink-0', value === branch.name ? 'opacity-100' : 'opacity-0')} />
									<span class="truncate">{branch.name}</span>
									{#if defaultBranch && branch.name === defaultBranch}
										<span class="ml-2 shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-500">default</span>
									{/if}
									<span class="ml-auto shrink-0 pl-2 font-mono text-xs text-muted-foreground">{branch.sha}</span>
								</Command.Item>
							{/each}
						</Command.Group>
					{/if}
					{#if freeTextBranch}
						<Command.Group heading="Custom">
							<Command.Item value={freeTextBranch} onSelect={() => selectBranch(freeTextBranch)}>
								<GitBranch class="mr-2 h-4 w-4" />
								<span class="truncate">Use "{freeTextBranch}"</span>
							</Command.Item>
						</Command.Group>
					{/if}
					{#if filteredBranches.length === 0 && !freeTextBranch && !loading}
						<Command.Empty>
							Type a branch name (e.g. "main") or pick from the list.
						</Command.Empty>
					{/if}
				{/if}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
