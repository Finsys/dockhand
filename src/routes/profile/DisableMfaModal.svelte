<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { AlertTriangle, RefreshCw, Shield } from 'lucide-svelte';
	import { focusFirstInput } from '$lib/utils';

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
				Disable two-factor authentication
			</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			<p class="text-sm text-muted-foreground">
				Are you sure you want to disable two-factor authentication? This will make your account less secure.
			</p>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={onClose}>Cancel</Button>
			<Button variant="destructive" onclick={disableMfa} disabled={loading}>
				{#if loading}
					<RefreshCw class="w-4 h-4 animate-spin" />
				{:else}
					<Shield class="w-4 h-4" />
				{/if}
				Disable MFA
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
