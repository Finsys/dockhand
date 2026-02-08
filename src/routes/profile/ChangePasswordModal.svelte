<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Key, RefreshCw, Check, TriangleAlert } from 'lucide-svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { focusFirstInput } from '$lib/utils';
	import PasswordStrengthIndicator from '$lib/components/PasswordStrengthIndicator.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		onSuccess: (message: string) => void;
	}

	let { open = $bindable(), onClose, onSuccess }: Props = $props();

	let currentPassword = $state('');
	let newPassword = $state('');
	let newPasswordRepeat = $state('');
	let saving = $state(false);
	let error = $state('');

	function resetForm() {
		currentPassword = '';
		newPassword = '';
		newPasswordRepeat = '';
		error = '';
	}

	async function changePassword() {
		if (!currentPassword || !newPassword) {
			error = 'All fields are required';
			return;
		}

		if (newPassword !== newPasswordRepeat) {
			error = 'Passwords do not match';
			return;
		}

		if (newPassword.length < 8) {
			error = 'Password must be at least 8 characters';
			return;
		}

		saving = true;
		error = '';

		try {
			const response = await fetch('/api/profile', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					currentPassword: currentPassword,
					newPassword: newPassword
				})
			});

			if (response.ok) {
				onSuccess('Password changed successfully');
				onClose();
			} else {
				const data = await response.json();
				error = data.error || 'Failed to change password';
			}
		} catch (e) {
			error = 'Failed to change password';
		} finally {
			saving = false;
		}
	}

</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) { resetForm(); focusFirstInput(); } else onClose(); }}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Key class="w-5 h-5" />
				Change password
			</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			{#if error}
				<Alert.Root variant="destructive">
					<TriangleAlert class="h-4 w-4" />
					<Alert.Description>{error}</Alert.Description>
				</Alert.Root>
			{/if}
			<div class="space-y-2">
				<Label>Current password</Label>
				<Input
					type="password"
					bind:value={currentPassword}
					placeholder="Enter current password"
					autocomplete="current-password"
				/>
			</div>
			<div class="space-y-2">
				<Label>New password</Label>
				<Input
					type="password"
					bind:value={newPassword}
					placeholder="Enter new password"
					autocomplete="new-password"
				/>
				<PasswordStrengthIndicator password={newPassword} />
			</div>
			<div class="space-y-2">
				<Label>Repeat new password</Label>
				<Input
					type="password"
					bind:value={newPasswordRepeat}
					placeholder="Repeat new password"
					autocomplete="new-password"
				/>
			</div>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={onClose}>Cancel</Button>
			<Button onclick={changePassword} disabled={saving}>
				{#if saving}
					<RefreshCw class="w-4 h-4 animate-spin" />
				{:else}
					<Check class="w-4 h-4" />
				{/if}
				Change password
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
