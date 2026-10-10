<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { KeyRound, Loader2, AlertTriangle } from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { splitAtName } from '$lib/i18n/split';

	interface Props {
		open: boolean;
		destinationId: number;
		destinationName: string;
	}

	let { open = $bindable(), destinationId, destinationName }: Props = $props();

	const descriptionParts = splitAtName(m.settings_backups_rotate_description);
	const dbOutOfSyncHint = splitAtName(m.settings_backups_rotate_db_out_of_sync_hint);

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');
	let submitting = $state(false);
	let dbOutOfSync = $state(false);
	let errorMsg = $state<string | null>(null);

	// Reset when the dialog opens for a new destination
	$effect(() => {
		if (open) {
			currentPassword = '';
			newPassword = '';
			confirmPassword = '';
			dbOutOfSync = false;
			errorMsg = null;
		}
	});

	const passwordsMatch = $derived(newPassword.length > 0 && newPassword === confirmPassword);
	const canSubmit = $derived(
		!submitting &&
		currentPassword.length > 0 &&
		newPassword.length > 0 &&
		passwordsMatch &&
		newPassword !== currentPassword
	);

	async function submit() {
		errorMsg = null;
		dbOutOfSync = false;
		submitting = true;
		try {
			const res = await fetch(`/api/backup/destinations/${destinationId}/rotate-key`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ currentPassword, newPassword })
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok && data.success) {
				toast.success(m.settings_backups_rotate_success({ name: destinationName }));
				open = false;
				return;
			}
			if (data.dbOutOfSync) {
				dbOutOfSync = true;
				errorMsg = data.error || m.settings_backups_rotate_db_out_of_sync();
				return;
			}
			errorMsg = data.error || m.settings_backups_rotate_failed_http({ status: res.status });
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<KeyRound class="w-4 h-4" />
				{m.settings_backups_rotate_title()}
			</Dialog.Title>
			<Dialog.Description>
				{descriptionParts[0]}<strong>{destinationName}</strong>{descriptionParts[1]}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-3 py-2">
			<div class="space-y-1">
				<Label for="rotate-current">{m.settings_backups_rotate_current_password()}</Label>
				<Input id="rotate-current" type="password" bind:value={currentPassword} autocomplete="current-password" />
			</div>
			<div class="space-y-1">
				<Label for="rotate-new">{m.settings_backups_rotate_new_password()}</Label>
				<Input id="rotate-new" type="password" bind:value={newPassword} autocomplete="new-password" />
			</div>
			<div class="space-y-1">
				<Label for="rotate-confirm">{m.settings_backups_rotate_confirm_password()}</Label>
				<Input id="rotate-confirm" type="password" bind:value={confirmPassword} autocomplete="new-password" />
				{#if confirmPassword.length > 0 && !passwordsMatch}
					<p class="text-xs text-destructive">{m.settings_backups_rotate_mismatch()}</p>
				{/if}
				{#if newPassword.length > 0 && newPassword === currentPassword}
					<p class="text-xs text-destructive">{m.settings_backups_rotate_must_differ()}</p>
				{/if}
			</div>

			{#if errorMsg}
				<div class="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">
					<div class="flex items-start gap-2">
						<AlertTriangle class="w-4 h-4 mt-0.5 text-destructive shrink-0" />
						<div>
							<p class="font-medium text-destructive">
								{#if dbOutOfSync}
									{m.settings_backups_rotate_db_failed_title()}
								{:else}
									{m.settings_backups_rotate_failed()}
								{/if}
							</p>
							<p class="text-muted-foreground mt-1 break-words">{errorMsg}</p>
							{#if dbOutOfSync}
								<p class="text-muted-foreground mt-2">
									{dbOutOfSyncHint[0]}<strong>{m.settings_backups_rotate_edit_destination()}</strong>{dbOutOfSyncHint[1]}
								</p>
							{/if}
						</div>
					</div>
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={submitting}>{m.settings_backups_cancel()}</Button>
			<Button onclick={submit} disabled={!canSubmit}>
				{#if submitting}
					<Loader2 class="w-3 h-3 mr-2 animate-spin" />
					{m.settings_backups_rotate_rotating()}
				{:else}
					{m.settings_backups_rotate_button()}
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
