<script lang='ts' module>
	export interface SecretProvider {
		id: number;
		type: string;
		name: string;
		createdAt: string;
		updatedAt?: string;
	}

	interface ProviderField {
		key: string;
		label: string;
		type: 'text' | 'password';
		required: boolean;
		placeholder?: string;
		hint?: string;
	}

	// Selectable provider types + their labels. Mirrors the registered providers
	// in src/lib/server/secretproviders (index.ts / shared.ts).
	export const PROVIDER_TYPES: { value: string; label: string }[] = [
		{ value: 'op-service-account', label: '1Password service account' },
		{ value: 'op-connect', label: '1Password Connect' },
		{ value: 'infisical', label: 'Infisical' },
		{ value: 'vault', label: 'HashiCorp Vault' },
	];

	// Config fields per provider type, matching the config shapes in
	// secretproviders/shared.ts. Non-required fields are optional overrides.
	export const PROVIDER_FIELDS: Record<string, ProviderField[]> = {
		'op-service-account': [
			{ key: 'token', label: 'Service account token', type: 'password', required: true, placeholder: 'ops_eyJ...' },
		],
		'op-connect': [
			{ key: 'host', label: 'Connect host URL', type: 'text', required: true, placeholder: 'https://connect.example.com' },
			{ key: 'token', label: 'Connect token', type: 'password', required: true, placeholder: 'eyJ...' },
		],
		infisical: [
			{ key: 'host', label: 'API host', type: 'text', required: true, placeholder: 'https://app.infisical.com' },
			{ key: 'token', label: 'Access token', type: 'password', required: true, placeholder: 'st...' },
			{ key: 'projectId', label: 'Project ID', type: 'text', required: true, placeholder: 'workspace / project id' },
			{ key: 'environment', label: 'Environment', type: 'text', required: true, placeholder: 'prod' },
			{ key: 'path', label: 'Secret path', type: 'text', required: false, placeholder: '/' },
		],
		vault: [
			{ key: 'address', label: 'Vault address', type: 'text', required: true, placeholder: 'https://vault.example.com' },
			{ key: 'token', label: 'Vault token', type: 'password', required: true, placeholder: 'hvs...' },
			{ key: 'namespace', label: 'Namespace', type: 'text', required: false, placeholder: 'admin (Enterprise / HCP)' },
			{ key: 'mount', label: 'KV mount', type: 'text', required: false, placeholder: 'secret' },
		],
	};

	export function providerTypeLabel(type: string): string {
		return PROVIDER_TYPES.find((t) => t.value === type)?.label ?? type;
	}
</script>

<script lang='ts'>
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Plus, Check, RefreshCw, PlugZap } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { focusFirstInput } from '$lib/utils';

	interface Props {
		open: boolean;
		provider?: SecretProvider | null;
		onClose: () => void;
		onSaved: () => void;
	}

	let {
		open = $bindable(),
		provider = null,
		onClose,
		onSaved,
	}: Props = $props();

	const isEditing = $derived(provider !== null);

	let formName = $state('');
	let formType = $state('op-service-account');
	// One value per config field; blank means 'unset' (on edit: keep existing).
	let formConfig = $state<Record<string, string>>({});
	let formError = $state('');
	let formSaving = $state(false);
	let formTesting = $state(false);

	const fields = $derived(PROVIDER_FIELDS[formType] ?? []);

	function resetConfig() {
		formConfig = {};
	}

	function resetForm() {
		formName = '';
		formType = 'op-service-account';
		resetConfig();
		formError = '';
		formSaving = false;
		formTesting = false;
	}

	$effect(() => {
		if (open) {
			if (provider) {
				formName = provider.name;
				formType = provider.type;
				resetConfig();
				formError = '';
			} else {
				resetForm();
			}
		}
	});

	// The config never leaves the server, so on edit the fields start blank.
	// Collect only the fields the user actually filled in.
	function collectConfig(): Record<string, string> {
		const config: Record<string, string> = {};
		for (const field of fields) {
			const value = (formConfig[field.key] ?? '').trim();
			if (value) config[field.key] = value;
		}
		return config;
	}

	function missingRequired(config: Record<string, string>): string | null {
		for (const field of fields) {
			if (field.required && !config[field.key]) {
				return `${field.label} is required`;
			}
		}
		return null;
	}

	function onTypeChange(value: string) {
		formType = value;
		// Fields differ per type; drop any stale values.
		resetConfig();
		formError = '';
	}

	async function testCurrent() {
		formTesting = true;
		formError = '';
		try {
			const config = collectConfig();
			const configProvided = Object.keys(config).length > 0;

			let response: Response;
			if (isEditing && !configProvided) {
				// Test the stored (server-side) config.
				response = await fetch(`/api/secret-providers/${provider!.id}/test`, {
					method: 'POST',
				});
			} else {
				const missing = missingRequired(config);
				if (missing) {
					formError = missing;
					return;
				}
				response = await fetch('/api/secret-providers/test', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type: formType, config }),
				});
			}
			const data = await response.json();
			if (data.ok) {
				toast.success('Connection works');
			} else {
				toast.error(data.error || 'Connection failed');
				formError = data.error || 'Connection failed';
			}
		} catch {
			toast.error('Connection test failed');
		} finally {
			formTesting = false;
		}
	}

	async function save() {
		if (!formName.trim()) {
			formError = 'Name is required';
			return;
		}

		const config = collectConfig();
		const configProvided = Object.keys(config).length > 0;

		// On create, a complete config is required. On edit, config is optional
		// (blank keeps the stored config); if the user touches any field they
		// must supply the whole config, since it is replaced wholesale.
		if (!isEditing || configProvided) {
			const missing = missingRequired(config);
			if (missing) {
				formError = missing;
				return;
			}
		}

		formSaving = true;
		formError = '';

		try {
			const body: Record<string, unknown> = {
				name: formName.trim(),
				type: formType,
			};
			if (configProvided) body.config = config;

			const url = isEditing
				? `/api/secret-providers/${provider!.id}`
				: '/api/secret-providers';
			const method = isEditing ? 'PUT' : 'POST';

			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

			if (response.ok) {
				open = false;
				onSaved();
			} else {
				const data = await response.json();
				formError =
					data.error ||
					`Failed to ${isEditing ? 'update' : 'create'} secret provider`;
			}
		} catch {
			formError = `Failed to ${isEditing ? 'update' : 'create'} secret provider`;
		} finally {
			formSaving = false;
		}
	}

	function handleClose() {
		open = false;
		onClose();
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		if (o) {
			formError = "";
			focusFirstInput();
		}
	}}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title
				>{isEditing ? "Edit" : "Add"} secret provider</Dialog.Title
			>
		</Dialog.Header>
		<div class="space-y-4">
			{#if formError}
				<div class="text-sm text-red-600 dark:text-red-400">
					{formError}
				</div>
			{/if}
			<div class="space-y-2">
				<Label for="provider-name">Name</Label>
				<Input
					id="provider-name"
					bind:value={formName}
					placeholder="Production secrets"
				/>
			</div>
			<div class="space-y-2">
				<Label for="provider-type">Provider</Label>
				<Select.Root
					type="single"
					value={formType}
					onValueChange={onTypeChange}
					disabled={isEditing}
				>
					<Select.Trigger id="provider-type">
						{providerTypeLabel(formType)}
					</Select.Trigger>
					<Select.Content>
						{#each PROVIDER_TYPES as t (t.value)}
							<Select.Item value={t.value} label={t.label}>
								{t.label}
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			{#each fields as field (field.key)}
				<div class="space-y-2">
					<Label for={`provider-${field.key}`}>
						{field.label}{#if !field.required}<span
								class="text-muted-foreground"
							>
								(optional)</span
							>{/if}
					</Label>
					<Input
						id={`provider-${field.key}`}
						type={field.type}
						bind:value={formConfig[field.key]}
						placeholder={isEditing && field.type === "password"
							? "leave blank to keep existing"
							: field.placeholder}
					/>
					{#if field.hint}
						<p class="text-xs text-muted-foreground">{field.hint}</p>
					{/if}
				</div>
			{/each}
			<p class="text-xs text-muted-foreground">
				Configuration is stored encrypted.{#if isEditing}
					Leave secret fields blank to keep the existing values.{/if}
			</p>
		</div>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={testCurrent}
				disabled={formTesting || formSaving}
			>
				{#if formTesting}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else}
					<PlugZap class="w-4 h-4 mr-1" />
				{/if}
				Test connection
			</Button>
			<div class="flex-1"></div>
			<Button variant="outline" onclick={handleClose}>Cancel</Button>
			<Button onclick={save} disabled={formSaving}>
				{#if formSaving}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else if isEditing}
					<Check class="w-4 h-4" />
				{:else}
					<Plus class="w-4 h-4" />
				{/if}
				{isEditing ? "Save" : "Add"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
