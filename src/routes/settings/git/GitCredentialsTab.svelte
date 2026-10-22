<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Plus, Trash2, Pencil, Key, KeyRound, Lock } from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import GitCredentialModal from './GitCredentialModal.svelte';
	import { EmptyState } from '$lib/components/ui/empty-state';
	import { m } from '$lib/paraglide/messages.js';

	interface GitCredential {
		id: number;
		name: string;
		authType: 'none' | 'password' | 'ssh';
		username?: string;
		hasPassword: boolean;
		hasSshKey: boolean;
		createdAt: string;
		updatedAt: string;
	}

	let credentials = $state<GitCredential[]>([]);
	let loading = $state(true);
	let showModal = $state(false);
	let editingCredential = $state<GitCredential | null>(null);
	let confirmDeleteId = $state<number | null>(null);

	async function fetchCredentials() {
		try {
			const response = await fetch('/api/git/credentials');
			credentials = await response.json();
		} catch (error) {
			console.error('Failed to fetch git credentials:', error);
			toast.error(m.settings_git_credentials_fetch_failed());
		} finally {
			loading = false;
		}
	}

	function openModal(cred?: GitCredential) {
		editingCredential = cred || null;
		showModal = true;
	}

	function closeModal() {
		showModal = false;
		editingCredential = null;
	}

	async function handleSaved() {
		await fetchCredentials();
	}

	async function deleteCredential(id: number) {
		try {
			const response = await fetch(`/api/git/credentials/${id}`, { method: 'DELETE' });
			if (response.ok) {
				await fetchCredentials();
				toast.success(m.settings_git_credential_deleted());
			} else {
				toast.error(m.settings_git_credential_delete_failed());
			}
		} catch (error) {
			console.error('Failed to delete credential:', error);
			toast.error(m.settings_git_credential_delete_failed());
		}
	}

	function getAuthTypeBadge(authType: string) {
		switch (authType) {
			case 'password':
				return { label: m.stacks_git_auth_password(), class: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' };
			case 'ssh':
				return { label: m.stacks_git_auth_ssh_key(), class: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200' };
			default:
				return { label: m.stacks_git_auth_none(), class: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200' };
		}
	}

	onMount(() => {
		fetchCredentials();
	});
</script>

<div class="space-y-4">
	<div class="flex justify-between items-center">
		<div>
			<h3 class="text-lg font-medium">{m.settings_git_credentials_title()}</h3>
			<p class="text-sm text-muted-foreground">{m.settings_git_credentials_description()}</p>
		</div>
		{#if $canAccess('settings', 'edit')}
			<Button size="sm" onclick={() => openModal()}>
				<Plus class="w-4 h-4" />
				{m.settings_git_add_credential()}
			</Button>
		{/if}
	</div>

	{#if loading}
		<p class="text-sm text-muted-foreground">{m.settings_git_credentials_loading()}</p>
	{:else if credentials.length === 0}
		<Card.Root>
			<Card.Content>
				<EmptyState
					icon={Key}
					title={m.settings_git_credentials_empty_title()}
					description={m.settings_git_credentials_empty_description()}
				/>
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="space-y-1.5">
			{#each credentials as cred (cred.id)}
				<Card.Root>
					<Card.Content class="py-2 flex items-center justify-between">
						<div class="flex items-center gap-2">
							<div class="p-1.5 rounded-lg bg-muted">
								{#if cred.authType === 'ssh'}
									<KeyRound class="w-3.5 h-3.5" />
								{:else if cred.authType === 'password'}
									<Lock class="w-3.5 h-3.5" />
								{:else}
									<Key class="w-3.5 h-3.5" />
								{/if}
							</div>
							<div>
								<div class="font-medium text-sm">{cred.name}</div>
								<div class="text-xs text-muted-foreground">
									{#if cred.username}
										{m.settings_git_username_value({ username: cred.username })}
									{:else}
										{m.settings_git_no_username()}
									{/if}
								</div>
							</div>
							<Badge variant="secondary" class={getAuthTypeBadge(cred.authType).class}>
								{getAuthTypeBadge(cred.authType).label}
							</Badge>
						</div>
						{#if $canAccess('settings', 'edit')}
							<div class="flex items-center gap-0.5">
								<Button variant="ghost" size="sm" onclick={() => openModal(cred)} class="h-7 w-7 p-0">
									<Pencil class="w-3.5 h-3.5" />
								</Button>
								<ConfirmPopover
									open={confirmDeleteId === cred.id}
									localized
									action={m.confirm_action_delete()}
									itemType={m.settings_git_item_credential()}
									itemName={cred.name}
									title={m.settings_git_delete()}
									onConfirm={() => deleteCredential(cred.id)}
									onOpenChange={(open) => confirmDeleteId = open ? cred.id : null}
								>
									{#snippet children({ open })}
										<Button variant="ghost" size="sm" class="h-7 w-7 p-0">
											<Trash2 class="w-3.5 h-3.5 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
										</Button>
									{/snippet}
								</ConfirmPopover>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

<GitCredentialModal
	bind:open={showModal}
	credential={editingCredential}
	onClose={closeModal}
	onSaved={handleSaved}
/>
