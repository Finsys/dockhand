<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Loader2, Network } from 'lucide-svelte';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { formatDateTime } from '$lib/stores/settings';
	import ContainerTile from '../containers/ContainerTile.svelte';
	import ContainerInspectModal from '../containers/ContainerInspectModal.svelte';

	interface Props {
		open: boolean;
		networkId: string;
		networkName?: string;
	}

	let { open = $bindable(), networkId, networkName }: Props = $props();

	let loading = $state(true);
	let error = $state('');
	let networkData = $state<any>(null);

	// Container inspect modal state
	let showContainerInspect = $state(false);
	let inspectContainerId = $state('');
	let inspectContainerName = $state('');

	function openContainerInspect(containerId: string, containerName: string) {
		inspectContainerId = containerId;
		inspectContainerName = containerName;
		showContainerInspect = true;
	}

	$effect(() => {
		if (open && networkId) {
			fetchNetworkInspect();
		}
	});

	async function fetchNetworkInspect() {
		loading = true;
		error = '';
		try {
			const envId = $currentEnvironment?.id ?? null;
			const response = await fetch(appendEnvParam(`/api/networks/${networkId}/inspect`, envId));
			if (!response.ok) {
				throw new Error('Failed to fetch network details');
			}
			networkData = await response.json();
		} catch (err: any) {
			error = err.message || 'Failed to load network details';
			console.error('Failed to fetch network inspect:', err);
		} finally {
			loading = false;
		}
	}

	function formatNetworkDate(dateString: string): string {
		if (!dateString) return 'N/A';
		return formatDateTime(dateString, true);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-4xl max-h-[90vh] flex flex-col">
		<Dialog.Header class="shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				<Network class="w-5 h-5" />
				Network details: <span class="text-muted-foreground font-normal">{networkName || networkId.slice(0, 12)}</span>
			</Dialog.Title>
		</Dialog.Header>

		<div class="flex-1 overflow-auto space-y-4 min-h-0">
			{#if loading}
				<div class="flex items-center justify-center py-8">
					<Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
				</div>
			{:else if error}
				<div class="text-sm text-red-600 dark:text-red-400 p-3 bg-red-50 dark:bg-red-950 rounded">
					{error}
				</div>
			{:else if networkData}
				<!-- Basic Info -->
				<div class="space-y-3">
					<h3 class="text-sm font-semibold">Basic information</h3>
					<div class="grid grid-cols-2 gap-3 text-sm">
						<div>
							<p class="text-muted-foreground">Name</p>
							<p class="font-medium">{networkData.Name}</p>
						</div>
						<div>
							<p class="text-muted-foreground">ID</p>
							<code class="text-xs">{networkData.Id?.slice(0, 12)}</code>
						</div>
						<div>
							<p class="text-muted-foreground">Driver</p>
							<Badge variant="outline">{networkData.Driver}</Badge>
						</div>
						<div>
							<p class="text-muted-foreground">Scope</p>
							<Badge variant="secondary">{networkData.Scope}</Badge>
						</div>
						<div>
							<p class="text-muted-foreground">Created</p>
							<p>{formatNetworkDate(networkData.Created)}</p>
						</div>
						<div>
							<p class="text-muted-foreground">Internal</p>
							<Badge variant={networkData.Internal ? 'destructive' : 'secondary'}>
								{networkData.Internal ? 'Yes' : 'No'}
							</Badge>
						</div>
					</div>
				</div>

				<!-- IPAM Configuration -->
				{#if networkData.IPAM}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">IPAM configuration</h3>
						<div class="space-y-2">
							<div class="text-sm">
								<p class="text-muted-foreground">Driver</p>
								<p>{networkData.IPAM.Driver || 'default'}</p>
							</div>
							{#if networkData.IPAM.Config && networkData.IPAM.Config.length > 0}
								<div class="space-y-2">
									<p class="text-muted-foreground text-sm">Subnets</p>
									{#each networkData.IPAM.Config as config}
										<div class="p-2 bg-muted rounded text-sm space-y-1">
											{#if config.Subnet}
												<div class="flex justify-between">
													<span class="text-muted-foreground">Subnet:</span>
													<code>{config.Subnet}</code>
												</div>
											{/if}
											{#if config.Gateway}
												<div class="flex justify-between">
													<span class="text-muted-foreground">Gateway:</span>
													<code>{config.Gateway}</code>
												</div>
											{/if}
											{#if config.IPRange}
												<div class="flex justify-between">
													<span class="text-muted-foreground">IP Range:</span>
													<code>{config.IPRange}</code>
												</div>
											{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<!-- Connected Containers -->
				{#if networkData.Containers && Object.keys(networkData.Containers).length > 0}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">Connected containers ({Object.keys(networkData.Containers).length})</h3>
						<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
							{#each Object.entries(networkData.Containers) as [id, container]}
								<ContainerTile
									containerId={id}
									containerName={container.Name}
									ipv4Address={container.IPv4Address}
									ipv6Address={container.IPv6Address}
									macAddress={container.MacAddress}
									onclick={() => openContainerInspect(id, container.Name)}
								/>
							{/each}
						</div>
					</div>
				{:else}
					<div class="text-sm text-muted-foreground text-center py-4">
						No containers connected to this network
					</div>
				{/if}

				<!-- Options -->
				{#if networkData.Options && Object.keys(networkData.Options).length > 0}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">Driver options</h3>
						<div class="space-y-1">
							{#each Object.entries(networkData.Options) as [key, value]}
								<div class="flex justify-between text-sm p-2 bg-muted rounded">
									<code class="text-muted-foreground">{key}</code>
									<code>{value}</code>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Labels -->
				{#if networkData.Labels && Object.keys(networkData.Labels).length > 0}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">Labels</h3>
						<div class="space-y-1">
							{#each Object.entries(networkData.Labels) as [key, value]}
								<div class="flex justify-between text-sm p-2 bg-muted rounded">
									<code class="text-muted-foreground">{key}</code>
									<code>{value}</code>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		</div>

		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ContainerInspectModal
	bind:open={showContainerInspect}
	containerId={inspectContainerId}
	containerName={inspectContainerName}
/>
