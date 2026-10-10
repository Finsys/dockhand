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
		Star,
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
	import { m } from '$lib/paraglide/messages.js';

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
	// Preselected on new stacks. Null = none, so every stack picks its own (#1609).
	let defaultProviderId = $state<number | null>(null);
	let savingDefaultId = $state<number | null>(null);

	async function fetchProviders() {
		loading = true;
		try {
			const response = await fetch('/api/secret-providers');
			providers = await response.json();
		} catch (e) {
			console.error('Failed to fetch secret providers:', e);
			toast.error(m.settings_secrets_toast_fetch_failed());
		} finally {
			loading = false;
		}
	}

	async function fetchDefaultProvider() {
		try {
			const response = await fetch('/api/secret-providers/default');
			if (!response.ok) return;
			const data = await response.json();
			defaultProviderId = data.providerId ?? null;
		} catch (e) {
			console.warn('Failed to load the default secret provider:', e);
		}
	}

	// Star the provider, or un-star it to go back to no default.
	async function toggleDefault(provider: SecretProvider) {
		const next = defaultProviderId === provider.id ? null : provider.id;
		savingDefaultId = provider.id;
		try {
			const response = await fetch('/api/secret-providers/default', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ providerId: next }),
			});
			const data = await response.json();
			if (!response.ok) {
				toast.error(data.error || m.settings_secrets_toast_default_save_failed());
				return;
			}
			defaultProviderId = data.providerId ?? null;
			toast.success(
				next === null
					? m.settings_secrets_toast_no_default()
					: m.settings_secrets_toast_default_set({ name: provider.name }),
			);
		} catch {
			toast.error(m.settings_secrets_toast_default_save_failed());
		} finally {
			savingDefaultId = null;
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
				// Deleting the default leaves the stored id dangling; the API resolves
				// it against the live list, so re-read rather than assuming.
				if (defaultProviderId === id) await fetchDefaultProvider();
				toast.success(m.settings_secrets_toast_deleted());
			} else {
				const data = await response.json();
				toast.error(data.error || m.settings_secrets_toast_delete_failed());
			}
		} catch {
			toast.error(m.settings_secrets_toast_delete_failed());
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
				toast.success(m.settings_secrets_toast_test_ok({ name: provider.name }));
				clearTimeout(testOkTimer);
				testOkId = provider.id;
				testOkTimer = setTimeout(() => (testOkId = null), 2000);
			} else {
				toast.error(
					m.settings_secrets_toast_test_failed({ name: provider.name, error: data.error || m.settings_secrets_toast_test_failed_fallback() }),
				);
			}
		} catch {
			toast.error(m.settings_secrets_toast_connection_test_failed());
		} finally {
			testingId = null;
		}
	}

	onMount(() => {
		fetchProviders();
		fetchDefaultProvider();
	});
</script>

<div class="space-y-4">
	<div class="flex justify-between items-center">
		<div class="flex items-center gap-3">
			<Badge variant="secondary" class="text-xs"
				>{m.settings_secrets_total({ count: providers.length })}</Badge
			>
		</div>
		<div class="flex gap-2">
			{#if $canAccess("secrets", "create")}
				<Button size="sm" onclick={() => openModal()}>
					<Plus class="w-4 h-4" />
					{m.settings_secrets_add_provider()}
				</Button>
			{/if}
			<Button size="sm" variant="outline" onclick={fetchProviders}
				>{m.settings_secrets_refresh()}</Button
			>
		</div>
	</div>

	{#if loading && providers.length === 0}
		<p class="text-muted-foreground text-sm">{m.settings_secrets_loading()}</p>
	{:else if providers.length === 0}
		<EmptyState
			icon={KeyRound}
			title={m.settings_secrets_empty_title()}
			description={m.settings_secrets_empty_description()}
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
									{#if defaultProviderId === provider.id}
										<Badge
											variant="outline"
											class="text-xs gap-1 border-amber-500/50 text-amber-600 dark:text-amber-400"
										>
											<Star class="w-3 h-3 fill-current" />
											{m.settings_secrets_default()}
										</Badge>
									{/if}
								</div>
								<Badge variant="secondary" class="text-xs"
									>{providerTypeLabel(provider.type)}</Badge
								>
							</div>
						</Card.Header>
						<Card.Content class="space-y-3">
							<div class="text-xs text-muted-foreground">
								{m.settings_secrets_added_on({ date: new Date(
									provider.createdAt,
								).toLocaleDateString() })}
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
										{m.settings_secrets_test()}
									</Button>
								{/if}
								{#if $canAccess("secrets", "edit")}
									<Button
										variant="outline"
										size="sm"
										onclick={() => toggleDefault(provider)}
										disabled={savingDefaultId === provider.id}
										title={defaultProviderId === provider.id
											? m.settings_secrets_default_unset_title()
											: m.settings_secrets_default_set_title()}
										class={defaultProviderId === provider.id
											? 'border-amber-500/50 text-amber-600 dark:text-amber-400'
											: ''}
									>
										<Star
											class="w-3 h-3 mr-1 {defaultProviderId === provider.id ? 'fill-current' : ''}"
										/>
										{defaultProviderId === provider.id ? m.settings_secrets_default() : m.settings_secrets_make_default()}
									</Button>
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
										localized
										action={m.confirm_action_delete()}
										itemType={m.settings_secrets_item_provider()}
										itemName={provider.name}
										title={m.settings_secrets_delete_title()}
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
												<p class="text-xs text-muted-foreground">{m.settings_secrets_checking_stacks()}</p>
											{:else if deleteAffectedStacks.length > 0}
												<p class="text-xs text-amber-600 dark:text-amber-500">
													{m.settings_secrets_unbinds_stacks({ count: deleteAffectedStacks.length })}
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
