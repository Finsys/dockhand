<script lang="ts">
	/**
	 * "Stack files on the host" — probes the target host at backup-config time, shows the
	 * resolved HOST path of the stack folder, and lets the user pick which entries to back up.
	 * Load-bearing files (compose, .env) are always kept (non-deselectable). When the folder
	 * can't be located on the host, an info callout tells the user to set the env's stack path
	 * and re-configure. Mirrors VolumePicker's list + BackupPanel's host-path callout.
	 */
	import { Label } from '$lib/components/ui/label';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { FolderOpen, Folder, FileText, Info, Loader2, AlertTriangle, HelpCircle, Unplug, Route, UndoDot, Icon } from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

	type Entry = { name: string; type: 'dir' | 'file'; size: number; capturedAs?: 'bind' | 'volume' };
	type Listing =
		| { kind: 'listed'; hostPath: string; entries: Entry[] }
		| { kind: 'helper-failed'; reason: string }
		| { kind: 'unknown'; reason: string }
		| null;

	interface Props {
		listing: Listing;
		loading?: boolean;
		/** Names of stack-dir entries the user has DEselected (excluded from the backup). */
		excludedStackFiles: string[];
		/** Environment connection type - the tooltip explains the host path differently per type. */
		connectionType?: string;
		/** Environment name, shown in the tooltip ("<name> is a socket environment"). */
		envName?: string;
		/** Environment icon (Lucide name or custom) + its id, for the env glyph in the tooltip. */
		envIcon?: string;
		envId?: number;
		/** The user-set "Remote stack path (for backup)" for direct/hawser envs (empty if unset). */
		configuredStackPath?: string;
	}

	let { listing, loading = false, excludedStackFiles = $bindable(), connectionType, envName, envIcon, envId, configuredStackPath = '' }: Props = $props();

	// Falls back to a generic subject when the env name isn't available.
	const envLabel = $derived(envName || 'This environment');

	// The stack folder resolves to a host path by a DIFFERENT route per environment type, so the
	// "where this path comes from" help must differ too (undefined = socket, the default).
	const envKind = $derived(
		connectionType === 'direct' ? 'direct'
		: connectionType === 'hawser-standard' || connectionType === 'hawser-edge' ? 'hawser'
		: 'socket'
	);

	// A stack always needs its compose + env files - never deselectable (matches the server
	// isLoadBearingStackFile guard, which refuses to exclude them even if the config lists them).
	function isLoadBearing(name: string): boolean {
		const n = name.toLowerCase();
		return (
			n === 'compose.yaml' || n === 'compose.yml' ||
			n === 'docker-compose.yml' || n === 'docker-compose.yaml' ||
			n === '.env' || n.startsWith('.env.')
		);
	}

	// An entry the user cannot deselect HERE: either load-bearing (always kept) or captured via
	// its own bind/volume channel (controlled in the Volumes section, not here).
	function isLocked(e: Entry): boolean {
		return isLoadBearing(e.name) || e.capturedAs != null;
	}

	const entries = $derived(listing?.kind === 'listed' ? listing.entries : []);
	const selectable = $derived(entries.filter((e) => !isLocked(e)));
	// "All files" is on when nothing selectable is excluded.
	const allFiles = $derived(excludedStackFiles.length === 0);

	function toggleAll(on: boolean) {
		excludedStackFiles = on ? [] : selectable.map((e) => e.name);
	}

	function toggleEntry(e: Entry) {
		if (isLocked(e)) return;
		excludedStackFiles = excludedStackFiles.includes(e.name)
			? excludedStackFiles.filter((n) => n !== e.name)
			: [...excludedStackFiles, e.name];
	}

	function fmtSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<div class="space-y-2">
	<div class="text-sm font-medium">Stack files on the host</div>

	{#if loading}
		<div class="flex items-center gap-2 rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
			<Loader2 class="h-4 w-4 shrink-0 animate-spin" />
			Probing the host for the stack folder...
		</div>
	{:else if listing?.kind === 'listed'}
			<!-- Resolved host path callout (copied from BackupPanel's stack-path candidate). -->
			<div class="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5 text-xs">
				<FolderOpen class="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-1.5">
						<span class="font-medium text-foreground">Captured from the host at</span>
						<Tooltip.Root>
							<Tooltip.Trigger type="button" class="text-muted-foreground hover:text-foreground">
								<HelpCircle class="h-3.5 w-3.5" />
							</Tooltip.Trigger>
							<Tooltip.Content class="w-80 z-[200]" side="right">
								<div class="space-y-2">
									<p class="font-medium">Where this path comes from</p>
									{#if envKind === 'socket'}
										<p class="flex items-center gap-1.5 text-muted-foreground">
											{#if envIcon && envId != null}<EnvironmentIcon icon={envIcon} {envId} class="h-3.5 w-3.5 shrink-0" />{/if}
											<Unplug class="h-3.5 w-3.5 shrink-0 text-cyan-500" />
											<span><span class="font-medium text-foreground">{envLabel}</span> is a socket
											environment. Backup reads the stack folder from Dockhand's own stack
											directory on this host.</span>
										</p>
										<p class="text-muted-foreground">
											If this path looks wrong, set <code class="bg-muted px-1 rounded">HOST_DATA_DIR</code>
											when Dockhand runs in a container, so it points to where the data volume
											lives on the host.
										</p>
									{:else if envKind === 'direct'}
										<p class="flex items-center gap-1.5 text-muted-foreground">
											{#if envIcon && envId != null}<EnvironmentIcon icon={envIcon} {envId} class="h-3.5 w-3.5 shrink-0" />{/if}
											<Icon iconNode={whale} class="h-3.5 w-3.5 shrink-0 text-blue-500" />
											<span><span class="font-medium text-foreground">{envLabel}</span> is a direct
											environment. Backup reads the stack folder from this path on the remote
											Docker host.</span>
										</p>
										{#if configuredStackPath}
											<p class="text-muted-foreground">
												Remote stack path set on this environment:
												<code class="bg-muted px-1 rounded break-all">{configuredStackPath}</code>
											</p>
										{:else}
											<p class="text-muted-foreground">
												It is derived from the stack's bind mounts. To set it explicitly, use
												<span class="font-medium text-foreground">Environments &gt; (edit) &gt; Remote stack path (for backup)</span>
												and re-open this dialog.
											</p>
										{/if}
									{:else}
										<p class="flex items-center gap-1.5 text-muted-foreground">
											{#if envIcon && envId != null}<EnvironmentIcon icon={envIcon} {envId} class="h-3.5 w-3.5 shrink-0" />{/if}
											{#if connectionType === 'hawser-edge'}
												<UndoDot class="h-3.5 w-3.5 shrink-0 text-green-500" />
											{:else}
												<Route class="h-3.5 w-3.5 shrink-0 text-purple-500" />
											{/if}
											<span><span class="font-medium text-foreground">{envLabel}</span> is a Hawser
											environment. Backup reads the stack folder from the Hawser agent's stack
											directory on its host.</span>
										</p>
										{#if configuredStackPath}
											<p class="text-muted-foreground">
												Remote stack path set on this environment:
												<code class="bg-muted px-1 rounded break-all">{configuredStackPath}</code>
											</p>
										{:else}
											<p class="text-muted-foreground">
												It defaults to <code class="bg-muted px-1 rounded">/data/stacks</code>. If the
												agent uses a custom <code class="bg-muted px-1 rounded">STACKS_DIR</code>, set it
												under <span class="font-medium text-foreground">Environments &gt; (edit) &gt; Remote stack path (for backup)</span>
												and re-open this dialog.
											</p>
										{/if}
									{/if}
								</div>
							</Tooltip.Content>
						</Tooltip.Root>
					</div>
					<div class="mt-0.5 break-all font-mono text-muted-foreground">{listing.hostPath}</div>
				</div>
			</div>

		<div class="border rounded-md overflow-hidden">
			<div class="flex items-center gap-3 px-3 py-2 bg-muted/30 border-b">
				<Label class="text-xs">Backup all files ({selectable.length})</Label>
				<TogglePill checked={allFiles} onLabel="Yes" offLabel="No" onchange={() => toggleAll(!allFiles)} />
			</div>
			<div class="divide-y max-h-40 overflow-y-auto">
				{#each entries as entry}
					{@const locked = isLocked(entry)}
					<label class="flex items-center gap-2 px-3 py-1.5 text-xs" class:cursor-pointer={!allFiles && !locked} class:opacity-60={locked}>
						<Checkbox
							checked={!excludedStackFiles.includes(entry.name)}
							disabled={allFiles || locked}
							onCheckedChange={() => toggleEntry(entry)}
							class="h-3.5 w-3.5"
						/>
						{#if entry.type === 'dir'}
							<Folder class="h-3.5 w-3.5 shrink-0 text-sky-500" />
						{:else}
							<FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						{/if}
						<span class="font-mono truncate">{entry.name}</span>
						{#if entry.capturedAs}
							<span class="text-muted-foreground ml-auto shrink-0 italic">captured as a {entry.capturedAs} below</span>
						{:else if isLoadBearing(entry.name)}
							<span class="text-muted-foreground ml-auto shrink-0 italic">always kept</span>
						{:else if entry.type === 'file'}
							<span class="text-muted-foreground ml-auto shrink-0">{fmtSize(entry.size)}</span>
						{/if}
					</label>
				{/each}
			</div>
		</div>
	{:else if listing?.kind === 'helper-failed'}
		<!-- The probe helper container couldn't run on the target. A backup can't run either (it
		     uses the same helper), so this is a hard block, not a soft warning. -->
		<div class="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2.5 text-xs">
			<AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
			<div class="min-w-0">
				<div class="font-medium text-destructive">The backup helper can't run on this environment</div>
				<div class="mt-0.5 break-all text-muted-foreground">{listing.reason}</div>
				<div class="mt-1 text-muted-foreground">A backup can't be created until this is fixed - the same helper container captures the stack files.</div>
			</div>
		</div>
	{:else if listing?.kind === 'unknown'}
		<div class="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5 text-xs">
			<Info class="mt-0.5 h-4 w-4 shrink-0 text-sky-500" />
			<div class="min-w-0">
				<div class="font-medium text-foreground">No stack folder found on the host</div>
				<div class="mt-0.5 text-muted-foreground">{listing.reason}</div>
				{#if envKind === 'socket'}
					<div class="mt-1 text-muted-foreground">On a socket environment this usually means <code class="bg-muted px-1 rounded">HOST_DATA_DIR</code> does not match where the data volume is mounted on the host. Fix it, then cancel and re-configure this backup.</div>
				{:else if envKind === 'direct'}
					<div class="mt-1 text-muted-foreground">Set the environment's stack path (Environments &gt; edit &gt; Remote stack path for backup), then cancel and re-configure this backup.</div>
				{:else}
					<div class="mt-1 text-muted-foreground">On Hawser this usually means the agent uses a custom <code class="bg-muted px-1 rounded">STACKS_DIR</code> (not the default <code class="bg-muted px-1 rounded">/data/stacks</code>). Set the environment's stack path (Environments &gt; edit &gt; Remote stack path for backup), then cancel and re-configure this backup.</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
