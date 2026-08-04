<script lang='ts'>
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Plus,
		Trash2,
		Pencil,
		KeyRound,
		PlugZap,
		RefreshCw,
	} from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { EmptyState } from '$lib/components/ui/empty-state';
	import ProviderModal, {
		type SecretProvider,
		providerTypeLabel,
	} from './ProviderModal.svelte';

	let providers = $state<SecretProvider[]>([]);
	let loading = $state(true);
	let showModal = $state(false);
	let editing = $state<SecretProvider | null>(null);
	let confirmDeleteId = $state<number | null>(null);
	let testingId = $state<number | null>(null);

	async function fetchProviders() {
		loading = true;
		try {
			const response = await fetch('/api/secret-providers');
			providers = await response.json();
		} catch (e) {
			console.error('Failed to fetch secret providers:', e);
			toast.error('Failed to fetch secret providers');
		} finally {
			loading = false;
		}
	}

	function openModal(provider?: SecretProvider) {
		editing = provider || null;
		showModal = true;
	}

	async function deleteProvider(id: number) {
		try {
			const response = await fetch(`/api/secret-providers/${id}`, {
				method: 'DELETE',
			});
			if (response.ok) {
				await fetchProviders();
				toast.success('Secret provider deleted');
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to delete secret provider');
			}
		} catch {
			toast.error('Failed to delete secret provider');
		}
	}

	async function testProvider(provider: SecretProvider) {
		testingId = provider.id;
		try {
			const response = await fetch(
				`/api/secret-providers/${provider.id}/test`,
				{ method: 'POST' },
			);
			const data = await response.json();
			if (data.ok) {
				toast.success(`${provider.name}: connection works`);
			} else {
				toast.error(
					`${provider.name}: ${data.error || 'connection failed'}`,
				);
			}
		} catch {
			toast.error('Connection test failed');
		} finally {
			testingId = null;
		}
	}

	onMount(() => {
		fetchProviders();
	});
</script>

<div class="space-y-4">
	<div class="flex justify-between items-center">
		<div class="flex items-center gap-3">
			<Badge variant="secondary" class="text-xs"
				>{providers.length} total</Badge
			>
		</div>
		<div class="flex gap-2">
			{#if $canAccess("secrets", "create")}
				<Button size="sm" onclick={() => openModal()}>
					<Plus class="w-4 h-4" />
					Add secret provider
				</Button>
			{/if}
			<Button size="sm" variant="outline" onclick={fetchProviders}
				>Refresh</Button
			>
		</div>
	</div>

	{#if loading && providers.length === 0}
		<p class="text-muted-foreground text-sm">Loading secret providers...</p>
	{:else if providers.length === 0}
		<EmptyState
			icon={KeyRound}
			title="No secret providers"
			description="Add a provider (1Password, Infisical, HashiCorp Vault, ...) to load secrets at deploy time"
		/>
	{:else}
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each providers as provider (provider.id)}
				<div out:fade={{ duration: 200 }}>
					<Card.Root>
						<Card.Header class="pb-2">
							<div class="flex items-start justify-between">
								<div class="flex items-center gap-2">
									<KeyRound
										class="w-5 h-5 text-muted-foreground"
									/>
									<Card.Title class="text-base"
										>{provider.name}</Card.Title
									>
								</div>
								<Badge variant="secondary" class="text-xs"
									>{providerTypeLabel(provider.type)}</Badge
								>
							</div>
						</Card.Header>
						<Card.Content class="space-y-3">
							<div class="text-xs text-muted-foreground">
								Added {new Date(
									provider.createdAt,
								).toLocaleDateString()}
							</div>
							<div class="flex gap-2 pt-2 min-h-[32px]">
								{#if $canAccess("secrets", "view")}
									<Button
										variant="outline"
										size="sm"
										onclick={() => testProvider(provider)}
										disabled={testingId === provider.id}
									>
										{#if testingId === provider.id}
											<RefreshCw
												class="w-3 h-3 animate-spin"
											/>
										{:else}
											<PlugZap class="w-3 h-3" />
										{/if}
										Test
									</Button>
								{/if}
								{#if $canAccess("secrets", "edit")}
									<Button
										variant="outline"
										size="sm"
										onclick={() => openModal(provider)}
									>
										<Pencil class="w-3 h-3" />
									</Button>
								{/if}
								{#if $canAccess("secrets", "delete")}
									<ConfirmPopover
										open={confirmDeleteId === provider.id}
										action="Delete"
										itemType="secret provider"
										itemName={provider.name}
										title="Remove"
										position="left"
										onConfirm={() =>
											deleteProvider(provider.id)}
										onOpenChange={(open) =>
											(confirmDeleteId = open
												? provider.id
												: null)}
									>
										{#snippet children({ open })}
											<Trash2
												class="w-3 h-3 {open
													? 'text-destructive'
													: 'text-muted-foreground hover:text-destructive'}"
											/>
										{/snippet}
									</ConfirmPopover>
								{/if}
							</div>
						</Card.Content>
					</Card.Root>
				</div>
			{/each}
		</div>
	{/if}
</div>

<ProviderModal
	bind:open={showModal}
	provider={editing}
	onClose={() => {
		showModal = false;
		editing = null;
	}}
	onSaved={fetchProviders}
/>
