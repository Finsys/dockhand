<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { GitBranch, FolderGit2, ArrowRight, Loader2 } from 'lucide-svelte';
	import { canAccess } from '$lib/stores/auth';
	import { appSettings } from '$lib/stores/settings';

	// Per-stack migration job state — while active, migration controls are disabled.
	const gitMigrationState = $derived($appSettings.gitMigrationState);
	const migrationActive = $derived(gitMigrationState.state !== 'idle');

	interface StackModelRow {
		id: number;
		stackName: string;
		environmentId: number | null;
		engine: 'stack' | 'centralized';
	}
	let stackModelStacks = $state<StackModelRow[]>([]);
	let stacksLoading = $state(true);
	let selectedForMigration = $state<Set<number>>(new Set());
	let migrateBusy = $state(false);

	async function fetchStackModelStacks() {
		try {
			const response = await fetch('/api/git/stacks');
			if (response.ok) {
				const stacks = await response.json();
				stackModelStacks = (Array.isArray(stacks) ? stacks : []).map((s: any) => ({
					id: s.id,
					stackName: s.stackName,
					environmentId: s.environmentId ?? null,
					engine: s.engine === 'centralized' ? 'centralized' : 'stack'
				}));
				// Drop selections for stacks that no longer exist or are already migrated.
				const validIds = new Set(stackModelStacks.filter((s) => s.engine === 'stack').map((s) => s.id));
				selectedForMigration = new Set([...selectedForMigration].filter((id) => validIds.has(id)));
			}
		} catch {
			toast.error('Failed to load git stacks');
		} finally {
			stacksLoading = false;
		}
	}

	function toggleStackSelection(id: number, checked: boolean) {
		const next = new Set(selectedForMigration);
		if (checked) next.add(id);
		else next.delete(id);
		selectedForMigration = next;
	}

	async function migrateSelected() {
		if (selectedForMigration.size === 0 || migrateBusy || migrationActive) return;
		if (!window.confirm(
			`Migrate ${selectedForMigration.size} stack(s) to centralized Git mode?\n\nSelected stacks move onto shared repository clones; their per-stack sync schedules and webhook URLs may change. Unselected stacks are unaffected.`
		)) return;
		migrateBusy = true;
		try {
			const res = await fetch('/api/git/stacks/migrate-batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ stackIds: [...selectedForMigration] })
			});
			const data = await res.json();
			if (res.ok) {
				toast.success(`Migration started for ${data.count ?? selectedForMigration.size} stack(s)`);
				selectedForMigration = new Set();
			} else {
				toast.error(data.error || 'Failed to start migration');
			}
		} catch {
			toast.error('Failed to start migration');
		} finally {
			migrateBusy = false;
		}
	}

	onMount(() => {
		// F11: sync the client's git mode with the server before showing the list.
		appSettings.reload();
		fetchStackModelStacks();
	});
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="text-sm font-medium flex items-center gap-2">
			<GitBranch class="w-4 h-4" />
			Migrate stacks to centralized mode
		</Card.Title>
		<p class="text-xs text-muted-foreground">
			Select stack-model stacks to move onto the centralized (shared clone) model. This only affects the stacks you select: their per-stack sync schedules and webhook URLs change, and unselected stacks keep their current clone layout, schedules and webhooks. Already-centralized stacks are hidden.
		</p>
	</Card.Header>
	<Card.Content class="space-y-3">
		{#if migrationActive}
			<div class="rounded-md border border-blue-300/60 dark:border-blue-700/60 bg-blue-50 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-400">
				<span class="inline-flex items-center gap-2">
					<Loader2 class="w-4 h-4 animate-spin" />
					A stack migration is in progress ({gitMigrationState.state}) — migration controls are temporarily disabled.
				</span>
			</div>
		{/if}
		{#if stacksLoading}
			<p class="text-sm text-muted-foreground">Loading stacks...</p>
		{:else if stackModelStacks.filter((s) => s.engine === 'stack').length === 0}
			<p class="text-sm text-muted-foreground">No stack-model git stacks to migrate.</p>
		{:else}
			<div class="space-y-1 max-h-64 overflow-y-auto">
				{#each stackModelStacks.filter((s) => s.engine === 'stack') as stack (stack.id)}
					<div class="flex items-center gap-3 py-2 px-3 rounded-md border bg-card">
						<Checkbox
							checked={selectedForMigration.has(stack.id)}
							onCheckedChange={(checked) => toggleStackSelection(stack.id, checked === true)}
							disabled={!$canAccess('settings', 'edit') || migrationActive}
						/>
						<FolderGit2 class="w-4 h-4 shrink-0 text-muted-foreground" />
						<span class="font-medium text-sm truncate">{stack.stackName}</span>
						<Badge variant="outline" class="text-xs">Per-stack clone</Badge>
					</div>
				{/each}
			</div>
			<div class="flex items-center gap-2">
				<Button
					size="sm"
					variant="outline"
					onclick={migrateSelected}
					disabled={selectedForMigration.size === 0 || migrateBusy || migrationActive || !$canAccess('settings', 'edit')}
				>
					{#if migrateBusy}
						<Loader2 class="w-4 h-4 animate-spin" />
					{:else}
						<ArrowRight class="w-4 h-4" />
					{/if}
					Migrate selected ({selectedForMigration.size})
				</Button>
			</div>
		{/if}
	</Card.Content>
</Card.Root>
