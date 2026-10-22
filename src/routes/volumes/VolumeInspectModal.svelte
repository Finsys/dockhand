<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Loader2, HardDrive, Layers } from 'lucide-svelte';
	import { goto } from '$app/navigation';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import ModalHeader from '$lib/components/ModalHeader.svelte';
	import { formatDateTime } from '$lib/stores/settings';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		volumeName: string;
	}

	let { open = $bindable(), volumeName }: Props = $props();

	let loading = $state(true);
	let error = $state('');
	let volumeData = $state<any>(null);

	$effect(() => {
		if (open && volumeName) {
			fetchVolumeInspect();
		}
	});

	async function fetchVolumeInspect() {
		loading = true;
		error = '';
		try {
			const envId = $currentEnvironment?.id ?? null;
			const response = await fetch(appendEnvParam(`/api/volumes/${encodeURIComponent(volumeName)}/inspect`, envId));
			if (!response.ok) {
				throw new Error(m.volumes_inspect_error_fetch());
			}
			volumeData = await response.json();
		} catch (err: any) {
			error = err.message || m.volumes_inspect_error_load();
			console.error('Failed to fetch volume inspect:', err);
		} finally {
			loading = false;
		}
	}

	function formatDate(dateString: string): string {
		if (!dateString) return m.containers_inspect_not_available();
		return formatDateTime(dateString);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-4xl max-h-[90vh] flex flex-col" onOpenAutoFocus={(e) => e.preventDefault()}>
		<Dialog.Header class="shrink-0">
			<ModalHeader icon={HardDrive} title={m.volumes_inspect_title()} name={volumeName}>
				{#snippet extra()}
					{@const composeStack = volumeData?.Labels?.['com.docker.compose.project']}
					{#if composeStack && !loading}
						<Tooltip.Root>
							<Tooltip.Trigger>
								<button
									type="button"
									onclick={() => {
										open = false;
										goto(appendEnvParam(`/stacks?search=${encodeURIComponent(composeStack)}`, $currentEnvironment?.id ?? null));
									}}
									class="cursor-pointer inline-flex items-center"
								>
									<Badge variant="outline" class="text-xs py-0 px-1.5 hover:bg-primary/10 hover:border-primary/50 transition-colors gap-1">
										<Layers class="w-3 h-3" />
										{composeStack}
									</Badge>
								</button>
							</Tooltip.Trigger>
							<Tooltip.Content>
								<p class="text-xs whitespace-nowrap">{m.containers_inspect_open_stack({ stack: composeStack })}</p>
							</Tooltip.Content>
						</Tooltip.Root>
					{/if}
				{/snippet}
			</ModalHeader>
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
			{:else if volumeData}
				<!-- Basic Info -->
				<div class="space-y-3">
					<h3 class="text-sm font-semibold">{m.containers_inspect_basic_info()}</h3>
					<div class="grid grid-cols-2 gap-3 text-sm">
						<div>
							<p class="text-muted-foreground">{m.volumes_inspect_name()}</p>
							<code class="text-xs break-all">{volumeData.Name}</code>
						</div>
						<div>
							<p class="text-muted-foreground">{m.volumes_driver()}</p>
							<Badge variant="outline">{volumeData.Driver}</Badge>
						</div>
						<div>
							<p class="text-muted-foreground">{m.volumes_inspect_scope()}</p>
							<Badge variant="secondary">{volumeData.Scope}</Badge>
						</div>
						<div>
							<p class="text-muted-foreground">{m.containers_inspect_created()}</p>
							<p class="text-xs">{formatDate(volumeData.CreatedAt)}</p>
						</div>
					</div>
				</div>

				<!-- Mountpoint -->
				<div class="space-y-2">
					<h3 class="text-sm font-semibold">{m.volumes_inspect_mountpoint()}</h3>
					<div class="p-2 bg-muted rounded">
						<code class="text-xs break-all">{volumeData.Mountpoint}</code>
					</div>
					<p class="text-xs text-muted-foreground">
						{m.volumes_inspect_mountpoint_hint()}
					</p>
				</div>

				<!-- Driver Options -->
				{#if volumeData.Options && Object.keys(volumeData.Options).length > 0}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">{m.volumes_driver_options()}</h3>
						<div class="space-y-1">
							{#each Object.entries(volumeData.Options) as [key, value]}
								<div class="flex justify-between text-sm p-2 bg-muted rounded">
									<code class="text-muted-foreground">{key}</code>
									<code class="break-all ml-2">{value}</code>
								</div>
							{/each}
						</div>
					</div>
				{:else}
					<div class="space-y-2">
						<h3 class="text-sm font-semibold">{m.volumes_driver_options()}</h3>
						<p class="text-sm text-muted-foreground">{m.volumes_no_driver_options()}</p>
					</div>
				{/if}

				<!-- Labels -->
				{#if volumeData.Labels && Object.keys(volumeData.Labels).length > 0}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">{m.volumes_labels()}</h3>
						<div class="space-y-1">
							{#each Object.entries(volumeData.Labels) as [key, value]}
								<div class="flex justify-between text-sm p-2 bg-muted rounded">
									<code class="text-muted-foreground">{key}</code>
									<code class="break-all ml-2">{value}</code>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Status -->
				{#if volumeData.Status}
					<div class="space-y-3">
						<h3 class="text-sm font-semibold">{m.containers_inspect_status()}</h3>
						<div class="space-y-1">
							{#each Object.entries(volumeData.Status) as [key, value]}
								<div class="flex justify-between text-sm p-2 bg-muted rounded">
									<span class="text-muted-foreground">{key}</span>
									<span>{value}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Usage Warning -->
				<div class="p-3 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded">
					<p class="text-xs text-yellow-800 dark:text-yellow-200">
						<strong>{m.volumes_inspect_note_label()}</strong> {m.volumes_inspect_note_text()}
					</p>
				</div>
			{/if}
		</div>

		<Dialog.Footer class="shrink-0">
			<Button variant="outline" onclick={() => (open = false)}>{m.ui_close()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
