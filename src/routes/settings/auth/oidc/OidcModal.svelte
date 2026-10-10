<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { LogIn, Pencil, Plus, Check, RefreshCw, Crown, Key, Shield, Trash2, TriangleAlert } from 'lucide-svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { focusFirstInput } from '$lib/utils';
	import { m } from '$lib/paraglide/messages.js';

	export interface OidcConfig {
		id: number;
		name: string;
		enabled: boolean;
		issuerUrl: string;
		clientId: string;
		clientSecret: string;
		redirectUri: string;
		scopes: string;
		usernameClaim: string;
		emailClaim: string;
		displayNameClaim: string;
		adminClaim?: string;
		adminValue?: string;
		roleMappingsClaim?: string;
		roleMappings?: { claimValue: string; roleId: number }[];
	}

	export interface Role {
		id: number;
		name: string;
		description?: string;
		isSystem: boolean;
		permissions: any;
		createdAt: string;
	}

	interface Props {
		open: boolean;
		oidc?: OidcConfig | null;
		roles: Role[];
		isEnterprise: boolean;
		onClose: () => void;
		onSaved: () => void;
		onNavigateToLicense?: () => void;
	}

	let { open = $bindable(), oidc = null, roles, isEnterprise, onClose, onSaved, onNavigateToLicense }: Props = $props();

	const isEditing = $derived(oidc !== null);

	// Form state
	let formName = $state('');
	let formEnabled = $state(false);
	let formIssuerUrl = $state('');
	let formClientId = $state('');
	let formClientSecret = $state('');
	let formRedirectUri = $state('');
	let formScopes = $state('openid profile email');
	let formUsernameClaim = $state('preferred_username');
	let formEmailClaim = $state('email');
	let formDisplayNameClaim = $state('name');
	let formAdminClaim = $state('');
	let formAdminValue = $state('');
	let formRoleMappingsClaim = $state('groups');
	let formRoleMappings = $state<{ claim_value: string; role_id: number }[]>([]);
	let formActiveTab = $state('general');
	let formError = $state('');
	let formErrors = $state<{ name?: string; issuerUrl?: string; clientId?: string; clientSecret?: string; redirectUri?: string }>({});
	let formSaving = $state(false);

	function resetForm() {
		formName = '';
		formEnabled = false;
		formIssuerUrl = '';
		formClientId = '';
		formClientSecret = '';
		formRedirectUri = typeof window !== 'undefined' ? `${window.location.origin}/api/auth/oidc/callback` : '';
		formScopes = 'openid profile email';
		formUsernameClaim = 'preferred_username';
		formEmailClaim = 'email';
		formDisplayNameClaim = 'name';
		formAdminClaim = '';
		formAdminValue = '';
		formRoleMappingsClaim = 'groups';
		formRoleMappings = [];
		formActiveTab = 'general';
		formError = '';
		formErrors = {};
		formSaving = false;
	}

	// Initialize form when oidc changes or modal opens
	$effect(() => {
		if (open) {
			if (oidc) {
				formName = oidc.name;
				formEnabled = oidc.enabled;
				formIssuerUrl = oidc.issuerUrl;
				formClientId = oidc.clientId;
				formClientSecret = oidc.clientSecret;
				formRedirectUri = oidc.redirectUri;
				formScopes = oidc.scopes || 'openid profile email';
				formUsernameClaim = oidc.usernameClaim || 'preferred_username';
				formEmailClaim = oidc.emailClaim || 'email';
				formDisplayNameClaim = oidc.displayNameClaim || 'name';
				formAdminClaim = oidc.adminClaim || '';
				formAdminValue = oidc.adminValue || '';
				formRoleMappingsClaim = oidc.roleMappingsClaim || 'groups';
				formRoleMappings = oidc.roleMappings ? oidc.roleMappings.map(m => ({ claim_value: m.claimValue, role_id: m.roleId })) : [];
				formActiveTab = 'general';
				formError = '';
				formErrors = {};
				formSaving = false;
			} else {
				resetForm();
			}
		}
	});

	async function save() {
		formErrors = {};
		let hasErrors = false;

		if (!formName.trim()) {
			formErrors.name = m.settings_oidc_error_name_required();
			hasErrors = true;
		}
		if (!formIssuerUrl.trim()) {
			formErrors.issuerUrl = m.settings_oidc_error_issuer_url_required();
			hasErrors = true;
		}
		if (!formClientId.trim()) {
			formErrors.clientId = m.settings_oidc_error_client_id_required();
			hasErrors = true;
		}
		if (!isEditing && !formClientSecret.trim()) {
			formErrors.clientSecret = m.settings_oidc_error_client_secret_required();
			hasErrors = true;
		}
		if (!formRedirectUri.trim()) {
			formErrors.redirectUri = m.settings_oidc_error_redirect_uri_required();
			hasErrors = true;
		}

		if (hasErrors) return;

		formSaving = true;
		formError = '';

		try {
			const url = isEditing ? `/api/auth/oidc/${oidc!.id}` : '/api/auth/oidc';
			const method = isEditing ? 'PUT' : 'POST';

			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: formName.trim(),
					enabled: formEnabled,
					issuerUrl: formIssuerUrl.trim(),
					clientId: formClientId.trim(),
					clientSecret: formClientSecret.trim(),
					redirectUri: formRedirectUri.trim(),
					scopes: formScopes.trim() || 'openid profile email',
					usernameClaim: formUsernameClaim.trim() || 'preferred_username',
					emailClaim: formEmailClaim.trim() || 'email',
					displayNameClaim: formDisplayNameClaim.trim() || 'name',
					adminClaim: formAdminClaim.trim() || undefined,
					adminValue: formAdminValue.trim() || undefined,
					roleMappings: formRoleMappings.length > 0 ? formRoleMappings.map(m => ({ claimValue: m.claim_value, roleId: m.role_id })) : undefined
				})
			});

			if (response.ok) {
				open = false;
				onSaved();
			} else {
				const data = await response.json();
				formError = data.error || (isEditing ? m.settings_oidc_error_update() : m.settings_oidc_error_create());
			}
		} catch {
			formError = isEditing ? m.settings_oidc_error_update() : m.settings_oidc_error_create();
		} finally {
			formSaving = false;
		}
	}

	function handleClose() {
		open = false;
		onClose();
	}

	function addRoleMapping() {
		formRoleMappings = [...formRoleMappings, { claim_value: '', role_id: 0 }];
	}

	function removeRoleMapping(index: number) {
		formRoleMappings = formRoleMappings.filter((_, i) => i !== index);
	}

	function updateRoleMappingRole(index: number, roleId: number) {
		formRoleMappings[index].role_id = roleId;
		formRoleMappings = [...formRoleMappings];
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) { formError = ''; formErrors = {}; focusFirstInput(); } }}>
	<Dialog.Content class="max-w-2xl h-[80vh] flex flex-col overflow-hidden">
		<Dialog.Header class="flex-shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				{#if isEditing}
					<Pencil class="w-5 h-5" />
					{m.settings_oidc_modal_title_edit()}
				{:else}
					<LogIn class="w-5 h-5" />
					{m.settings_oidc_modal_title_add()}
				{/if}
			</Dialog.Title>
		</Dialog.Header>

		<Tabs.Root bind:value={formActiveTab} class="flex-1 flex flex-col overflow-hidden">
			<Tabs.List class="flex-shrink-0 grid w-full grid-cols-2">
				<Tabs.Trigger value="general">{m.settings_oidc_tab_general()}</Tabs.Trigger>
				<Tabs.Trigger value="role-mapping" class="flex items-center gap-1.5">
					<Crown class="w-3.5 h-3.5 text-amber-500" />
					{m.settings_oidc_tab_role_mapping()}
				</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="general" class="flex-1 overflow-y-auto space-y-4 py-2 mt-0">
				{#if formError}
					<Alert.Root variant="destructive">
						<TriangleAlert class="h-4 w-4" />
						<Alert.Description>{formError}</Alert.Description>
					</Alert.Root>
				{/if}

				<!-- Basic Settings -->
				<div class="space-y-4">
					<h4 class="text-sm font-medium text-muted-foreground">{m.settings_oidc_basic_settings()}</h4>
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-2">
							<Label>{m.settings_oidc_name_label()} <span class="text-destructive">*</span></Label>
							<Input
								bind:value={formName}
								placeholder="Okta, Auth0, Azure AD..."
								class={formErrors.name ? 'border-destructive focus-visible:ring-destructive' : ''}
								oninput={() => formErrors.name = undefined}
							/>
							{#if formErrors.name}
								<p class="text-xs text-destructive">{formErrors.name}</p>
							{/if}
						</div>
						<div class="space-y-2">
							<Label>{m.settings_oidc_issuer_url_label()} <span class="text-destructive">*</span></Label>
							<Input
								bind:value={formIssuerUrl}
								placeholder="https://example.okta.com"
								class={formErrors.issuerUrl ? 'border-destructive focus-visible:ring-destructive' : ''}
								oninput={() => formErrors.issuerUrl = undefined}
							/>
							{#if formErrors.issuerUrl}
								<p class="text-xs text-destructive">{formErrors.issuerUrl}</p>
							{/if}
						</div>
					</div>
					<div class="flex items-center gap-2">
						<Checkbox
							checked={formEnabled}
							onCheckedChange={(checked) => formEnabled = checked === true}
						/>
						<Label class="text-sm font-normal cursor-pointer" onclick={() => formEnabled = !formEnabled}>
							{m.settings_oidc_enable_this_provider()}
						</Label>
					</div>
				</div>

				<!-- Client Credentials -->
				<div class="space-y-4">
					<h4 class="text-sm font-medium text-muted-foreground">{m.settings_oidc_client_credentials()}</h4>
					<p class="text-xs text-muted-foreground">{m.settings_oidc_client_credentials_hint()}</p>
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-2">
							<Label>{m.settings_oidc_client_id_label()} <span class="text-destructive">*</span></Label>
							<Input
								bind:value={formClientId}
								placeholder="your-client-id"
								class={formErrors.clientId ? 'border-destructive focus-visible:ring-destructive' : ''}
								oninput={() => formErrors.clientId = undefined}
							/>
							{#if formErrors.clientId}
								<p class="text-xs text-destructive">{formErrors.clientId}</p>
							{/if}
						</div>
						<div class="space-y-2">
							<Label>{m.settings_oidc_client_secret_label()} {#if !isEditing}<span class="text-destructive">*</span>{/if}</Label>
							<Input
								type="password"
								bind:value={formClientSecret}
								placeholder={isEditing ? m.settings_oidc_client_secret_keep_placeholder() : 'your-client-secret'}
								class={formErrors.clientSecret ? 'border-destructive focus-visible:ring-destructive' : ''}
								oninput={() => formErrors.clientSecret = undefined}
							/>
							{#if formErrors.clientSecret}
								<p class="text-xs text-destructive">{formErrors.clientSecret}</p>
							{/if}
						</div>
					</div>
				</div>

				<!-- Redirect & Scopes -->
				<div class="space-y-4">
					<h4 class="text-sm font-medium text-muted-foreground">{m.settings_oidc_redirect_settings()}</h4>
					<div class="space-y-2">
						<Label>{m.settings_oidc_redirect_uri_label()} <span class="text-destructive">*</span></Label>
						<Input
							bind:value={formRedirectUri}
							placeholder="https://dockhand.example.com/api/auth/oidc/callback"
							class={formErrors.redirectUri ? 'border-destructive focus-visible:ring-destructive' : ''}
							oninput={() => formErrors.redirectUri = undefined}
						/>
						{#if formErrors.redirectUri}
							<p class="text-xs text-destructive">{formErrors.redirectUri}</p>
						{:else}
							<p class="text-xs text-muted-foreground">{m.settings_oidc_redirect_uri_hint()}</p>
						{/if}
					</div>
					<div class="space-y-2">
						<Label>{m.settings_oidc_scopes_label()}</Label>
						<Input
							bind:value={formScopes}
							placeholder="openid profile email"
						/>
					</div>
				</div>

				<!-- Claim Mapping -->
				<div class="space-y-4">
					<h4 class="text-sm font-medium text-muted-foreground">{m.settings_oidc_claim_mapping()}</h4>
					<p class="text-xs text-muted-foreground">{m.settings_oidc_claim_mapping_hint()}</p>
					<div class="grid grid-cols-3 gap-4">
						<div class="space-y-2">
							<Label>{m.settings_oidc_username_claim_label()}</Label>
							<Input
								bind:value={formUsernameClaim}
								placeholder="preferred_username"
							/>
						</div>
						<div class="space-y-2">
							<Label>{m.settings_oidc_email_claim_label()}</Label>
							<Input
								bind:value={formEmailClaim}
								placeholder="email"
							/>
						</div>
						<div class="space-y-2">
							<Label>{m.settings_oidc_display_name_claim_label()}</Label>
							<Input
								bind:value={formDisplayNameClaim}
								placeholder="name"
							/>
						</div>
					</div>
				</div>
			</Tabs.Content>

			<Tabs.Content value="role-mapping" class="flex-1 overflow-y-auto space-y-4 py-2 mt-0">
				{#if !isEnterprise}
					<!-- Enterprise Feature Notice (no license) -->
					<div class="flex-1 flex items-center justify-center py-8">
						<div class="text-center">
							<h3 class="text-lg font-medium mb-2 flex items-center justify-center gap-2">
								<Crown class="w-5 h-5 text-amber-500" />
								{m.settings_oidc_enterprise_title()}
							</h3>
							<p class="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
								{m.settings_oidc_enterprise_description()}
							</p>
							{#if onNavigateToLicense}
								<Button onclick={() => { open = false; onNavigateToLicense?.(); }}>
									<Key class="w-4 h-4" />
									{m.settings_oidc_activate_license()}
								</Button>
							{/if}
						</div>
					</div>
				{:else}
					<!-- Admin Mapping (Simple) -->
					<div class="space-y-4">
						<h4 class="text-sm font-medium text-muted-foreground">{m.settings_oidc_admin_claim_title()}</h4>
						<p class="text-xs text-muted-foreground">{m.settings_oidc_admin_claim_hint()}</p>
						<div class="grid grid-cols-2 gap-4">
							<div class="space-y-2">
								<Label>{m.settings_oidc_claim_name_label()}</Label>
								<Input
									bind:value={formAdminClaim}
									placeholder={m.settings_oidc_claim_name_placeholder()}
								/>
								<p class="text-xs text-muted-foreground">{m.settings_oidc_claim_name_hint()}</p>
							</div>
							<div class="space-y-2">
								<Label>{m.settings_oidc_admin_values_label()}</Label>
								<Input
									bind:value={formAdminValue}
									placeholder="admin, Administrators"
								/>
								<p class="text-xs text-muted-foreground">{m.settings_oidc_admin_values_hint()}</p>
							</div>
						</div>
					</div>

					<!-- Role Mappings Grid -->
					<div class="space-y-4">
						<div class="flex items-center justify-between">
							<div>
								<h4 class="text-sm font-medium text-muted-foreground">{m.settings_oidc_role_mappings_title()}</h4>
								<p class="text-xs text-muted-foreground mt-0.5">{m.settings_oidc_role_mappings_hint()}</p>
							</div>
							<Button
								size="sm"
								variant="outline"
								onclick={addRoleMapping}
							>
								<Plus class="w-4 h-4" />
								{m.settings_oidc_add_mapping()}
							</Button>
						</div>

						{#if formRoleMappings.length === 0}
							<div class="text-center py-6 text-muted-foreground text-sm border border-dashed rounded-lg">
								{m.settings_oidc_no_role_mappings()}
							</div>
						{:else}
							<div class="space-y-2">
								{#each formRoleMappings as mapping, index}
									<div class="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
										<div class="flex-1 grid grid-cols-2 gap-3">
											<div class="space-y-1">
												<Label class="text-xs">{m.settings_oidc_claim_value_label()}</Label>
												<Input
													bind:value={mapping.claim_value}
													placeholder={m.settings_oidc_claim_value_placeholder()}
													class="h-8"
												/>
											</div>
											<div class="space-y-1">
												<Label class="text-xs">{m.settings_oidc_dockhand_role_label()}</Label>
												<Select.Root
													type="single"
													value={mapping.role_id ? String(mapping.role_id) : undefined}
													onValueChange={(value) => {
														if (value) {
															updateRoleMappingRole(index, parseInt(value));
														}
													}}
												>
													<Select.Trigger class="h-8">
														{#if mapping.role_id}
															{roles.find(r => r.id === mapping.role_id)?.name || m.settings_oidc_select_role()}
														{:else}
															{m.settings_oidc_select_role()}
														{/if}
													</Select.Trigger>
													<Select.Content>
														{#each roles as role}
															<Select.Item value={String(role.id)}>
																<div class="flex items-center gap-2">
																	<Shield class="w-3.5 h-3.5 text-muted-foreground" />
																	{role.name}
																</div>
															</Select.Item>
														{/each}
													</Select.Content>
												</Select.Root>
											</div>
										</div>
										<Button
											size="sm"
											variant="ghost"
											class="text-destructive hover:text-destructive h-8 w-8 p-0"
											onclick={() => removeRoleMapping(index)}
										>
											<Trash2 class="w-4 h-4" />
										</Button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</Tabs.Content>
		</Tabs.Root>

		<Dialog.Footer class="flex-shrink-0 border-t pt-4">
			<Button variant="outline" onclick={handleClose}>{m.settings_oidc_cancel()}</Button>
			<Button onclick={save} disabled={formSaving}>
				{#if formSaving}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else if isEditing}
					<Check class="w-4 h-4" />
				{:else}
					<Plus class="w-4 h-4" />
				{/if}
				{isEditing ? m.settings_oidc_save() : m.settings_oidc_add_provider()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
