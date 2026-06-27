<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import * as Alert from '$lib/components/ui/alert';
	import { KeyRound, Copy, Check, TriangleAlert } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';

	let {
		open = $bindable(false),
		onCreated,
		provider = 'local'
	}: {
		open: boolean;
		onCreated: () => void;
		provider?: string;
	} = $props();

	let name = $state('');
	let password = $state('');
	let expirationOption = $state('none');
	let customDate = $state('');
	let creating = $state(false);
	let error = $state('');

	const isLocalUser = $derived(provider === 'local');

	// After creation
	let createdToken = $state('');
	let copied = $state(false);

	function reset() {
		name = '';
		password = '';
		expirationOption = 'none';
		customDate = '';
		creating = false;
		error = '';
		createdToken = '';
		copied = false;
	}

	function getExpiresAt(): string | null {
		const now = new Date();
		switch (expirationOption) {
			case '30d':
				return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
			case '90d':
				return new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
			case '1y':
				return new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
			case 'custom':
				return customDate ? new Date(customDate + 'T23:59:59').toISOString() : null;
			default:
				return null;
		}
	}

	async function createToken() {
		if (!name.trim()) {
			error = 'Token name is required';
			return;
		}
		if (isLocalUser && !password) {
			error = 'Password is required';
			return;
		}

		creating = true;
		error = '';

		try {
			const payload: Record<string, any> = {
				name: name.trim(),
				expiresAt: getExpiresAt()
			};
			if (isLocalUser) {
				payload.password = password;
			}

			const response = await fetch('/api/auth/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});

			if (response.ok) {
				const data = await response.json();
				createdToken = data.token;
			} else {
				const data = await response.json();
				error = data.error || 'Failed to create token';
			}
		} catch {
			error = 'Failed to create token';
		} finally {
			creating = false;
		}
	}

	async function copyToken() {
		const ok = await copyToClipboard(createdToken);
		if (!ok) return;
		copied = true;
		setTimeout(() => copied = false, 2000);
	}

	function handleClose() {
		if (createdToken) {
			onCreated();
		}
		open = false;
		// Reset after animation
		setTimeout(reset, 200);
	}

	// Get minimum date for custom picker (tomorrow)
	const minDate = $derived(() => {
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		return tomorrow.toISOString().split('T')[0];
	});
</script>

<Dialog.Root bind:open onOpenChange={(v) => { if (!v) handleClose(); }}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<KeyRound class="w-5 h-5" />
				{createdToken ? 'Token created' : 'Generate API token'}
			</Dialog.Title>
		</Dialog.Header>

		{#if createdToken}
			<!-- Token created - show it once -->
			<div class="space-y-4">
				<Alert.Root variant="destructive">
					<TriangleAlert class="h-4 w-4" />
					<Alert.Description>
						Copy this token now. It will not be shown again.
					</Alert.Description>
				</Alert.Root>

				<div class="flex gap-2">
					<Input
						value={createdToken}
						readonly
						class="font-mono text-xs"
					/>
					<Button variant="outline" size="icon" onclick={copyToken}>
						{#if copied}
							<Check class="w-4 h-4 text-green-500" />
						{:else}
							<Copy class="w-4 h-4" />
						{/if}
					</Button>
				</div>

				<div class="flex justify-end">
					<Button onclick={handleClose}>Done</Button>
				</div>
			</div>
		{:else}
			<!-- Token creation form -->
			<div class="space-y-4">
				<div class="space-y-2">
					<Label for="token-name">Name</Label>
					<Input
						id="token-name"
						bind:value={name}
						placeholder="e.g., CI/CD pipeline"
						maxlength={255}
					/>
				</div>

				{#if isLocalUser}
					<div class="space-y-2">
						<Label for="token-password">Password</Label>
						<Input
							id="token-password"
							type="password"
							bind:value={password}
							placeholder="Confirm your password"
						/>
					</div>
				{/if}

				<div class="space-y-2">
					<Label>Expiration</Label>
					<Select.Root type="single" bind:value={expirationOption}>
						<Select.Trigger class="w-full">
							{#if expirationOption === 'none'}No expiration
							{:else if expirationOption === '30d'}30 days
							{:else if expirationOption === '90d'}90 days
							{:else if expirationOption === '1y'}1 year
							{:else if expirationOption === 'custom'}Custom date
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="none">No expiration</Select.Item>
							<Select.Item value="30d">30 days</Select.Item>
							<Select.Item value="90d">90 days</Select.Item>
							<Select.Item value="1y">1 year</Select.Item>
							<Select.Item value="custom">Custom date</Select.Item>
						</Select.Content>
					</Select.Root>

					{#if expirationOption === 'custom'}
						<Input
							type="date"
							bind:value={customDate}
							min={minDate()}
						/>
					{/if}
				</div>

				{#if error}
					<Alert.Root variant="destructive">
						<TriangleAlert class="h-4 w-4" />
						<Alert.Description>{error}</Alert.Description>
					</Alert.Root>
				{/if}

				<div class="flex justify-end gap-2">
					<Button variant="outline" onclick={handleClose}>Cancel</Button>
					<Button onclick={createToken} disabled={creating || !name.trim() || (isLocalUser && !password)}>
						{creating ? 'Creating...' : 'Generate token'}
					</Button>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
