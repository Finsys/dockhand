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
		/** When present, overrides `required` based on the current form values (e.g. a
		 *  field that is only required for some auth shapes). */
		requiredWhen?: (config: Record<string, string>) => boolean;
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
		{ value: 'doppler', label: 'Doppler' },
		{ value: 'bitwarden', label: 'Bitwarden Secrets Manager' },
		{ value: 'proton', label: 'Proton Pass' },
		{ value: 'azure-kv', label: 'Azure Key Vault' },
		{ value: 'keepass', label: 'KeePassXC' },
	];

	// Config fields per provider type, matching the config shapes in
	// secretproviders/shared.ts. Non-required fields are optional overrides.
	export const PROVIDER_FIELDS: Record<string, ProviderField[]> = {
		'op-service-account': [
			{ key: 'token', label: 'Service account token', type: 'password', required: true, placeholder: 'ops_eyJ...', hint: 'A 1Password service account token (starts with ops_).' },
		],
		'op-connect': [
			{ key: 'host', label: 'Connect host URL', type: 'text', required: true, placeholder: 'https://connect.example.com', hint: 'URL of your 1Password Connect server.' },
			{ key: 'token', label: 'Connect token', type: 'password', required: true, placeholder: 'eyJ...', hint: 'A Connect access token with read access to the vault.' },
		],
		infisical: [
			{ key: 'host', label: 'API host', type: 'text', required: true, placeholder: 'https://app.infisical.com', hint: 'Infisical Cloud or your self-hosted URL.' },
			{ key: 'token', label: 'Access token', type: 'password', required: false, placeholder: 'st...', hint: 'A static service/access token. Leave blank to use Universal Auth (client ID + secret) below instead.' },
			{ key: 'clientId', label: 'Universal Auth client ID', type: 'text', required: false, placeholder: 'machine identity client id', hint: 'A Machine Identity client ID. Pair with the client secret; leave blank if using a static token.' },
			{ key: 'clientSecret', label: 'Universal Auth client secret', type: 'password', required: false, placeholder: 'machine identity client secret', hint: 'The Machine Identity client secret. Exchanged for a short-lived token via Universal Auth.' },
			// A single-scope service token (st.*) carries its own project + environment, so
			// both are optional for it. A multi-scope or glob-path service token, and every
			// other auth shape (Universal Auth, static non-st token), still need them.
			{ key: 'projectId', label: 'Project ID', type: 'text', required: true, requiredWhen: (c) => !(c.token ?? '').trim().startsWith('st.'), placeholder: 'workspace / project id', hint: 'The workspace/project the secrets live in. Optional for a single-scope service token (st.), which already targets one project; a multi-scope token still needs it.' },
			{ key: 'environment', label: 'Environment', type: 'text', required: true, requiredWhen: (c) => !(c.token ?? '').trim().startsWith('st.'), placeholder: 'prod', hint: 'Environment slug, e.g. prod / staging. Optional for a single-scope service token (st.).' },
			{ key: 'path', label: 'Secret path', type: 'text', required: false, placeholder: '/', hint: 'Folder path within the project. Defaults to /.' },
		],
		vault: [
			{ key: 'address', label: 'Vault address', type: 'text', required: true, placeholder: 'https://vault.example.com', hint: 'Base URL of your Vault server.' },
			{ key: 'token', label: 'Vault token', type: 'password', required: true, placeholder: 'hvs...', hint: 'A token with read access to the KV path.' },
			{ key: 'namespace', label: 'Namespace', type: 'text', required: false, placeholder: 'admin (Enterprise / HCP)', hint: 'Vault Enterprise / HCP only.' },
			{ key: 'mount', label: 'KV mount', type: 'text', required: false, placeholder: 'secret', hint: 'KV v2 mount path. Defaults to "secret".' },
		],
		doppler: [
			{ key: 'token', label: 'Token', type: 'password', required: true, placeholder: 'dp.st.... or dp.pt....', hint: 'A service token (dp.st.) already targets one config. A personal token (dp.pt.) also needs the project and config below.' },
			{ key: 'project', label: 'Project', type: 'text', required: false, placeholder: 'only for a personal token (dp.pt.)', hint: 'Doppler project slug. Only needed with a personal token.' },
			{ key: 'config', label: 'Config', type: 'text', required: false, placeholder: 'e.g. prd', hint: 'Config within the project. Only needed with a personal token.' },
		],
		bitwarden: [
			{ key: 'token', label: 'Machine Account access token', type: 'password', required: true, placeholder: 'Machine Account access token', hint: 'A Bitwarden Secrets Manager Machine Account token with read access to the Project.' },
			{ key: 'serverUrl', label: 'Server URL', type: 'text', required: false, placeholder: 'https://vault.bitwarden.com', hint: 'Optional for EU or self-hosted Bitwarden. Leave blank for Bitwarden US cloud.' },
		],
		proton: [
			{ key: 'token', label: 'Personal access token', type: 'password', required: true, placeholder: 'pst_...::...', hint: 'A Proton Pass personal access token (pst_...) used by the operator-installed pass-cli.' },
		],
		'azure-kv': [
			{ key: 'vaultUri', label: 'Vault URI', type: 'text', required: true, placeholder: 'https://my-vault.vault.azure.net', hint: 'The Key Vault URI (from the vault Overview page).' },
			{ key: 'tenantId', label: 'Tenant ID', type: 'text', required: true, placeholder: 'directory (tenant) ID', hint: 'Azure AD tenant (directory) ID of the app registration.' },
			{ key: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'application (client) ID', hint: 'The service-principal (app registration) client ID.' },
			{ key: 'clientSecret', label: 'Client secret', type: 'password', required: true, placeholder: 'app registration client secret', hint: 'A client secret for the app registration, with Get/List secret permission on the vault.' },
		],
		keepass: [
			{ key: 'databasePath', label: 'Database path', type: 'text', required: true, placeholder: '/secrets/passwords.kdbx', hint: 'Absolute path to the .kdbx file as seen inside the Dockhand container (bind-mount it read-only). keepassxc-cli must be installed in the container.' },
			{ key: 'password', label: 'Master password', type: 'password', required: false, requiredWhen: (c) => !(c.keyFilePath ?? '').trim(), placeholder: 'database master password', hint: 'The database master password. Optional if a key file is provided instead (or in addition).' },
			{ key: 'keyFilePath', label: 'Key file path', type: 'text', required: false, placeholder: '/secrets/db.keyx', hint: 'Optional absolute path to the database key file, as seen inside the container.' },
		],
	};

	export function providerTypeLabel(type: string): string {
		return PROVIDER_TYPES.find((t) => t.value === type)?.label ?? type;
	}

	// Per-stack bulk-selector field metadata (UI-only, like PROVIDER_FIELDS above).
	// A provider type with no entry shows no selector field: doppler ignores the
	// selector, connect has no bulk pull. The field's value is written to the stack
	// env as DOCKHAND_SECRET_SELECTOR (consumed by resolveProviderEnvVars).
	export type BulkSelectorField = { label: string; placeholder?: string; hint?: string };
	export const BULK_SELECTOR_FIELDS: Record<string, BulkSelectorField> = {
		'op-service-account': {
			label: 'Environment',
			placeholder: '1Password Environment id',
			hint: 'Bulk-load every secret from this 1Password Environment. Leave blank to inject only inline op:// references.'
		},
		'vault': {
			label: 'KV v2 path',
			placeholder: 'path/to/secret',
			hint: 'Bulk-load every key at this KV v2 path (under the configured mount).'
		},
		'infisical': {
			label: 'Secret path',
			placeholder: '/',
			hint: 'Bulk-load every secret at this path (project and environment come from the provider config).'
		},
		'bitwarden': {
			label: 'Project',
			placeholder: 'Bitwarden Project UUID',
			hint: 'Bulk-load every secret from this Bitwarden Secrets Manager Project.'
		},
		'proton': {
			label: 'Vault',
			placeholder: 'Proton Pass vault name',
			hint: 'Bulk-load every item from this Proton Pass vault. Leave blank to inject only inline pass:// references.'
		},
		'azure-kv': {
			label: 'Key Vault',
			placeholder: 'any value enables bulk pull',
			hint: 'Bulk-load every secret in the vault. Set any value to enable it; leave blank to inject only inline azurekv:// references.'
		},
		'keepass': {
			label: 'Group',
			placeholder: 'e.g. dockhand (leave blank for inline refs only)',
			hint: 'Bulk-load every entry under this group as ENV=<entry password>. Leave blank to inject only inline keepass:// references.'
		}
	};
</script>

<script lang='ts'>
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { FieldLabel } from '$lib/components/ui/field-label';
	import { Input } from '$lib/components/ui/input';
	import { Plus, Check, RefreshCw, PlugZap, KeyRound, Info } from 'lucide-svelte';
	import { scale } from 'svelte/transition';
	import { backOut, cubicIn } from 'svelte/easing';
	import { getProviderIcon } from '$lib/components/provider-icons';
	import { collectProviderFormConfig } from '$lib/utils/provider-form-config';
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
	// Non-secret keys that were present in the stored config when the edit form loaded. If
	// the user clears one, we must send an explicit '' so the server knows it was cleared
	// (a merely absent key means "unchanged"). This is what lets clearing Infisical's
	// clientId drop its orphaned clientSecret (#1448).
	let loadedConfigKeys = $state<Set<string>>(new Set());
	let formError = $state('');
	let formSaving = $state(false);
	let formTesting = $state(false);
	// Brief green tick on the Test connection button right after a successful test.
	let testOk = $state(false);
	let testOkTimer: ReturnType<typeof setTimeout> | undefined;

	const fields = $derived(PROVIDER_FIELDS[formType] ?? []);
	// Providers whose config fields read better stacked one per row rather than in the
	// 2-column grid (per-field hints, or fields long enough to want full width).
	const stackConfigFields = $derived(
		formType === 'op-connect' || formType === 'doppler'
	);

	function resetConfig() {
		formConfig = {};
		loadedConfigKeys = new Set();
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
				// Pre-fill the NON-secret config fields (host, projectId, mount, ...) from
				// the server; the token stays blank ('keep existing'). The list only has a
				// summary, so fetch the single provider which returns the redacted config.
				void loadProviderConfig(provider.id);
			} else {
				resetForm();
			}
		}
	});

	async function loadProviderConfig(id: number) {
		try {
			const res = await fetch(`/api/secret-providers/${id}`);
			if (!res.ok) return;
			const data = await res.json();
			const cfg = (data?.config ?? {}) as Record<string, unknown>;
			const next: Record<string, string> = {};
			for (const [key, value] of Object.entries(cfg)) {
				if (value != null) next[key] = String(value);
			}
			formConfig = next; // secret fields (token) are absent -> stay blank
			loadedConfigKeys = new Set(Object.keys(next));
		} catch {
			// leave fields blank on failure - the user can re-enter them
		}
	}

	// See collectProviderFormConfig: a blank secret field means "keep stored"; a cleared
	// non-secret field that was loaded is sent as an explicit '' so the server can drop it
	// (and any paired secret, e.g. Infisical clientSecret when clientId is cleared). #1448
	function collectConfig(): Record<string, string> {
		return collectProviderFormConfig(
			fields.map((f) => ({ key: f.key, isSecret: f.type === 'password' })),
			formConfig,
			loadedConfigKeys
		);
	}

	function fieldRequired(field: ProviderField, config: Record<string, string>): boolean {
		return field.requiredWhen ? field.requiredWhen(config) : field.required;
	}

	function missingRequired(config: Record<string, string>, editing = false): string | null {
		for (const field of fields) {
			// On edit a blank secret (password) field keeps the stored value, so it is
			// allowed to be empty; non-secret required fields still must be present.
			if (editing && field.type === 'password') continue;
			if (fieldRequired(field, config) && !config[field.key]) {
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
			const missing = missingRequired(config, isEditing);
			if (missing) {
				formError = missing;
				return;
			}

			let response: Response;
			if (isEditing) {
				// Test EXACTLY what a Save would persist: the typed non-secret fields, merged
				// server-side over the stored config (a blank token keeps the stored one). This
				// makes an edited address/mount/namespace actually get tested - not the old
				// stored config.
				response = await fetch(`/api/secret-providers/${provider!.id}/test`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ config }),
				});
			} else {
				response = await fetch('/api/secret-providers/test', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ type: formType, config }),
				});
			}
			const data = await response.json();
			if (data.ok) {
				toast.success('Connection works');
				clearTimeout(testOkTimer);
				testOk = true;
				testOkTimer = setTimeout(() => (testOk = false), 2000);
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

		// On create, every required field must be present. On EDIT, a blank SECRET
		// field (token) means "keep the stored value", so a required secret is allowed
		// to be blank; non-secret required fields (host, projectId, ...) are pre-filled
		// and still validated. The backend merges the stored secret over the blank.
		const missing = missingRequired(config, isEditing);
		if (missing) {
			formError = missing;
			return;
		}

		formSaving = true;
		formError = '';

		try {
			const body: Record<string, unknown> = {
				name: formName.trim(),
				type: formType,
				// Always send config; on edit the backend keeps the stored secret when a
				// secret field is blank (updateSecretProvider merges), and the non-secret
				// fields are pre-filled, so `config` is the full intended coordinates.
				config,
			};

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
		clearTimeout(testOkTimer);
		testOk = false;
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
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<KeyRound class="w-5 h-5 text-muted-foreground" />
				{isEditing ? "Edit" : "Add"} secret provider
			</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			{#if formError}
				<div class="text-sm text-red-600 dark:text-red-400">
					{formError}
				</div>
			{/if}
			<div class="space-y-2">
				<FieldLabel label="Name" forId="provider-name" required showOptional={false} />
				<Input
					id="provider-name"
					bind:value={formName}
					placeholder="Production secrets"
				/>
			</div>
			<div class="space-y-2">
				<FieldLabel label="Provider" forId="provider-type" required showOptional={false} />
				<Select.Root
					type="single"
					value={formType}
					onValueChange={onTypeChange}
					disabled={isEditing}
				>
					<Select.Trigger id="provider-type" class="w-full justify-between gap-2">
						{@const TriggerIcon = getProviderIcon(formType)}
						<span class="flex items-center gap-2 min-w-0">
							<TriggerIcon class="w-4 h-4 shrink-0 text-muted-foreground" />
							<span class="truncate">{providerTypeLabel(formType)}</span>
						</span>
					</Select.Trigger>
					<Select.Content>
						{#each PROVIDER_TYPES as t (t.value)}
							{@const ItemIcon = getProviderIcon(t.value)}
							<Select.Item value={t.value} label={t.label}>
								<span class="flex items-center gap-2">
									<ItemIcon class="w-4 h-4 shrink-0 text-muted-foreground" />
									{t.label}
								</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<!-- Provider config fields: a 2-column grid, or one per row for providers whose
			     fields read better stacked (Vault, Connect, Doppler). min-height +
			     content-start keep the dialog a stable height while laying rows top-aligned. -->
			<div class="grid {stackConfigFields ? 'grid-cols-1' : 'grid-cols-2'} gap-x-4 gap-y-3 content-start" style="min-height: 21rem;">
				{#each fields as field (field.key)}
					<div class="space-y-1.5 self-start {fields.length === 1 ? 'col-span-full' : ''}">
						<FieldLabel label={field.label} forId={`provider-${field.key}`} required={fieldRequired(field, formConfig)} />
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
			</div>
			{#if formType === 'bitwarden' || formType === 'proton' || formType === 'keepass'}
				<!-- Fixed min-height so switching between the bitwarden (shorter) and proton
				     (taller) external-CLI notes doesn't jump the dialog's vertical size. -->
				<div class="min-h-16">
					{#if formType === 'bitwarden'}
						<p class="flex items-start gap-2 text-xs text-muted-foreground">
							<Info class="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
							<span>
								Bitwarden Secrets Manager requires an externally installed or mounted official
								<code>bws</code> client at <code>/usr/local/bin/bws</code> (or an absolute
								<code>DOCKHAND_BWS_PATH</code> process override).
							</span>
						</p>
					{:else if formType === 'keepass'}
						<p class="flex items-start gap-2 text-xs text-muted-foreground">
							<Info class="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
							<span>
								KeePassXC requires the official <code>keepassxc-cli</code> client installed in the
								container (or an absolute <code>DOCKHAND_KEEPASSXC_CLI_PATH</code> process override),
								and the <code>.kdbx</code> database bind-mounted into the container read-only at the
								path above. Supports both a bulk group pull and inline <code>keepass://</code>
								references.
							</span>
						</p>
					{:else}
						<p class="flex items-start gap-2 text-xs text-muted-foreground">
							<Info class="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
							<span>
								Proton Pass requires an externally installed or mounted official
								<code>pass-cli</code> client at <code>/usr/local/bin/pass-cli</code> (or an absolute
								<code>DOCKHAND_PASS_CLI_PATH</code> process override). Supports both a bulk vault pull
								and inline <code>pass://</code> references.
							</span>
						</p>
					{/if}
				</div>
			{/if}
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
				class={`transition-colors duration-300 ${testOk ? 'border-green-500/60 text-green-600 dark:text-green-400' : ''}`}
			>
				<span class="inline-flex w-4 h-4 mr-1 items-center justify-center shrink-0">
					{#if formTesting}
						<RefreshCw class="w-4 h-4 animate-spin" />
					{:else if testOk}
						<span in:scale={{ duration: 260, start: 0.4, easing: backOut }} out:scale={{ duration: 150, start: 0.6, easing: cubicIn }}>
							<Check class="w-4 h-4 text-green-600 dark:text-green-400" />
						</span>
					{:else}
						<PlugZap class="w-4 h-4" />
					{/if}
				</span>
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
