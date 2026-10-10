<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { AlertTriangle, RefreshCw, Shield } from 'lucide-svelte';
	import { focusFirstInput } from '$lib/utils';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		userId: number;
		onClose: () => void;
		onSuccess: () => void;
	}

	let { open = $bindable(), userId, onClose, onSuccess }: Props = $props();

	let loading = $state(false);

	async function disableMfa() {
		loading = true;

		try {
			const response = await fetch(`/api/users/${userId}/mfa`, {
				method: 'DELETE'
			});

			if (response.ok) {
				onSuccess();
				onClose();
			}
		} catch (e) {
			// Error handling is done by the parent
		} finally {
			loading = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) focusFirstInput(); else onClose(); }}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2 text-destructive">
				<AlertTriangle class="w-5 h-5" />
				{m.profile_mfa_disable_title()}
			</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			<p class="text-sm text-muted-foreground">
				{m.profile_mfa_disable_confirm()}
			</p>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={onClose}>{m.profile_cancel()}</Button>
			<Button variant="destructive" onclick={disableMfa} disabled={loading}>
				{#if loading}
					<RefreshCw class="w-4 h-4 animate-spin" />
				{:else}
					<Shield class="w-4 h-4" />
				{/if}
				{m.profile_mfa_disable()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
