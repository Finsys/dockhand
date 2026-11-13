<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { m } from '$lib/paraglide/messages.js';
	import type { NotificationDeliveryView, NotificationDeliveryStatus } from '$lib/utils/notification-retries';

	let { channels }: { channels: Array<{ id: number; name: string }> } = $props();
	let selectedId = $state(0), page = $state(1), pages = $state(1), total = $state(0);
	let items = $state<NotificationDeliveryView[]>([]), error = $state(''), busy = $state(false);
	let confirming = $state(''), acting = $state('');
	let sequence = 0;
	const statuses: Record<NotificationDeliveryStatus, () => string> = {
		pending: m.settings_notifications_delivery_pending, processing: m.settings_notifications_delivery_processing,
		succeeded: m.settings_notifications_delivery_succeeded, failed: m.settings_notifications_delivery_failed,
		cancelled: m.settings_notifications_delivery_cancelled, discarded: m.settings_notifications_delivery_discarded
	};
	const formatTime = (value: number | null) => value === null ? '—' : new Date(value).toLocaleString();

	async function load(id = selectedId, currentPage = page) {
		if (!id) return;
		const request = ++sequence;
		busy = true;
		try {
			const response = await fetch(`/api/notifications/${id}/deliveries?page=${currentPage}`);
			if (!response.ok) throw new Error();
			const data = await response.json();
			if (request !== sequence) return;
			items = data.items; pages = data.pages; total = data.total; error = '';
		} catch { if (request === sequence) error = m.settings_notifications_deliveries_error(); }
		finally { if (request === sequence) busy = false; }
	}

	async function act(row: NotificationDeliveryView, action: 'retry' | 'discard') {
		acting = row.id;
		try {
			const response = await fetch(`/api/notifications/${row.notificationId}/deliveries/${row.id}`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action })
			});
			if (!response.ok) throw new Error();
			await load();
		} catch { error = m.settings_notifications_deliveries_error(); }
		finally { acting = ''; confirming = ''; }
	}

	$effect(() => {
		if (!channels.some(channel => channel.id === selectedId)) { selectedId = channels[0]?.id ?? 0; page = 1; }
	});
	$effect(() => { if (selectedId) void load(selectedId, page); });
	onMount(() => {
		const timer = setInterval(() => { if (selectedId) void load(); }, 5000);
		return () => { clearInterval(timer); sequence++; };
	});
</script>

{#if channels.length}
	<Card.Root>
		<Card.Header><Card.Title class="text-base">{m.settings_notifications_deliveries_title()}</Card.Title></Card.Header>
		<Card.Content class="space-y-3">
			<p class="text-xs text-muted-foreground">{m.settings_notifications_deliveries_hint()}</p>
			<div class="flex flex-wrap items-center gap-3">
				<label for="delivery-channel" class="text-sm">{m.settings_notifications_delivery_channel()}</label>
				<select id="delivery-channel" class="rounded-md border bg-background px-3 py-2 text-sm" bind:value={selectedId} onchange={() => page = 1}>
					{#each channels as channel (channel.id)}<option value={channel.id}>{channel.name}</option>{/each}
				</select>
				<Button variant="outline" size="sm" disabled={busy} onclick={() => load()}>{m.settings_notifications_refresh()}</Button>
			</div>
			{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-xs">
					<thead><tr class="border-b"><th class="p-2">{m.settings_notifications_delivery_status()}</th><th class="p-2">{m.settings_notifications_delivery_event()}</th><th class="p-2">{m.settings_notifications_retry_attempts()}</th><th class="p-2">{m.settings_notifications_delivery_due()}</th><th class="p-2">{m.settings_notifications_delivery_error()}</th><th class="p-2"><span class="sr-only">{m.settings_notifications_delivery_actions()}</span></th></tr></thead>
					<tbody>
						{#each items as row (row.id)}
							<tr class="border-b align-top">
								<td class="p-2"><Badge variant={row.status === 'failed' ? 'destructive' : 'secondary'}>{statuses[row.status]()}</Badge></td>
								<td class="p-2"><div>{row.eventType ?? '—'}</div><code title={row.id}>{row.id.slice(0, 8)}</code><div class="text-muted-foreground">{formatTime(row.createdAt)}</div></td>
								<td class="p-2">{row.attempts} / {row.maxAttempts}</td>
								<td class="p-2">{row.status === 'pending' ? formatTime(row.dueAt) : '—'}</td>
								<td class="p-2">{row.lastError ?? '—'}{row.httpStatus ? ` (${row.httpStatus})` : ''}</td>
								<td class="p-2">
									{#if $canAccess('notifications', 'edit')}
										<div class="flex gap-2">
											{#each (row.status === 'failed' ? ['retry', 'discard'] : ['pending', 'cancelled'].includes(row.status) ? ['discard'] : []) as action}
												<ConfirmPopover localized open={confirming === row.id + action} action={action === 'retry' ? m.settings_notifications_delivery_retry() : m.settings_notifications_delivery_discard()} itemType={m.settings_notifications_delivery_item()} itemName={row.id.slice(0, 8)} title={action === 'retry' ? m.settings_notifications_delivery_retry() : m.settings_notifications_delivery_discard()} position="left" onOpenChange={(open) => confirming = open ? row.id + action : ''} onConfirm={() => act(row, action as 'retry' | 'discard')}>
													{#snippet children()}<Button size="sm" variant="outline" disabled={acting === row.id}>{action === 'retry' ? m.settings_notifications_delivery_retry() : m.settings_notifications_delivery_discard()}</Button>{/snippet}
												</ConfirmPopover>
											{/each}
										</div>
									{/if}
								</td>
								</tr>
						{/each}
					</tbody>
				</table>
				{#if !items.length}<p class="py-4 text-sm text-muted-foreground">{m.settings_notifications_deliveries_empty()}</p>{/if}
			</div>
			<div class="flex items-center justify-between gap-3"><span class="text-xs text-muted-foreground">{page} / {pages} · {total}</span><div class="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1 || busy} onclick={() => page--}>{m.settings_notifications_deliveries_previous()}</Button><Button variant="outline" size="sm" disabled={page >= pages || busy} onclick={() => page++}>{m.settings_notifications_deliveries_next()}</Button></div></div>
		</Card.Content>
	</Card.Root>
{/if}
