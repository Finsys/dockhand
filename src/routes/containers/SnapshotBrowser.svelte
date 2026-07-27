<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Badge } from '$lib/components/ui/badge';
	import {
		FolderOpen, Box, Layers, Network, Loader2, HardDrive, Tag, Variable,
		Plug, HeartPulse, ScrollText, ShieldAlert, Server, Globe, Cpu, FileText
	} from 'lucide-svelte';
	import MountTypeBadge from '$lib/components/MountTypeBadge.svelte';
	import { getRepoTypeIcon } from '$lib/utils/backup';
	import { formatBytes } from '$lib/utils/format';
	import { formatDateTime } from '$lib/stores/settings';
	import { environments } from '$lib/stores/environment';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import FileBrowserPanel from './FileBrowserPanel.svelte';

	interface Props {
		open: boolean;
		destinationId: number;
		snapshotId: string;
		targetName?: string;
		targetType?: 'container' | 'stack';
		environmentId?: number;
	}

	let { open = $bindable(), destinationId, snapshotId, targetName, targetType, environmentId }: Props = $props();

	let activeTab = $state<'files' | 'metadata'>('files');
	let metadata = $state<any>(null);
	let metadataLoading = $state(false);
	let metadataError = $state('');
	let snapshotTime = $state('');
	let destinationName = $state('');
	let destinationRepo = $state('');
	let snapshotEnvName = $state('');
	let snapshotEnvIcon = $state('globe');
	let snapshotEnvId = $state(0);

	$effect(() => {
		if (open && snapshotId) {
			activeTab = 'files';
			metadata = null;
			metadataError = '';
			snapshotTime = '';
			destinationName = '';
			destinationRepo = '';
			snapshotEnvName = '';
			snapshotEnvIcon = 'globe';
			snapshotEnvId = 0;
			fetchMetadata();
			fetchSnapshotInfo();
		}
	});

	const displayName = $derived(targetName || metadata?.targetName || '');
	// The backup stores a full docker inspect (PascalCase keys) as metadata.container
	// (singular) for container targets; null for stacks.
	const containerInspect = $derived<any>(metadata?.container ?? null);

	async function fetchSnapshotInfo() {
		try {
			// Get destination name
			const destRes = await fetch(`/api/backup/destinations/${destinationId}`);
			if (destRes.ok) {
				const dest = await destRes.json();
				destinationName = dest.name || '';
				destinationRepo = dest.repository || '';
			}
			// Get snapshot time + owning environment from the snapshot's tags.
			const snapRes = await fetch(`/api/backup/snapshots?destinationId=${destinationId}`);
			if (snapRes.ok) {
				const d = await snapRes.json();
				const snaps = d.snapshots ?? d;
				const snap = (Array.isArray(snaps) ? snaps : []).find((s: any) => s.id === snapshotId || s.shortId === snapshotId?.slice(0, 8));
				if (snap) {
					snapshotTime = snap.time;
					// dockhand:envid=<n> tag identifies the source environment ('local' = none).
					const envTag = (snap.tags || []).find((t: string) => t.startsWith('dockhand:envid='))?.replace('dockhand:envid=', '');
					const envId = envTag && envTag !== 'local' ? parseInt(envTag) : NaN;
					if (!isNaN(envId)) {
						const env = $environments.find((e) => e.id === envId);
						if (env) { snapshotEnvName = env.name; snapshotEnvIcon = env.icon || 'globe'; snapshotEnvId = env.id; }
					}
				}
			}
		} catch {}
	}

	async function fetchMetadata() {
		metadataLoading = true;
		metadataError = '';
		try {
			const res = await fetch(`/api/backup/snapshots/${snapshotId}/metadata?destinationId=${destinationId}`);
			if (res.ok) {
				metadata = await res.json();
			} else {
				try { metadataError = (await res.json()).error || 'No metadata available'; }
				catch { metadataError = 'No metadata available'; }
			}
		} catch { metadataError = 'Failed to load metadata'; }
		finally { metadataLoading = false; }
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-4xl h-[90vh] sm:h-[80vh] flex flex-col overflow-hidden">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2 flex-wrap">
				<FolderOpen class="w-5 h-5" />
				Browse snapshot
				{#if snapshotEnvName}
					<span class="text-muted-foreground font-normal">from</span>
					<EnvironmentIcon icon={snapshotEnvIcon} envId={snapshotEnvId} class="w-4 h-4 text-amber-600 dark:text-amber-400" />
					<span class="font-normal text-amber-600 dark:text-amber-400">{snapshotEnvName}</span>
				{/if}
				{#if displayName}
					<span class="text-muted-foreground font-normal">—</span>
					{#if (targetType || metadata?.type) === 'stack'}
						<Layers class="w-4 h-4 text-purple-500" />
					{:else}
						<Box class="w-4 h-4 text-blue-500" />
					{/if}
					<span class="font-normal">{displayName}</span>
				{/if}
				{#if destinationName}
					<span class="text-muted-foreground font-normal">on</span>
					<svelte:component this={getRepoTypeIcon(destinationRepo)} class="w-4 h-4" />
					<span class="font-normal">{destinationName}</span>
				{/if}
			</Dialog.Title>
			<Dialog.Description class="flex items-center gap-2 text-xs text-muted-foreground">
				{#if snapshotId}<Badge variant="outline" class="font-mono text-[10px]">{String(snapshotId).slice(0, 8)}</Badge>{/if}
				{#if snapshotTime}{formatDateTime(snapshotTime)}{/if}
			</Dialog.Description>
		</Dialog.Header>

		<!-- Tabs -->
		<div class="flex gap-1 border-b pb-0 shrink-0">
			<button
				type="button"
				class="px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px {activeTab === 'files' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => activeTab = 'files'}
			>
				Files
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm transition-colors border-b-2 -mb-px {activeTab === 'metadata' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => activeTab = 'metadata'}
			>
				Metadata
			</button>
		</div>

		<!-- Keep BOTH panels mounted and toggle visibility with `hidden` instead of
		     {#if}/{:else}. An {#if} destroys FileBrowserPanel on every switch to
		     Metadata, so returning to Files re-runs its load $effect and re-browses
		     the snapshot from the (possibly remote) restic repo each time. Keeping it
		     alive preserves the already-loaded directory + current path — no repeat
		     round-trip. -->
		<div class="flex-1 overflow-hidden border rounded-lg" class:hidden={activeTab !== 'files'}>
			<FileBrowserPanel
				{snapshotId}
				{destinationId}
				canEdit={false}
			/>
		</div>

		<!-- Metadata tab -->
		{#if activeTab === 'metadata'}
			<div class="flex-1 overflow-y-auto py-3">
				{#if metadataLoading}
					<div class="flex items-center justify-center py-8"><Loader2 class="w-5 h-5 animate-spin text-muted-foreground" /></div>
				{:else if metadataError}
					<p class="text-sm text-muted-foreground p-4">{metadataError}</p>
				{:else if metadata}
					<div class="max-w-2xl space-y-5 px-1">
						<!-- Backup info -->
						<section class="space-y-2">
							<h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Backup info</h4>
							<dl class="grid grid-cols-[130px_1fr] gap-y-1.5 text-sm">
								<dt class="text-muted-foreground">Type</dt>
								<dd><Badge variant="outline" class="text-[10px]">{metadata.type}</Badge></dd>
								<dt class="text-muted-foreground">Name</dt>
								<dd class="font-medium">{metadata.targetName}</dd>
								<dt class="text-muted-foreground">Backup time</dt>
								<dd>{formatDateTime(metadata.backupTime)}</dd>
								{#if metadata.environmentId != null}
									<dt class="text-muted-foreground">Environment ID</dt>
									<dd class="font-mono text-xs">{metadata.environmentId}</dd>
								{/if}
								<dt class="text-muted-foreground">Volumes</dt>
								<dd>{metadata.volumes?.length ?? 0}</dd>
								{#if metadata.type === 'stack'}
									{#if metadata.composeFileName}
										<dt class="text-muted-foreground">Compose file</dt>
										<dd class="font-mono text-xs">{metadata.composeFileName}</dd>
									{/if}
									<dt class="text-muted-foreground">Stack files</dt>
									<dd>{metadata.hasStackFiles ? (metadata.stackFilesTruncated ? 'captured (truncated)' : 'captured') : 'not captured'}</dd>
								{/if}
							</dl>
						</section>

						<!-- Volumes / binds -->
						{#if metadata.volumes?.length}
							<section class="space-y-2 border-t pt-4">
								<h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><HardDrive class="w-3.5 h-3.5" />Volumes &amp; binds ({metadata.volumes.length})</h4>
								<div class="space-y-1">
									{#each metadata.volumes as vol}
										<!-- Docker convention: source (host path / volume name) → destination
										     (container path). `vol.source` is the host path/volume name,
										     `vol.name` is the container destination. -->
										<div class="flex items-center gap-2 text-sm bg-muted/30 rounded px-2 py-1.5">
											<MountTypeBadge type={vol.type} />
											{#if vol.source && vol.source !== vol.name}
												<span class="font-mono text-muted-foreground truncate">{vol.source}</span>
												<span class="text-muted-foreground shrink-0">→</span>
												<span class="font-medium truncate">{vol.name || vol.key}</span>
											{:else}
												<span class="font-medium truncate">{vol.name || vol.key}</span>
											{/if}
										</div>
									{/each}
								</div>
							</section>
						{/if}

						<!-- Stack files (captured under stackfiles/). The list is recorded in
						     metadata.json at backup time so we can enumerate the exact files
						     without a browse roundtrip. -->
						{#if metadata.type === 'stack' && metadata.stackFilesList?.length}
							<section class="space-y-2 border-t pt-4">
								<h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5"><FileText class="w-3.5 h-3.5" />Stack files ({metadata.stackFilesList.length}{metadata.stackFilesListTruncated ? '+' : ''})</h4>
								<div class="space-y-1">
									{#each metadata.stackFilesList as file}
										<div class="flex items-center gap-2 text-sm bg-muted/30 rounded px-2 py-1.5">
											<span class="font-mono truncate flex-1" class:font-medium={file.path === metadata.composeFileName}>{file.path}</span>
											{#if file.path === metadata.composeFileName}
												<Badge variant="outline" class="text-[10px] shrink-0">compose</Badge>
											{/if}
											<span class="text-muted-foreground text-xs shrink-0 tabular-nums">{formatBytes(file.bytes)}</span>
										</div>
									{/each}
								</div>
								{#if metadata.stackFilesListTruncated}
									<p class="text-xs text-muted-foreground">Only the first {metadata.stackFilesList.length} files are listed. Browse the snapshot to see the full tree.</p>
								{/if}
							</section>
						{/if}

						<!-- Container config (docker inspect, PascalCase, singular). Only for
						     container targets — stacks have no metadata.container. -->
						{#if containerInspect?.Config}
							<section class="space-y-2 border-t pt-4">
								<h4 class="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
									<Box class="w-3 h-3" />
									{(containerInspect.Name || metadata.targetName || '').replace(/^\//, '')}
								</h4>
								<dl class="grid grid-cols-[130px_1fr] gap-y-1.5 text-sm">
									<dt class="text-muted-foreground">Image</dt>
									<dd class="font-mono text-xs break-all">{containerInspect.Config.Image || '—'}</dd>
									{#if containerInspect.Id}
										<dt class="text-muted-foreground">Container ID</dt>
										<dd class="font-mono text-xs">{containerInspect.Id.slice(0, 12)}</dd>
									{/if}
									{#if containerInspect.State?.Status}
										<dt class="text-muted-foreground">State at backup</dt>
										<dd class="text-xs">{containerInspect.State.Status}</dd>
									{/if}
									{#if containerInspect.Created}
										<dt class="text-muted-foreground">Created</dt>
										<dd class="text-xs">{formatDateTime(containerInspect.Created)}</dd>
									{/if}
									{#if containerInspect.Config.Cmd?.length}
										<dt class="text-muted-foreground">Command</dt>
										<dd class="font-mono text-xs break-all">{containerInspect.Config.Cmd.join(' ')}</dd>
									{/if}
									{#if containerInspect.Config.Entrypoint?.length}
										<dt class="text-muted-foreground">Entrypoint</dt>
										<dd class="font-mono text-xs break-all">{containerInspect.Config.Entrypoint.join(' ')}</dd>
									{/if}
									{#if containerInspect.Config.WorkingDir}
										<dt class="text-muted-foreground">Working dir</dt>
										<dd class="font-mono text-xs break-all">{containerInspect.Config.WorkingDir}</dd>
									{/if}
									{#if containerInspect.Config.User}
										<dt class="text-muted-foreground">User</dt>
										<dd class="font-mono text-xs">{containerInspect.Config.User}</dd>
									{/if}
									{#if containerInspect.Config.ExposedPorts}
										<dt class="text-muted-foreground">Exposed ports</dt>
										<dd class="text-xs break-all">{Object.keys(containerInspect.Config.ExposedPorts).join(', ')}</dd>
									{/if}
									{#if containerInspect.HostConfig?.RestartPolicy?.Name}
										<dt class="text-muted-foreground">Restart policy</dt>
										<dd class="text-xs">{containerInspect.HostConfig.RestartPolicy.Name}{containerInspect.HostConfig.RestartPolicy.MaximumRetryCount ? ` (max ${containerInspect.HostConfig.RestartPolicy.MaximumRetryCount})` : ''}</dd>
									{/if}
									{#if containerInspect.HostConfig?.NetworkMode}
										<dt class="text-muted-foreground">Network mode</dt>
										<dd class="text-xs break-all">{containerInspect.HostConfig.NetworkMode}</dd>
									{/if}
									{#if containerInspect.HostConfig?.Privileged}
										<dt class="text-muted-foreground">Privileged</dt>
										<dd class="text-xs">yes</dd>
									{/if}
								</dl>

								<!-- Port bindings (host:container map — more useful than the internal
								     ExposedPorts above; only present when ports are published). -->
								{#if containerInspect.HostConfig?.PortBindings && Object.keys(containerInspect.HostConfig.PortBindings).length}
									<div class="pt-1 space-y-1.5">
										<span class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Plug class="w-3.5 h-3.5" />Port bindings</span>
										<div class="flex flex-wrap gap-1">
											{#each Object.entries(containerInspect.HostConfig.PortBindings) as [containerPort, hostArr]}
												{@const h = (hostArr as any[])?.[0]}
												<Badge variant="secondary" class="text-xs font-mono">{h?.HostIp ? `${h.HostIp}:` : ''}{h?.HostPort || '?'} → {containerPort}</Badge>
											{/each}
										</div>
									</div>
								{/if}

								<!-- Health at backup -->
								{#if containerInspect.State?.Health?.Status}
									<div class="pt-1 space-y-1.5">
										<span class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><HeartPulse class="w-3.5 h-3.5" />Health at backup</span>
										<Badge variant="outline" class="text-xs {containerInspect.State.Health.Status === 'healthy' ? 'text-green-600 border-green-600/40' : containerInspect.State.Health.Status === 'unhealthy' ? 'text-destructive border-destructive/40' : ''}">{containerInspect.State.Health.Status}</Badge>
									</div>
								{/if}

								<!-- Security flags -->
								{#if containerInspect.HostConfig?.Privileged || containerInspect.HostConfig?.ReadonlyRootfs || containerInspect.HostConfig?.CapAdd?.length || containerInspect.HostConfig?.CapDrop?.length}
									<div class="pt-1 space-y-1.5">
										<span class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><ShieldAlert class="w-3.5 h-3.5" />Security</span>
										<div class="flex flex-wrap gap-1">
											{#if containerInspect.HostConfig.Privileged}<Badge variant="outline" class="text-xs text-amber-600 border-amber-600/40">privileged</Badge>{/if}
											{#if containerInspect.HostConfig.ReadonlyRootfs}<Badge variant="outline" class="text-xs">read-only rootfs</Badge>{/if}
											{#each containerInspect.HostConfig.CapAdd ?? [] as cap}<Badge variant="outline" class="text-xs text-green-600 border-green-600/40 font-mono">+{cap}</Badge>{/each}
											{#each containerInspect.HostConfig.CapDrop ?? [] as cap}<Badge variant="outline" class="text-xs text-muted-foreground font-mono">-{cap}</Badge>{/each}
										</div>
									</div>
								{/if}

								<!-- Runtime details (log driver, stop signal, platform) -->
								{#if containerInspect.HostConfig?.LogConfig?.Type || containerInspect.Config?.StopSignal || containerInspect.Platform}
									<div class="pt-1 space-y-1.5">
										<span class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Server class="w-3.5 h-3.5" />Runtime</span>
										<dl class="grid grid-cols-[130px_1fr] gap-y-1 text-sm">
											{#if containerInspect.HostConfig?.LogConfig?.Type}
												<dt class="text-muted-foreground flex items-center gap-1.5"><ScrollText class="w-3.5 h-3.5" />Log driver</dt>
												<dd class="font-mono text-xs">{containerInspect.HostConfig.LogConfig.Type}</dd>
											{/if}
											{#if containerInspect.Config?.StopSignal}
												<dt class="text-muted-foreground">Stop signal</dt>
												<dd class="font-mono text-xs">{containerInspect.Config.StopSignal}</dd>
											{/if}
											{#if containerInspect.Platform}
												<dt class="text-muted-foreground flex items-center gap-1.5"><Cpu class="w-3.5 h-3.5" />Platform</dt>
												<dd class="font-mono text-xs">{containerInspect.Platform}</dd>
											{/if}
										</dl>
									</div>
								{/if}

								<!-- DNS / extra hosts -->
								{#if containerInspect.HostConfig?.Dns?.length || containerInspect.HostConfig?.ExtraHosts?.length}
									<div class="pt-1 space-y-1.5">
										<span class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Globe class="w-3.5 h-3.5" />DNS &amp; hosts</span>
										<div class="flex flex-wrap gap-1">
											{#each containerInspect.HostConfig.Dns ?? [] as dns}<Badge variant="secondary" class="text-xs font-mono">DNS {dns}</Badge>{/each}
											{#each containerInspect.HostConfig.ExtraHosts ?? [] as host}<Badge variant="secondary" class="text-xs font-mono">{host}</Badge>{/each}
										</div>
									</div>
								{/if}

								<!-- Networks -->
								{#if containerInspect.NetworkSettings?.Networks && Object.keys(containerInspect.NetworkSettings.Networks).length}
									<div class="pt-1 space-y-1.5">
										<span class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Network class="w-3.5 h-3.5" />Networks</span>
										<div class="flex flex-wrap gap-1">
											{#each Object.entries(containerInspect.NetworkSettings.Networks) as [net, cfg]}
												<Badge variant="secondary" class="text-xs"><Network class="w-3.5 h-3.5 mr-1" />{net}{(cfg as any)?.IPAddress ? ` (${(cfg as any).IPAddress})` : ''}</Badge>
											{/each}
										</div>
									</div>
								{/if}

								<!-- Labels -->
								{#if containerInspect.Config.Labels && Object.keys(containerInspect.Config.Labels).length}
									<div class="pt-1 space-y-1.5">
										<span class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Tag class="w-3.5 h-3.5" />Labels ({Object.keys(containerInspect.Config.Labels).length})</span>
										<div class="max-h-40 overflow-y-auto text-sm font-mono bg-muted/20 rounded p-2 space-y-0.5">
											{#each Object.entries(containerInspect.Config.Labels) as [key, value]}
												<div class="truncate"><span class="text-muted-foreground">{key}</span>=<span>{value}</span></div>
											{/each}
										</div>
									</div>
								{/if}

								<!-- Env vars (values masked) -->
								{#if containerInspect.Config.Env?.length}
									<div class="pt-1 space-y-1.5">
										<span class="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><Variable class="w-3.5 h-3.5" />Environment variables ({containerInspect.Config.Env.length})</span>
										<div class="max-h-40 overflow-y-auto text-sm font-mono bg-muted/20 rounded p-2 space-y-0.5">
											{#each containerInspect.Config.Env as envVar}
												{@const eqIdx = envVar.indexOf('=')}
												<div class="truncate">
													<span class="text-muted-foreground">{eqIdx > 0 ? envVar.slice(0, eqIdx) : envVar}</span>{#if eqIdx > 0}=<span>***</span>{/if}
												</div>
											{/each}
										</div>
									</div>
								{/if}
							</section>
						{/if}
					</div>
				{:else}
					<p class="text-sm text-muted-foreground p-4">No metadata available for this snapshot</p>
				{/if}
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
