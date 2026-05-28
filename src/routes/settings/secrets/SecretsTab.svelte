<script lang="ts">
	import { onMount } from "svelte";
	import { fade } from "svelte/transition";
	import { toast } from "svelte-sonner";
	import { Button } from "$lib/components/ui/button";
	import * as Card from "$lib/components/ui/card";
	import { Badge } from "$lib/components/ui/badge";
	import {
		Plus,
		Trash2,
		Pencil,
		KeyRound,
		PlugZap,
		RefreshCw,
	} from "lucide-svelte";
	import ConfirmPopover from "$lib/components/ConfirmPopover.svelte";
	import { canAccess } from "$lib/stores/auth";
	import { EmptyState } from "$lib/components/ui/empty-state";
	import ServiceAccountModal, {
		type OpServiceAccount,
	} from "./ServiceAccountModal.svelte";

	let accounts = $state<OpServiceAccount[]>([]);
	let loading = $state(true);
	let showModal = $state(false);
	let editing = $state<OpServiceAccount | null>(null);
	let confirmDeleteId = $state<number | null>(null);
	let testingId = $state<number | null>(null);

	async function fetchAccounts() {
		loading = true;
		try {
			const response = await fetch("/api/onepassword");
			accounts = await response.json();
		} catch (e) {
			console.error("Failed to fetch 1Password service accounts:", e);
			toast.error("Failed to fetch service accounts");
		} finally {
			loading = false;
		}
	}

	function openModal(account?: OpServiceAccount) {
		editing = account || null;
		showModal = true;
	}

	async function deleteAccount(id: number) {
		try {
			const response = await fetch(`/api/onepassword/${id}`, {
				method: "DELETE",
			});
			if (response.ok) {
				await fetchAccounts();
				toast.success("Service account deleted");
			} else {
				const data = await response.json();
				toast.error(data.error || "Failed to delete service account");
			}
		} catch {
			toast.error("Failed to delete service account");
		}
	}

	async function testAccount(account: OpServiceAccount) {
		testingId = account.id;
		try {
			const response = await fetch(
				`/api/onepassword/${account.id}/test`,
				{ method: "POST" },
			);
			const data = await response.json();
			if (data.ok) {
				toast.success(`${account.name}: connection works`);
			} else {
				toast.error(
					`${account.name}: ${data.error || "connection failed"}`,
				);
			}
		} catch {
			toast.error("Connection test failed");
		} finally {
			testingId = null;
		}
	}

	onMount(() => {
		fetchAccounts();
	});
</script>

<div class="space-y-4">
	<div class="flex justify-between items-center">
		<div class="flex items-center gap-3">
			<Badge variant="secondary" class="text-xs"
				>{accounts.length} total</Badge
			>
		</div>
		<div class="flex gap-2">
			{#if $canAccess("secrets", "create")}
				<Button size="sm" onclick={() => openModal()}>
					<Plus class="w-4 h-4" />
					Add 1Password service account
				</Button>
			{/if}
			<Button size="sm" variant="outline" onclick={fetchAccounts}
				>Refresh</Button
			>
		</div>
	</div>

	{#if loading && accounts.length === 0}
		<p class="text-muted-foreground text-sm">Loading service accounts...</p>
	{:else if accounts.length === 0}
		<EmptyState
			icon={KeyRound}
			title="No 1Password service accounts"
			description="Add a service account to load secrets from 1Password at deploy time"
		/>
	{:else}
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each accounts as account (account.id)}
				<div out:fade={{ duration: 200 }}>
					<Card.Root>
						<Card.Header class="pb-2">
							<div class="flex items-start justify-between">
								<div class="flex items-center gap-2">
									<KeyRound
										class="w-5 h-5 text-muted-foreground"
									/>
									<Card.Title class="text-base"
										>{account.name}</Card.Title
									>
								</div>
								<Badge variant="secondary" class="text-xs"
									>Encrypted</Badge
								>
							</div>
						</Card.Header>
						<Card.Content class="space-y-3">
							<div class="text-xs text-muted-foreground">
								Added {new Date(
									account.createdAt,
								).toLocaleDateString()}
							</div>
							<div class="flex gap-2 pt-2 min-h-[32px]">
								{#if $canAccess("secrets", "view")}
									<Button
										variant="outline"
										size="sm"
										onclick={() => testAccount(account)}
										disabled={testingId === account.id}
									>
										{#if testingId === account.id}
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
										onclick={() => openModal(account)}
									>
										<Pencil class="w-3 h-3" />
									</Button>
								{/if}
								{#if $canAccess("secrets", "delete")}
									<ConfirmPopover
										open={confirmDeleteId === account.id}
										action="Delete"
										itemType="service account"
										itemName={account.name}
										title="Remove"
										position="left"
										onConfirm={() =>
											deleteAccount(account.id)}
										onOpenChange={(open) =>
											(confirmDeleteId = open
												? account.id
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

<ServiceAccountModal
	bind:open={showModal}
	account={editing}
	onClose={() => {
		showModal = false;
		editing = null;
	}}
	onSaved={fetchAccounts}
/>
