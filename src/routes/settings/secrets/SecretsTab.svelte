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
		Check,
	} from 'lucide-svelte';
	import { scale } from 'svelte/transition';
	import { backOut, cubicIn } from 'svelte/easing';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { EmptyState } from '$lib/components/ui/empty-state';
	import ProviderModal, {
		type SecretProvider,
		providerTypeLabel,
	} from './ProviderModal.svelte';
	import { getProviderIcon } from '$lib/components/provider-icons';

	let providers = $state<SecretProvider[]>([]);
	let loading = $state(true);
	let showModal = $state(false);
	let editing = $state<SecretProvider | null>(null);
	let confirmDeleteId = $state<number | null>(null);
	// Stacks bound to the provider whose delete popover is open, so we can warn the
	// user that deleting it unbinds them (#1522). Keyed by nothing - only one popover is
	// open at a time.
	let deleteAffectedStacks = $state<Array<{ stackName: string; environmentId: number | null }>>([]);
	let loadingAffected = $state(false);
	let testingId = $state<number | null>(null);
	// Brief green tick on the tile's Test button right after a successful test.
	let testOkId = $state<number | null>(null);
	let testOkTimer: ReturnType<typeof setTimeout> | undefined;

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

	async function loadAffectedStacks(id: number) {
		loadingAffected = true;
		deleteAffectedStacks = [];
		try {
			const res = await fetch(`/api/secret-providers/${id}`);
			if (res.ok) {
				const data = await res.json();
				deleteAffectedStacks = data.stacksUsing ?? [];
			}
		} catch {
			// Non-fatal: the confirmation still works, just without the stack list.
		} finally {
			loadingAffected = false;
		}
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
				clearTimeout(testOkTimer);
				testOkId = provider.id;
				testOkTimer = setTimeout(() => (testOkId = null), 2000);
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
				{@const ProviderIcon = getProviderIcon(provider.type)}
				<div out:fade={{ duration: 200 }}>
					<Card.Root>
						<Card.Header class="pb-2">
							<div class="flex items-start justify-between">
								<div class="flex items-center gap-2">
									<ProviderIcon class="w-5 h-5 text-muted-foreground" />
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
										class={`transition-colors duration-300 ${testOkId === provider.id ? 'border-green-500/60 text-green-600 dark:text-green-400' : ''}`}
									>
										<span class="inline-flex w-3 h-3 mr-1 items-center justify-center shrink-0">
											{#if testingId === provider.id}
												<RefreshCw class="w-3 h-3 animate-spin" />
											{:else if testOkId === provider.id}
												<span in:scale={{ duration: 260, start: 0.4, easing: backOut }} out:scale={{ duration: 150, start: 0.6, easing: cubicIn }}>
													<Check class="w-3 h-3 text-green-600 dark:text-green-400" />
												</span>
											{:else}
												<PlugZap class="w-3 h-3" />
											{/if}
										</span>
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
										autoHideMs={0}
										onConfirm={() =>
											deleteProvider(provider.id)}
										onOpenChange={(open) => {
											confirmDeleteId = open ? provider.id : null;
											if (open) loadAffectedStacks(provider.id);
											else deleteAffectedStacks = [];
										}}
									>
										{#snippet children({ open })}
											<Trash2
												class="w-3 h-3 {open
													? 'text-destructive'
													: 'text-muted-foreground hover:text-destructive'}"
											/>
										{/snippet}
										{#snippet extraContent()}
											{#if loadingAffected}
												<p class="text-xs text-muted-foreground">Checking which stacks use this provider...</p>
											{:else if deleteAffectedStacks.length > 0}
												<p class="text-xs text-amber-600 dark:text-amber-500">
													This unbinds {deleteAffectedStacks.length} stack{deleteAffectedStacks.length === 1 ? '' : 's'}; their next deploy drops the injected secrets:
												</p>
												<ul class="mt-1 text-xs text-muted-foreground list-disc list-inside max-h-24 overflow-y-auto">
													{#each deleteAffectedStacks as s}
														<li>{s.stackName}</li>
													{/each}
												</ul>
											{/if}
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
