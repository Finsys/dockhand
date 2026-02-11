<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Plus, Check, RefreshCw } from 'lucide-svelte';
	import { focusFirstInput } from '$lib/utils';

	export interface Registry {
		id: number;
		name: string;
		url: string;
		username?: string;
		createdAt: string;
	}

	interface Props {
		open: boolean;
		registry?: Registry | null;
		onClose: () => void;
		onSaved: () => void;
	}

	let { open = $bindable(), registry = null, onClose, onSaved }: Props = $props();

	const isEditing = $derived(registry !== null);

	// Form state
	let formName = $state('');
	let formUrl = $state('');
	let formUsername = $state('');
	let formPassword = $state('');
	let formError = $state('');
	let formSaving = $state(false);

	function resetForm() {
		formName = '';
		formUrl = '';
		formUsername = '';
		formPassword = '';
		formError = '';
		formSaving = false;
	}

	// Initialize form when registry changes or modal opens
	$effect(() => {
		if (open) {
			if (registry) {
				formName = registry.name;
				formUrl = registry.url;
				formUsername = registry.username || '';
				formPassword = '';
				formError = '';
			} else {
				resetForm();
			}
		}
	});

	async function save() {
		if (!formName.trim() || !formUrl.trim()) {
			formError = 'Name and URL are required';
			return;
		}

		formSaving = true;
		formError = '';

		try {
			const body: Record<string, string | undefined> = {
				name: formName.trim(),
				url: formUrl.trim(),
				username: formUsername.trim() || undefined
			};

			// Only include password if provided (for edit, empty means keep existing)
			if (formPassword || !isEditing) {
				body.password = formPassword || undefined;
			}

			const url = isEditing ? `/api/registries/${registry!.id}` : '/api/registries';
			const method = isEditing ? 'PUT' : 'POST';

			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			if (response.ok) {
				open = false;
				onSaved();
			} else {
				const data = await response.json();
				formError = data.error || `Failed to ${isEditing ? 'update' : 'create'} registry`;
			}
		} catch {
			formError = `Failed to ${isEditing ? 'update' : 'create'} registry`;
		} finally {
			formSaving = false;
		}
	}

	function handleClose() {
		open = false;
		onClose();
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) { formError = ''; focusFirstInput(); } }}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{isEditing ? 'Edit' : 'Add'} registry</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			{#if formError}
				<div class="text-sm text-red-600 dark:text-red-400">{formError}</div>
			{/if}
			<div class="space-y-2">
				<Label for="reg-name">Name</Label>
				<Input id="reg-name" bind:value={formName} placeholder="My Private Registry" />
			</div>
			<div class="space-y-2">
				<Label for="reg-url">URL</Label>
				<Input id="reg-url" bind:value={formUrl} placeholder="https://registry.example.com" />
			</div>
			<div class="space-y-4 pt-2 border-t">
				<p class="text-xs text-muted-foreground">Credentials {isEditing ? '(leave password blank to keep existing)' : '(optional)'}</p>
				<div class="space-y-2">
					<Label for="reg-username">Username</Label>
					<Input id="reg-username" bind:value={formUsername} placeholder="username" />
				</div>
				<div class="space-y-2">
					<Label for="reg-password">Password / Token</Label>
					<Input id="reg-password" type="password" bind:value={formPassword} placeholder={isEditing ? 'leave blank to keep existing' : 'password or access token'} />
				</div>
			</div>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={handleClose}>Cancel</Button>
			<Button onclick={save} disabled={formSaving}>
				{#if formSaving}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else if isEditing}
					<Check class="w-4 h-4" />
				{:else}
					<Plus class="w-4 h-4" />
				{/if}
				{isEditing ? 'Save' : 'Add'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
