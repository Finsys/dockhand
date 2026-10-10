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
	import { m } from '$lib/paraglide/messages.js';

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
			toast.error(m.settings_notifications_toast_fetch_failed());
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
				toast.success(m.settings_notifications_toast_deleted());
			} else {
				const data = await response.json();
				toast.error(data.error || m.settings_notifications_toast_delete_failed());
			}
		} catch (error) {
			toast.error(m.settings_notifications_toast_delete_failed());
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
				toast.success(notif.enabled ? m.settings_notifications_toast_channel_disabled() : m.settings_notifications_toast_channel_enabled());
			} else {
				toast.error(m.settings_notifications_toast_toggle_failed());
			}
		} catch (error) {
			console.error('Failed to toggle notification:', error);
			toast.error(m.settings_notifications_toast_toggle_failed());
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
				toast.success(m.settings_notifications_toast_test_sent());
			} else {
				toast.error(m.settings_notifications_toast_test_failed({ error: testResult?.error || m.settings_notifications_unknown_error() }));
			}
		} catch (error) {
			testResult = { success: false, error: m.settings_notifications_test_error() };
			toast.error(m.settings_notifications_test_error());
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
					<p class="text-sm font-medium">{m.settings_notifications_title()}</p>
					<p class="text-xs text-muted-foreground mt-1">
						{m.settings_notifications_intro()}
					</p>
					<p class="text-xs text-amber-600 dark:text-amber-500 mt-2 flex items-center gap-1">
						<Info class="w-3 h-3" />
						{m.settings_notifications_per_env_hint()}
					</p>
				</div>
			</div>
		</Card.Content>
	</Card.Root>

	<div class="flex justify-between items-center">
		<div class="flex items-center gap-3">
			<Badge variant="secondary" class="text-xs">{m.settings_notifications_channel_count({ count: notifications.length })}</Badge>
		</div>
		<div class="flex gap-2">
			{#if $canAccess('notifications', 'create')}
				<Button size="sm" onclick={() => openNotifModal()}>
					<Plus class="w-4 h-4" />
					{m.settings_notifications_add_channel()}
				</Button>
			{/if}
			<Button size="sm" variant="outline" onclick={fetchNotifications}>{m.settings_notifications_refresh()}</Button>
		</div>
	</div>

	{#if notifLoading && notifications.length === 0}
		<p class="text-muted-foreground text-sm">{m.settings_notifications_loading()}</p>
	{:else if notifications.length === 0}
		<EmptyState
			icon={Bell}
			title={m.settings_notifications_empty_title()}
			description={m.settings_notifications_empty_description()}
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
									{notif.enabled ? m.settings_notifications_enabled() : m.settings_notifications_disabled()}
								</Badge>
							{/if}
						</div>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div class="text-sm text-muted-foreground">
							{#if notif.type === 'smtp'}
								<span>SMTP: {notif.config.host}:{notif.config.port}</span>
							{:else}
								<span>{m.settings_notifications_webhook_url_count({ count: notif.config.urls?.length || 0 })}</span>
							{/if}
						</div>

						{#if testingNotif === notif.id}
							<div class="text-xs text-muted-foreground flex items-center gap-1">
								<RefreshCw class="w-3 h-3 animate-spin" />
								{m.settings_notifications_sending_test()}
							</div>
						{:else if testResult && testedNotifId === notif.id}
							<div class="text-xs flex items-center gap-1 {testResult.success ? 'text-green-600' : 'text-destructive'}">
								{#if testResult.success}
									<CheckCircle2 class="w-3 h-3" />
									{m.settings_notifications_test_sent()}
								{:else}
									<XCircle class="w-3 h-3" />
									{testResult.error || m.settings_notifications_test_failed()}
								{/if}
							</div>
						{/if}

						<div class="flex items-center gap-2 pt-2 flex-wrap">
							<Button
								variant="outline"
								size="sm"
								onclick={() => testNotification(notif.id)}
								disabled={testingNotif !== null}
							>
								<Send class="w-3 h-3" />
								{m.settings_notifications_test()}
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
									localized
									open={confirmDeleteNotificationId === notif.id}
									action={m.confirm_action_delete()}
									itemType={m.settings_notifications_item_channel()}
									itemName={notif.name}
									title={m.settings_notifications_remove()}
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
