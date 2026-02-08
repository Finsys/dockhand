<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Plus, Trash2, Pencil, Bell, Mail, Link, Send, RefreshCw, Info, CheckCircle2, XCircle } from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import NotificationModal from './NotificationModal.svelte';
	import { EmptyState } from '$lib/components/ui/empty-state';

	// Notification types
	interface NotificationSetting {
		id: number;
		type: 'smtp' | 'apprise';
		name: string;
		enabled: boolean;
		config: any;
		eventTypes: string[];
		createdAt: string;
		updatedAt: string;
	}

	// Notification state
	let notifications = $state<NotificationSetting[]>([]);
	let notifLoading = $state(true);
	let showNotifModal = $state(false);
	let editingNotif = $state<NotificationSetting | null>(null);
	let testingNotif = $state<number | null>(null);
	let testedNotifId = $state<number | null>(null);
	let testResult = $state<{ success: boolean; message?: string; error?: string } | null>(null);
	let confirmDeleteNotificationId = $state<number | null>(null);

	async function fetchNotifications() {
		notifLoading = true;
		try {
			const response = await fetch('/api/notifications');
			notifications = await response.json();
		} catch (error) {
			console.error('Failed to fetch notifications:', error);
			toast.error('Failed to fetch notification channels');
		} finally {
			notifLoading = false;
		}
	}

	function openNotifModal(notif?: NotificationSetting) {
		editingNotif = notif || null;
		showNotifModal = true;
	}

	async function deleteNotification(id: number) {
		try {
			const response = await fetch(`/api/notifications/${id}`, {
				method: 'DELETE'
			});

			if (response.ok) {
				await fetchNotifications();
				toast.success('Notification channel deleted');
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to delete notification channel');
			}
		} catch (error) {
			toast.error('Failed to delete notification channel');
		}
	}

	async function toggleNotification(notif: NotificationSetting) {
		try {
			const response = await fetch(`/api/notifications/${notif.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: !notif.enabled })
			});
			if (response.ok) {
				await fetchNotifications();
				toast.success(`Channel ${notif.enabled ? 'disabled' : 'enabled'}`);
			} else {
				toast.error('Failed to toggle notification channel');
			}
		} catch (error) {
			console.error('Failed to toggle notification:', error);
			toast.error('Failed to toggle notification channel');
		}
	}

	async function testNotification(id: number) {
		testingNotif = id;
		testedNotifId = null;
		testResult = null;

		try {
			const response = await fetch(`/api/notifications/${id}/test`, {
				method: 'POST'
			});
			testResult = await response.json();
			if (testResult?.success) {
				toast.success('Test notification sent successfully');
			} else {
				toast.error(`Test failed: ${testResult?.error || 'Unknown error'}`);
			}
		} catch (error) {
			testResult = { success: false, error: 'Failed to test notification' };
			toast.error('Failed to test notification');
		}

		// Store which notification was tested, clear testing state
		testedNotifId = id;
		testingNotif = null;

		// Clear result after 5 seconds
		setTimeout(() => {
			testedNotifId = null;
			testResult = null;
		}, 5000);
	}

	onMount(() => {
		fetchNotifications();
	});
</script>

<div class="space-y-4">
	<Card.Root class="border-dashed">
		<Card.Content class="pt-4">
			<div class="flex items-start gap-3">
				<Bell class="w-5 h-5 text-muted-foreground mt-0.5" />
				<div>
					<p class="text-sm font-medium">Notification channels</p>
					<p class="text-xs text-muted-foreground mt-1">
						Configure notification channels to receive alerts about Docker events. Supports SMTP email and Apprise URLs (Discord, Slack, Telegram, ntfy, and more).
					</p>
					<p class="text-xs text-amber-600 dark:text-amber-500 mt-2 flex items-center gap-1">
						<Info class="w-3 h-3" />
						Detailed notification settings (event types, enable/disable) are configured per environment in Environment settings.
					</p>
				</div>
			</div>
		</Card.Content>
	</Card.Root>

	<div class="flex justify-between items-center">
		<div class="flex items-center gap-3">
			<Badge variant="secondary" class="text-xs">{notifications.length} channels</Badge>
		</div>
		<div class="flex gap-2">
			{#if $canAccess('notifications', 'create')}
				<Button size="sm" onclick={() => openNotifModal()}>
					<Plus class="w-4 h-4" />
					Add channel
				</Button>
			{/if}
			<Button size="sm" variant="outline" onclick={fetchNotifications}>Refresh</Button>
		</div>
	</div>

	{#if notifLoading && notifications.length === 0}
		<p class="text-muted-foreground text-sm">Loading notification channels...</p>
	{:else if notifications.length === 0}
		<EmptyState
			icon={Bell}
			title="No notification channels configured"
			description="Add a channel to start receiving alerts about Docker events"
		/>
	{:else}
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each notifications as notif (notif.id)}
				<div out:fade={{ duration: 200 }}>
				<Card.Root class={notif.enabled ? '' : 'opacity-60'}>
					<Card.Header class="pb-2">
						<div class="flex items-start justify-between">
							<div class="flex items-center gap-2">
								{#if notif.type === 'smtp'}
									<Mail class="w-5 h-5 text-muted-foreground" />
								{:else}
									<Link class="w-5 h-5 text-muted-foreground" />
								{/if}
								<Card.Title class="text-base">{notif.name}</Card.Title>
							</div>
							{#if $canAccess('notifications', 'edit')}
								<TogglePill
									checked={notif.enabled}
									onchange={() => toggleNotification(notif)}
								/>
							{:else}
								<Badge variant={notif.enabled ? 'default' : 'secondary'} class="text-xs">
									{notif.enabled ? 'Enabled' : 'Disabled'}
								</Badge>
							{/if}
						</div>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div class="text-sm text-muted-foreground">
							{#if notif.type === 'smtp'}
								<span>SMTP: {notif.config.host}:{notif.config.port}</span>
							{:else}
								<span>Apprise: {notif.config.urls?.length || 0} URLs</span>
							{/if}
						</div>

						{#if testingNotif === notif.id}
							<div class="text-xs text-muted-foreground flex items-center gap-1">
								<RefreshCw class="w-3 h-3 animate-spin" />
								Sending test...
							</div>
						{:else if testResult && testedNotifId === notif.id}
							<div class="text-xs flex items-center gap-1 {testResult.success ? 'text-green-600' : 'text-destructive'}">
								{#if testResult.success}
									<CheckCircle2 class="w-3 h-3" />
									Test sent successfully
								{:else}
									<XCircle class="w-3 h-3" />
									{testResult.error || 'Test failed'}
								{/if}
							</div>
						{/if}

						<div class="flex gap-2 pt-2 flex-wrap">
							<Button
								variant="outline"
								size="sm"
								onclick={() => testNotification(notif.id)}
								disabled={testingNotif !== null}
							>
								<Send class="w-3 h-3" />
								Test
							</Button>
							{#if $canAccess('notifications', 'edit')}
								<Button
									variant="outline"
									size="sm"
									onclick={() => openNotifModal(notif)}
								>
									<Pencil class="w-3 h-3" />
								</Button>
							{/if}
							{#if $canAccess('notifications', 'delete')}
								<ConfirmPopover
									open={confirmDeleteNotificationId === notif.id}
									action="Delete"
									itemType="channel"
									itemName={notif.name}
									title="Remove"
									position="left"
									onConfirm={() => deleteNotification(notif.id)}
									onOpenChange={(open) => confirmDeleteNotificationId = open ? notif.id : null}
								>
									{#snippet children({ open })}
										<Button
											variant="outline"
											size="sm"
											class={open ? 'border-destructive text-destructive' : ''}
										>
											<Trash2 class="w-3 h-3" />
										</Button>
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

<NotificationModal
	bind:open={showNotifModal}
	notification={editingNotif}
	onClose={() => { showNotifModal = false; editingNotif = null; }}
	onSaved={fetchNotifications}
/>
