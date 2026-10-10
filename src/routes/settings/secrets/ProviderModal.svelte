<script lang='ts' module>
	import { m } from '$lib/paraglide/messages.js';

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
		{ value: 'op-service-account', get label() { return m.settings_secrets_type_op_service_account(); } },
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
	// Display texts are getters so they are read in the current UI language.
	export const PROVIDER_FIELDS: Record<string, ProviderField[]> = {
		'op-service-account': [
			{ key: 'token', get label() { return m.settings_secrets_field_op_sa_token(); }, type: 'password', required: true, placeholder: 'ops_eyJ...', get hint() { return m.settings_secrets_field_op_sa_token_hint(); } },
		],
		'op-connect': [
			{ key: 'host', get label() { return m.settings_secrets_field_connect_host(); }, type: 'text', required: true, placeholder: 'https://connect.example.com', get hint() { return m.settings_secrets_field_connect_host_hint(); } },
			{ key: 'token', get label() { return m.settings_secrets_field_connect_token(); }, type: 'password', required: true, placeholder: 'eyJ...', get hint() { return m.settings_secrets_field_connect_token_hint(); } },
		],
		infisical: [
			{ key: 'host', get label() { return m.settings_secrets_field_infisical_host(); }, type: 'text', required: true, placeholder: 'https://app.infisical.com', get hint() { return m.settings_secrets_field_infisical_host_hint(); } },
			{ key: 'token', get label() { return m.settings_secrets_field_infisical_token(); }, type: 'password', required: false, placeholder: 'st...', get hint() { return m.settings_secrets_field_infisical_token_hint(); } },
			{ key: 'clientId', get label() { return m.settings_secrets_field_infisical_client_id(); }, type: 'text', required: false, get placeholder() { return m.settings_secrets_field_infisical_client_id_placeholder(); }, get hint() { return m.settings_secrets_field_infisical_client_id_hint(); } },
			{ key: 'clientSecret', get label() { return m.settings_secrets_field_infisical_client_secret(); }, type: 'password', required: false, get placeholder() { return m.settings_secrets_field_infisical_client_secret_placeholder(); }, get hint() { return m.settings_secrets_field_infisical_client_secret_hint(); } },
			// A single-scope service token (st.*) carries its own project + environment, so
			// both are optional for it. A multi-scope or glob-path service token, and every
			// other auth shape (Universal Auth, static non-st token), still need them.
			{ key: 'projectId', get label() { return m.settings_secrets_field_project_id(); }, type: 'text', required: true, requiredWhen: (c) => !(c.token ?? '').trim().startsWith('st.'), get placeholder() { return m.settings_secrets_field_infisical_project_id_placeholder(); }, get hint() { return m.settings_secrets_field_infisical_project_id_hint(); } },
			{ key: 'environment', get label() { return m.settings_secrets_field_environment(); }, type: 'text', required: true, requiredWhen: (c) => !(c.token ?? '').trim().startsWith('st.'), placeholder: 'prod', get hint() { return m.settings_secrets_field_infisical_environment_hint(); } },
			{ key: 'path', get label() { return m.settings_secrets_field_secret_path(); }, type: 'text', required: false, placeholder: '/', get hint() { return m.settings_secrets_field_infisical_path_hint(); } },
		],
		vault: [
			{ key: 'address', get label() { return m.settings_secrets_field_vault_address(); }, type: 'text', required: true, placeholder: 'https://vault.example.com', get hint() { return m.settings_secrets_field_vault_address_hint(); } },
			{ key: 'token', get label() { return m.settings_secrets_field_vault_token(); }, type: 'password', required: true, placeholder: 'hvs...', get hint() { return m.settings_secrets_field_vault_token_hint(); } },
			{ key: 'namespace', get label() { return m.settings_secrets_field_vault_namespace(); }, type: 'text', required: false, placeholder: 'admin (Enterprise / HCP)', get hint() { return m.settings_secrets_field_vault_namespace_hint(); } },
			{ key: 'mount', get label() { return m.settings_secrets_field_vault_mount(); }, type: 'text', required: false, placeholder: 'secret', get hint() { return m.settings_secrets_field_vault_mount_hint(); } },
		],
		doppler: [
			{ key: 'token', get label() { return m.settings_secrets_field_doppler_token(); }, type: 'password', required: true, get placeholder() { return m.settings_secrets_field_doppler_token_placeholder(); }, get hint() { return m.settings_secrets_field_doppler_token_hint(); } },
			{ key: 'project', get label() { return m.settings_secrets_field_project(); }, type: 'text', required: false, get placeholder() { return m.settings_secrets_field_doppler_project_placeholder(); }, get hint() { return m.settings_secrets_field_doppler_project_hint(); } },
			{ key: 'config', get label() { return m.settings_secrets_field_doppler_config(); }, type: 'text', required: false, get placeholder() { return m.settings_secrets_field_doppler_config_placeholder(); }, get hint() { return m.settings_secrets_field_doppler_config_hint(); } },
		],
		bitwarden: [
			{ key: 'token', get label() { return m.settings_secrets_field_bitwarden_token(); }, type: 'password', required: true, get placeholder() { return m.settings_secrets_field_bitwarden_token(); }, get hint() { return m.settings_secrets_field_bitwarden_token_hint(); } },
			{ key: 'serverUrl', get label() { return m.settings_secrets_field_bitwarden_server_url(); }, type: 'text', required: false, placeholder: 'https://vault.bitwarden.com', get hint() { return m.settings_secrets_field_bitwarden_server_url_hint(); } },
		],
		proton: [
			{ key: 'token', get label() { return m.settings_secrets_field_proton_token(); }, type: 'password', required: true, placeholder: 'pst_...::...', get hint() { return m.settings_secrets_field_proton_token_hint(); } },
		],
		'azure-kv': [
			{ key: 'vaultUri', get label() { return m.settings_secrets_field_azure_vault_uri(); }, type: 'text', required: true, placeholder: 'https://my-vault.vault.azure.net', get hint() { return m.settings_secrets_field_azure_vault_uri_hint(); } },
			{ key: 'tenantId', get label() { return m.settings_secrets_field_azure_tenant_id(); }, type: 'text', required: true, get placeholder() { return m.settings_secrets_field_azure_tenant_id_placeholder(); }, get hint() { return m.settings_secrets_field_azure_tenant_id_hint(); } },
			{ key: 'clientId', get label() { return m.settings_secrets_field_azure_client_id(); }, type: 'text', required: true, get placeholder() { return m.settings_secrets_field_azure_client_id_placeholder(); }, get hint() { return m.settings_secrets_field_azure_client_id_hint(); } },
			{ key: 'clientSecret', get label() { return m.settings_secrets_field_azure_client_secret(); }, type: 'password', required: true, get placeholder() { return m.settings_secrets_field_azure_client_secret_placeholder(); }, get hint() { return m.settings_secrets_field_azure_client_secret_hint(); } },
		],
		keepass: [
			{ key: 'databasePath', get label() { return m.settings_secrets_field_keepass_database_path(); }, type: 'text', required: true, placeholder: '/secrets/passwords.kdbx', get hint() { return m.settings_secrets_field_keepass_database_path_hint(); } },
			{ key: 'password', get label() { return m.settings_secrets_field_keepass_password(); }, type: 'password', required: false, requiredWhen: (c) => !(c.keyFilePath ?? '').trim(), get placeholder() { return m.settings_secrets_field_keepass_password_placeholder(); }, get hint() { return m.settings_secrets_field_keepass_password_hint(); } },
			{ key: 'keyFilePath', get label() { return m.settings_secrets_field_keepass_key_file(); }, type: 'text', required: false, placeholder: '/secrets/db.keyx', get hint() { return m.settings_secrets_field_keepass_key_file_hint(); } },
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
			get label() { return m.settings_secrets_field_environment(); },
			get placeholder() { return m.settings_secrets_bulk_op_placeholder(); },
			get hint() { return m.settings_secrets_bulk_op_hint(); }
		},
		'vault': {
			get label() { return m.settings_secrets_bulk_vault_label(); },
			placeholder: 'path/to/secret',
			get hint() { return m.settings_secrets_bulk_vault_hint(); }
		},
		'infisical': {
			get label() { return m.settings_secrets_field_secret_path(); },
			placeholder: '/',
			get hint() { return m.settings_secrets_bulk_infisical_hint(); }
		},
		'bitwarden': {
			get label() { return m.settings_secrets_field_project(); },
			get placeholder() { return m.settings_secrets_bulk_bitwarden_placeholder(); },
			get hint() { return m.settings_secrets_bulk_bitwarden_hint(); }
		},
		'proton': {
			get label() { return m.settings_secrets_bulk_proton_label(); },
			get placeholder() { return m.settings_secrets_bulk_proton_placeholder(); },
			get hint() { return m.settings_secrets_bulk_proton_hint(); }
		},
		'azure-kv': {
			label: 'Key Vault',
			get placeholder() { return m.settings_secrets_bulk_azure_placeholder(); },
			get hint() { return m.settings_secrets_bulk_azure_hint(); }
		},
		'keepass': {
			get label() { return m.settings_secrets_bulk_keepass_label(); },
			get placeholder() { return m.settings_secrets_bulk_keepass_placeholder(); },
			get hint() { return m.settings_secrets_bulk_keepass_hint(); }
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
				return m.settings_secrets_error_field_required({ field: field.label });
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
				toast.success(m.settings_secrets_toast_connection_works());
				clearTimeout(testOkTimer);
				testOk = true;
				testOkTimer = setTimeout(() => (testOk = false), 2000);
			} else {
				toast.error(data.error || m.settings_secrets_connection_failed());
				formError = data.error || m.settings_secrets_connection_failed();
			}
		} catch {
			toast.error(m.settings_secrets_toast_connection_test_failed());
		} finally {
			formTesting = false;
		}
	}

	async function save() {
		if (!formName.trim()) {
			formError = m.settings_secrets_error_name_required();
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
					(isEditing ? m.settings_secrets_error_update_failed() : m.settings_secrets_error_create_failed());
			}
		} catch {
			formError = isEditing ? m.settings_secrets_error_update_failed() : m.settings_secrets_error_create_failed();
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
				{isEditing ? m.settings_secrets_edit_provider() : m.settings_secrets_add_provider()}
			</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			{#if formError}
				<div class="text-sm text-red-600 dark:text-red-400">
					{formError}
				</div>
			{/if}
			<div class="space-y-2">
				<FieldLabel label={m.settings_secrets_name_label()} forId="provider-name" required showOptional={false} />
				<Input
					id="provider-name"
					bind:value={formName}
					placeholder={m.settings_secrets_name_placeholder()}
				/>
			</div>
			<div class="space-y-2">
				<FieldLabel label={m.settings_secrets_provider_label()} forId="provider-type" required showOptional={false} />
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
								? m.settings_secrets_keep_existing_placeholder()
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
								{m.settings_secrets_bws_note_before()}
								<code>bws</code> {m.settings_secrets_cli_note_client_at()} <code>/usr/local/bin/bws</code> {m.settings_secrets_cli_note_override_before()}
								<code>DOCKHAND_BWS_PATH</code> {m.settings_secrets_bws_note_override_after()}
							</span>
						</p>
					{:else if formType === 'keepass'}
						<p class="flex items-start gap-2 text-xs text-muted-foreground">
							<Info class="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
							<span>
								{m.settings_secrets_keepass_note_before()} <code>keepassxc-cli</code> {m.settings_secrets_keepass_note_override_before()}
								<code>DOCKHAND_KEEPASSXC_CLI_PATH</code> {m.settings_secrets_keepass_note_database_before()}
								<code>.kdbx</code> {m.settings_secrets_keepass_note_database_after()}
								<code>keepass://</code>
								{m.settings_secrets_cli_note_references()}
							</span>
						</p>
					{:else}
						<p class="flex items-start gap-2 text-xs text-muted-foreground">
							<Info class="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
							<span>
								{m.settings_secrets_proton_note_before()}
								<code>pass-cli</code> {m.settings_secrets_cli_note_client_at()} <code>/usr/local/bin/pass-cli</code> {m.settings_secrets_cli_note_override_before()}
								<code>DOCKHAND_PASS_CLI_PATH</code> {m.settings_secrets_proton_note_override_after()}
								<code>pass://</code> {m.settings_secrets_cli_note_references()}
							</span>
						</p>
					{/if}
				</div>
			{/if}
			<p class="text-xs text-muted-foreground">
				{m.settings_secrets_config_encrypted()}{#if isEditing}
					{m.settings_secrets_config_keep_blank()}{/if}
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
				{m.settings_secrets_test_connection()}
			</Button>
			<div class="flex-1"></div>
			<Button variant="outline" onclick={handleClose}>{m.settings_secrets_cancel()}</Button>
			<Button onclick={save} disabled={formSaving}>
				{#if formSaving}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else if isEditing}
					<Check class="w-4 h-4" />
				{:else}
					<Plus class="w-4 h-4" />
				{/if}
				{isEditing ? m.settings_secrets_save() : m.settings_secrets_add()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
