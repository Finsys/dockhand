<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Plus, Trash2, Pencil, Star, Key, Download, Icon, Wifi, RefreshCw, CircleCheck, CircleX } from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import RegistryModal from './RegistryModal.svelte';
	import { EmptyState } from '$lib/components/ui/empty-state';
	import { m } from '$lib/paraglide/messages.js';

	// Registry types
	interface Registry {
		id: number;
		name: string;
		url: string;
		username?: string;
		hasCredentials: boolean;
		isDefault: boolean;
		createdAt: string;
		updatedAt: string;
	}

	// Check if a registry is Docker Hub
	function isDockerHub(registry: Registry): boolean {
		const url = registry.url.toLowerCase();
		return url.includes('docker.io') ||
			   url.includes('hub.docker.com') ||
			   url.includes('registry.hub.docker.com');
	}

	// Registry state
	let registries = $state<Registry[]>([]);
	let regLoading = $state(true);
	let showRegModal = $state(false);
	let editingReg = $state<Registry | null>(null);
	let confirmDeleteRegistryId = $state<number | null>(null);
	let testingRegistryId = $state<number | null>(null);
	let testResults = $state<Record<number, { success: boolean; message: string }>>({});

	async function fetchRegistries() {
		regLoading = true;
		try {
			const response = await fetch('/api/registries');
			registries = await response.json();
		} catch (error) {
			console.error('Failed to fetch registries:', error);
			toast.error(m.settings_registries_fetch_failed());
		} finally {
			regLoading = false;
		}
	}

	function openRegModal(registry?: Registry) {
		editingReg = registry || null;
		showRegModal = true;
	}

	async function deleteRegistry(id: number) {
		try {
			const response = await fetch(`/api/registries/${id}`, {
				method: 'DELETE'
			});

			if (response.ok) {
				await fetchRegistries();
				toast.success(m.settings_registries_deleted());
			} else {
				const data = await response.json();
				toast.error(data.error || m.settings_registries_delete_failed());
			}
		} catch (error) {
			toast.error(m.settings_registries_delete_failed());
		}
	}

	async function testRegistry(id: number) {
		testingRegistryId = id;
		delete testResults[id];
		try {
			const response = await fetch('/api/registries/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ registryId: id })
			});
			const result = await response.json();
			testResults[id] = result;
			if (result.success) {
				toast.success(result.message);
			} else {
				toast.error(result.message);
			}
		} catch {
			testResults[id] = { success: false, message: 'Connection failed' };
			toast.error(m.settings_registries_connection_test_failed());
		} finally {
			testingRegistryId = null;
		}
	}

	async function setRegDefault(id: number) {
		try {
			const response = await fetch(`/api/registries/${id}/default`, {
				method: 'POST'
			});

			if (response.ok) {
				await fetchRegistries();
				toast.success(m.settings_registries_default_updated());
			} else {
				toast.error(m.settings_registries_set_default_failed());
			}
		} catch (error) {
			console.error('Failed to set default registry:', error);
			toast.error(m.settings_registries_set_default_failed());
		}
	}

	onMount(() => {
		fetchRegistries();
	});
</script>

<div class="space-y-4">
	<div class="flex justify-between items-center">
		<div class="flex items-center gap-3">
			<Badge variant="secondary" class="text-xs">{m.settings_registries_total({ count: registries.length })}</Badge>
		</div>
		<div class="flex gap-2">
			{#if $canAccess('registries', 'create')}
				<Button size="sm" onclick={() => openRegModal()}>
					<Plus class="w-4 h-4" />
					{m.settings_registries_add_registry()}
				</Button>
			{/if}
			<Button size="sm" variant="outline" onclick={fetchRegistries}>{m.settings_registries_refresh()}</Button>
		</div>
	</div>

	{#if regLoading && registries.length === 0}
		<p class="text-muted-foreground text-sm">{m.settings_registries_loading()}</p>
	{:else if registries.length === 0}
		<EmptyState
			icon={Download}
			title={m.settings_registries_empty_title()}
			description={m.settings_registries_empty_description()}
		/>
	{:else}
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each registries as registry (registry.id)}
				<div out:fade={{ duration: 200 }}>
				<Card.Root class={registry.isDefault ? 'border-primary' : ''}>
					<Card.Header class="pb-2">
						<div class="flex items-start justify-between">
							<div class="flex items-center gap-2">
								{#if isDockerHub(registry)}
									<Icon iconNode={whale} class="w-5 h-5 text-muted-foreground" />
								{:else}
									<Download class="w-5 h-5 text-muted-foreground" />
								{/if}
								<Card.Title class="text-base">{registry.name}</Card.Title>
							</div>
							<div class="flex items-center gap-1">
								{#if registry.isDefault}
									<Badge variant="default" class="text-xs">{m.settings_registries_default()}</Badge>
								{/if}
								{#if registry.hasCredentials}
									<Badge variant="secondary" class="text-xs">{m.settings_registries_auth()}</Badge>
								{/if}
							</div>
						</div>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div class="text-sm text-muted-foreground truncate" title={registry.url}>
							{registry.url}
						</div>

						<!-- Always reserve space for username row -->
						<div class="flex items-center gap-2 text-xs text-muted-foreground h-4">
							{#if registry.username}
								<Key class="w-3 h-3" />
								<span>{registry.username}</span>
							{/if}
						</div>

						<div class="flex gap-2 pt-2 min-h-[32px]">
							{#if !registry.isDefault && $canAccess('registries', 'edit')}
								<Button
									variant="outline"
									size="sm"
									onclick={() => setRegDefault(registry.id)}
								>
									<Star class="w-3 h-3" />
									{m.settings_registries_set_default()}
								</Button>
							{/if}
							<Button
								variant="outline"
								size="sm"
								onclick={() => testRegistry(registry.id)}
								disabled={testingRegistryId === registry.id}
								title={m.settings_registries_test_connectivity()}
							>
								{#if testingRegistryId === registry.id}
									<RefreshCw class="w-3 h-3 animate-spin" />
								{:else if testResults[registry.id]?.success}
									<CircleCheck class="w-3 h-3 text-green-500" />
								{:else if testResults[registry.id] && !testResults[registry.id].success}
									<CircleX class="w-3 h-3 text-red-500" />
								{:else}
									<Wifi class="w-3 h-3" />
								{/if}
							</Button>
							{#if $canAccess('registries', 'edit')}
								<Button
									variant="outline"
									size="sm"
									onclick={() => openRegModal(registry)}
								>
									<Pencil class="w-3 h-3" />
								</Button>
							{/if}
							{#if $canAccess('registries', 'delete')}
								<ConfirmPopover
									open={confirmDeleteRegistryId === registry.id}
									localized
									action={m.confirm_action_delete()}
									itemType={m.settings_registries_item_registry()}
									itemName={registry.name}
									title={m.settings_registries_remove()}
									position="left"
									onConfirm={() => deleteRegistry(registry.id)}
									onOpenChange={(open) => confirmDeleteRegistryId = open ? registry.id : null}
								>
									{#snippet children({ open })}
										<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
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

<RegistryModal
	bind:open={showRegModal}
	registry={editingReg}
	onClose={() => { showRegModal = false; editingReg = null; }}
	onSaved={fetchRegistries}
/>
