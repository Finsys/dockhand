<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Plus, Minus, FileEdit, FileCheck, Loader2, ArrowRight, FolderOpen, Container, Info } from 'lucide-svelte';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import { formatDateTime } from '$lib/stores/settings';

	interface Props {
		open: boolean;
		destinationId: number;
		snapshotA: { id: string; shortId: string; time: string };
		snapshotB: { id: string; shortId: string; time: string };
	}

	let { open = $bindable(), destinationId, snapshotA, snapshotB }: Props = $props();

	interface DiffResult {
		added: string[];
		removed: string[];
		modified: string[];
		metadataChanged: string[];
	}

	let activeTab = $state<'files' | 'metadata'>('files');
	let loading = $state(true);
	let error = $state<string | null>(null);
	let diff = $state<DiffResult | null>(null);
	let metaA = $state<any>(null);
	let metaB = $state<any>(null);
	let metaLoading = $state(false);

	$effect(() => {
		if (open && snapshotA?.id && snapshotB?.id) {
			activeTab = 'files';
			fetchDiff();
		}
	});

	async function fetchDiff() {
		loading = true;
		error = null;
		diff = null;
		metaA = null;
		metaB = null;
		try {
			// Job-polling so the two `restic diff` reads behind a proxy aren't aborted at ~15s.
			const res = await fetch(`/api/backup/snapshots/diff?destinationId=${destinationId}&snapshotA=${snapshotA.id}&snapshotB=${snapshotB.id}`, { headers: { Accept: 'text/event-stream' } });
			const data = await readJobResponse(res);
			if (data?.error) { error = data.error; return; }
			diff = data;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function loadMetadata() {
		if (metaA && metaB) return;
		metaLoading = true;
		try {
			// Job-polling for both metadata dumps (slow `restic dump` behind a proxy).
			const [dataA, dataB] = await Promise.all([
				fetch(`/api/backup/snapshots/${snapshotA.id}/metadata?destinationId=${destinationId}`, { headers: { Accept: 'text/event-stream' } }).then(readJobResponse),
				fetch(`/api/backup/snapshots/${snapshotB.id}/metadata?destinationId=${destinationId}`, { headers: { Accept: 'text/event-stream' } }).then(readJobResponse)
			]);
			metaA = dataA?.error ? null : dataA;
			metaB = dataB?.error ? null : dataB;
		} catch {}
		metaLoading = false;
	}

	function switchToMetadata() {
		activeTab = 'metadata';
		loadMetadata();
	}

	const totalChanges = $derived(diff ? diff.added.length + diff.removed.length + diff.modified.length + diff.metadataChanged.length : 0);

	// Compute metadata differences
	interface MetaDiff { field: string; valueA: string; valueB: string }
	const metaDiffs = $derived.by(() => {
		if (!metaA?.containers?.[0] || !metaB?.containers?.[0]) return [];
		const a = metaA.containers[0];
		const b = metaB.containers[0];
		const diffs: MetaDiff[] = [];

		function compare(field: string, va: any, vb: any) {
			const sa = typeof va === 'object' ? JSON.stringify(va, null, 2) : String(va ?? '—');
			const sb = typeof vb === 'object' ? JSON.stringify(vb, null, 2) : String(vb ?? '—');
			if (sa !== sb) diffs.push({ field, valueA: sa, valueB: sb });
		}

		compare('Image', a.image, b.image);
		compare('Cmd', a.config?.Cmd, b.config?.Cmd);
		compare('Entrypoint', a.config?.Entrypoint, b.config?.Entrypoint);
		compare('Env', a.config?.Env, b.config?.Env);
		compare('Labels', a.config?.Labels, b.config?.Labels);
		compare('Hostname', a.config?.Hostname, b.config?.Hostname);
		compare('User', a.config?.User, b.config?.User);
		compare('WorkingDir', a.config?.WorkingDir, b.config?.WorkingDir);
		compare('RestartPolicy', a.hostConfig?.RestartPolicy, b.hostConfig?.RestartPolicy);
		compare('NetworkMode', a.hostConfig?.NetworkMode, b.hostConfig?.NetworkMode);
		compare('PortBindings', a.hostConfig?.PortBindings, b.hostConfig?.PortBindings);
		compare('Privileged', a.hostConfig?.Privileged, b.hostConfig?.Privileged);
		compare('Memory', a.hostConfig?.Memory, b.hostConfig?.Memory);
		compare('CpuShares', a.hostConfig?.CpuShares, b.hostConfig?.CpuShares);
		compare('Mounts', a.mounts?.length, b.mounts?.length);
		compare('Networks', Object.keys(a.networkSettings?.Networks || {}), Object.keys(b.networkSettings?.Networks || {}));

		return diffs;
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-5xl max-h-[85vh] flex flex-col">
		<Dialog.Header>
			<Dialog.Title>Snapshot comparison</Dialog.Title>
			<Dialog.Description>
				<span class="font-mono text-xs">{snapshotA.shortId}</span>
				<span class="text-muted-foreground text-xs mx-1">({formatDateTime(snapshotA.time)})</span>
				<ArrowRight class="w-3 h-3 inline mx-1" />
				<span class="font-mono text-xs">{snapshotB.shortId}</span>
				<span class="text-muted-foreground text-xs mx-1">({formatDateTime(snapshotB.time)})</span>
			</Dialog.Description>
		</Dialog.Header>

		<!-- Tabs -->
		<div class="flex gap-1 border-b mb-3">
			<button class="px-3 py-1.5 text-sm {activeTab === 'files' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}" onclick={() => activeTab = 'files'}>
				<FolderOpen class="w-3.5 h-3.5 inline mr-1" />Files
			</button>
			<button class="px-3 py-1.5 text-sm {activeTab === 'metadata' ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}" onclick={switchToMetadata}>
				<Container class="w-3.5 h-3.5 inline mr-1" />Metadata
			</button>
		</div>

		<div class="flex-1 min-h-[400px] overflow-y-auto pr-3">
		{#if activeTab === 'files'}
			{#if loading}
				<div class="flex items-center justify-center py-12">
					<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
					<span class="ml-2 text-sm text-muted-foreground">Comparing snapshots...</span>
				</div>
			{:else if error}
				<div class="text-sm text-destructive py-4">{error}</div>
			{:else if diff}
				<div class="flex gap-2 mb-3 flex-wrap">
					{#if diff.added.length > 0}
						<Badge variant="outline" class="text-green-600"><Plus class="w-3 h-3 mr-1" />{diff.added.length} added</Badge>
					{/if}
					{#if diff.removed.length > 0}
						<Badge variant="outline" class="text-red-500"><Minus class="w-3 h-3 mr-1" />{diff.removed.length} removed</Badge>
					{/if}
					{#if diff.modified.length > 0}
						<Badge variant="outline" class="text-amber-500"><FileEdit class="w-3 h-3 mr-1" />{diff.modified.length} modified</Badge>
					{/if}
					{#if diff.metadataChanged.length > 0}
						<Badge variant="outline" class="text-blue-500"><FileCheck class="w-3 h-3 mr-1" />{diff.metadataChanged.length} metadata</Badge>
					{/if}
					{#if totalChanges === 0}
						<span class="text-sm text-muted-foreground">No differences found</span>
					{/if}
				</div>

				<div class="border rounded-md bg-muted/30 p-2 font-mono text-xs space-y-0.5">
					{#each diff.added as path}
						<div class="text-green-600">+ {path}</div>
					{/each}
					{#each diff.removed as path}
						<div class="text-red-500">- {path}</div>
					{/each}
					{#each diff.modified as path}
						<div class="text-amber-500">M {path}</div>
					{/each}
					{#each diff.metadataChanged as path}
						<div class="text-blue-500">U {path}</div>
					{/each}
				</div>
			{/if}
		{:else if activeTab === 'metadata'}
			{#if metaLoading}
				<div class="flex items-center justify-center py-12">
					<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
					<span class="ml-2 text-sm text-muted-foreground">Loading metadata...</span>
				</div>
			{:else if !metaA || !metaB}
				<p class="text-sm text-muted-foreground py-4">Metadata not available for one or both snapshots.</p>
			{:else if metaDiffs.length === 0}
				<p class="py-4 text-sm text-muted-foreground">The container configuration is identical (image, command, env, ports, mounts, networks, …).</p>
				<p class="flex items-start gap-1.5 text-xs text-muted-foreground"><Info class="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /><span>If the Files tab shows <span class="font-mono">metadata.json</span> as modified, that's the capture timestamp / recorded container state inside it changing between backups — not a config change.</span></p>
			{:else}
				<table class="w-full text-xs">
					<thead class="sticky top-0 bg-background">
						<tr class="border-b text-muted-foreground">
							<th class="text-left py-1.5 px-2 w-32">Field</th>
							<th class="text-left py-1.5 px-2">{snapshotA.shortId}</th>
							<th class="text-left py-1.5 px-2">{snapshotB.shortId}</th>
						</tr>
					</thead>
					<tbody>
						{#each metaDiffs as d}
							<tr class="border-b last:border-0 hover:bg-muted/30">
								<td class="py-1.5 px-2 font-medium text-muted-foreground align-top">{d.field}</td>
								<td class="py-1.5 px-2 align-top">
									<pre class="whitespace-pre-wrap text-red-500/80 bg-red-500/5 rounded px-1 max-h-32 overflow-auto">{d.valueA}</pre>
								</td>
								<td class="py-1.5 px-2 align-top">
									<pre class="whitespace-pre-wrap text-green-600/80 bg-green-500/5 rounded px-1 max-h-32 overflow-auto">{d.valueB}</pre>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
