<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Badge } from '$lib/components/ui/badge';
	import { User, UserPlus, Pencil, KeyRound, Crown, ShieldCheck, RefreshCw, Check, Globe, TriangleAlert, Shield, Eye, Wrench, Tag, Smartphone } from 'lucide-svelte';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import * as Alert from '$lib/components/ui/alert';
	import { focusFirstInput } from '$lib/utils';
	import PasswordStrengthIndicator from '$lib/components/PasswordStrengthIndicator.svelte';
	import { m } from '$lib/paraglide/messages.js';

	export interface LocalUser {
		id: number;
		username: string;
		email?: string;
		displayName?: string;
		mfaEnabled: boolean;
		isAdmin: boolean;
		isActive: boolean;
		isSso: boolean;
		lastLogin?: string;
		createdAt: string;
	}

	export interface Role {
		id: number;
		name: string;
		description?: string;
		isSystem: boolean;
		permissions: any;
		environmentIds?: number[] | null; // null = all environments, array = specific envs
		createdAt: string;
	}

	// Simple role assignment - just the role ID (env scope is on the role itself)
	interface RoleAssignment {
		roleId: number;
	}

	interface Props {
		open: boolean;
		user?: LocalUser | null;
		roles: Role[];
		isEnterprise?: boolean;
		onClose: () => void;
		onSaved: () => void;
	}

	let {
		open = $bindable(),
		user = null,
		roles = [],
		isEnterprise = false,
		onClose,
		onSaved
	}: Props = $props();

	const isEditing = $derived(user !== null);

	// Form state
	let formUsername = $state('');
	let formEmail = $state('');
	let formDisplayName = $state('');
	let formPassword = $state('');
	let formPasswordRepeat = $state('');
	let formRoleAssignments = $state<RoleAssignment[]>([]);
	let formError = $state('');
	let formErrors = $state<{ username?: string; password?: string; passwordRepeat?: string }>({});
	let formSaving = $state(false);
	let mfaDisabling = $state(false);

	function resetForm() {
		formUsername = '';
		formEmail = '';
		formDisplayName = '';
		formPassword = '';
		formPasswordRepeat = '';
		formRoleAssignments = [];
		formError = '';
		formErrors = {};
		formSaving = false;
		mfaDisabling = false;
	}

	async function handleMfaToggle() {
		if (!user || !user.mfaEnabled) return;
		mfaDisabling = true;
		try {
			const response = await fetch(`/api/users/${user.id}/mfa`, {
				method: 'DELETE'
			});
			if (response.ok) {
				toast.success(m.settings_users_mfa_disabled_success());
				user.mfaEnabled = false;
			} else {
				const data = await response.json();
				toast.error(data.error || m.settings_users_error_mfa_disable_failed());
			}
		} catch {
			toast.error(m.settings_users_error_mfa_disable_failed());
		} finally {
			mfaDisabling = false;
		}
	}

	// Initialize form when user changes or modal opens
	$effect(() => {
		if (open) {
			if (user) {
				formUsername = user.username;
				formEmail = user.email || '';
				formDisplayName = user.displayName || '';
				formPassword = '';
				formPasswordRepeat = '';
				formRoleAssignments = [];
				formError = '';
				formErrors = {};
				formSaving = false;
				// Fetch user's current roles
				fetchUserRoles(user.id);
			} else {
				resetForm();
			}
		}
	});

	async function fetchUserRoles(userId: number) {
		try {
			const response = await fetch(`/api/users/${userId}/roles`);
			if (response.ok) {
				const userRoles = await response.json();
				// Get unique role IDs (user just has roles assigned, env scope is on role)
				const uniqueRoleIds = [...new Set(userRoles.map((ur: any) => ur.roleId))];
				formRoleAssignments = uniqueRoleIds.map(roleId => ({ roleId: roleId as number }));
			}
		} catch (error) {
			console.error('Failed to fetch user roles:', error);
			toast.error(m.settings_users_error_fetch_roles_failed());
		}
	}

	async function syncUserRoles(userId: number) {
		try {
			// Get current assignments from server
			const currentResponse = await fetch(`/api/users/${userId}/roles`);
			if (!currentResponse.ok) return;
			const currentRoles = await currentResponse.json();
			const currentRoleIds = [...new Set(currentRoles.map((c: any) => c.roleId))];
			const targetRoleIds = formRoleAssignments.map(a => a.roleId);

			// Remove roles that are no longer assigned
			for (const roleId of currentRoleIds) {
				if (!targetRoleIds.includes(roleId as number)) {
					await fetch(`/api/users/${userId}/roles`, {
						method: 'DELETE',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ roleId })
					});
				}
			}

			// Add new role assignments
			for (const roleId of targetRoleIds) {
				if (!currentRoleIds.includes(roleId)) {
					await fetch(`/api/users/${userId}/roles`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ roleId })
					});
				}
			}
		} catch (error) {
			console.error('Failed to sync user roles:', error);
			toast.error(m.settings_users_error_sync_roles_failed());
		}
	}

	function toggleRole(roleId: number, checked: boolean, _isSystem: boolean) {
		if (checked) {
			formRoleAssignments = [...formRoleAssignments, { roleId }];
		} else {
			formRoleAssignments = formRoleAssignments.filter(a => a.roleId !== roleId);
		}
	}

	async function createUser() {
		formErrors = {};
		let hasErrors = false;

		if (!formUsername.trim()) {
			formErrors.username = m.settings_users_error_username_required();
			hasErrors = true;
		}

		if (!formPassword.trim()) {
			formErrors.password = m.settings_users_error_password_required();
			hasErrors = true;
		}

		if (formPassword !== formPasswordRepeat) {
			formErrors.passwordRepeat = m.profile_password_error_mismatch();
			hasErrors = true;
		}

		if (hasErrors) return;

		formSaving = true;
		formError = '';

		try {
			const response = await fetch('/api/users', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					username: formUsername.trim(),
					email: formEmail.trim() || undefined,
					displayName: formDisplayName.trim() || undefined,
					password: formPassword
				})
			});

			if (response.ok) {
				const data = await response.json();

				// Sync roles for the new user (Enterprise mode)
				if (data.id && isEnterprise) {
					await syncUserRoles(data.id);
				}

				open = false;
				onSaved();
				toast.success(m.settings_users_created());
			} else {
				const data = await response.json();
				formError = data.details ? `${data.error}: ${data.details}` : (data.error || m.settings_users_error_create_failed());
				toast.error(formError);
			}
		} catch {
			formError = m.settings_users_error_create_failed();
			toast.error(m.settings_users_error_create_failed());
		} finally {
			formSaving = false;
		}
	}

	async function updateUser() {
		formErrors = {};
		let hasErrors = false;

		if (!user || !formUsername.trim()) {
			formErrors.username = m.settings_users_error_username_required();
			hasErrors = true;
		}

		if (formPassword.trim() && formPassword !== formPasswordRepeat) {
			formErrors.passwordRepeat = m.profile_password_error_mismatch();
			hasErrors = true;
		}

		if (hasErrors) return;

		formSaving = true;
		formError = '';

		try {
			const body: any = {
				username: formUsername.trim(),
				email: formEmail.trim() || null,
				displayName: formDisplayName.trim() || null
			};
			if (formPassword.trim()) {
				body.password = formPassword;
			}

			const response = await fetch(`/api/users/${user!.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			if (response.ok) {
				await syncUserRoles(user!.id);
				open = false;
				onSaved();
				toast.success(m.settings_users_updated());
			} else {
				const data = await response.json();
				formError = data.error || m.settings_users_error_update_failed();
				toast.error(formError);
			}
		} catch {
			formError = m.settings_users_error_update_failed();
			toast.error(m.settings_users_error_update_failed());
		} finally {
			formSaving = false;
		}
	}

	function handleClose() {
		open = false;
		onClose();
	}

	// Get icon component for a role based on its name
	function getRoleIcon(roleName: string): typeof Crown {
		const name = roleName.toLowerCase();
		if (name.includes('admin')) return Crown;
		if (name.includes('operator')) return Wrench;
		if (name.includes('viewer') || name.includes('view') || name.includes('read')) return Eye;
		return Tag;
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		if (isEditing) {
			updateUser();
		} else {
			createUser();
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) { formError = ''; formErrors = {}; focusFirstInput(); } }}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				{#if isEditing}
					<Pencil class="w-5 h-5" />
					{m.settings_users_edit_user()}
				{:else}
					<UserPlus class="w-5 h-5" />
					{m.settings_users_add_user()}
				{/if}
			</Dialog.Title>
		</Dialog.Header>
		<form onsubmit={handleSubmit}>
		<div class="space-y-5">
			{#if formError}
				<Alert.Root variant="destructive">
					<TriangleAlert class="h-4 w-4" />
					<Alert.Description>{formError}</Alert.Description>
				</Alert.Root>
			{/if}
			{#if user?.isSso}
				<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
					<ShieldCheck class="w-4 h-4 text-yellow-600 flex-shrink-0" />
					<p class="text-sm text-yellow-700 dark:text-yellow-500">
						{m.settings_users_sso_notice()}
					</p>
				</div>
			{/if}

			<!-- User Details Section -->
			<div class="space-y-4">
				<h3 class="text-sm font-medium flex items-center gap-2 text-muted-foreground">
					<User class="w-4 h-4" />
					{m.settings_users_details_title()}
				</h3>
				<div class="grid grid-cols-2 gap-4">
					<div class="space-y-2">
						<Label>{m.login_username_label()} {#if !isEditing}<span class="text-destructive">*</span>{/if}</Label>
						<Input
							bind:value={formUsername}
							placeholder={isEditing ? 'admin' : 'johndoe'}
							autocomplete="off"
							disabled={user?.isSso}
							class="{user?.isSso ? 'opacity-60' : ''} {formErrors.username ? 'border-destructive focus-visible:ring-destructive' : ''}"
							oninput={() => formErrors.username = undefined}
						/>
						{#if formErrors.username}
							<p class="text-xs text-destructive">{formErrors.username}</p>
						{/if}
					</div>
					<div class="space-y-2">
						<Label>{m.profile_email_label()}</Label>
						<Input
							type="email"
							bind:value={formEmail}
							placeholder={isEditing ? 'admin@example.com' : 'john@example.com'}
							disabled={user?.isSso}
							class={user?.isSso ? 'opacity-60' : ''}
						/>
					</div>
				</div>
				<div class="space-y-2">
					<Label>{m.profile_display_name_label()}</Label>
					<Input
						bind:value={formDisplayName}
						placeholder={isEditing ? 'Administrator' : 'John Doe'}
						disabled={user?.isSso}
						class={user?.isSso ? 'opacity-60' : ''}
					/>
				</div>
			</div>

			<!-- Password Section -->
			{#if !user?.isSso}
				<div class="space-y-4">
					<h3 class="text-sm font-medium flex items-center gap-2 text-muted-foreground">
						<KeyRound class="w-4 h-4" />
						{m.login_password_label()}
					</h3>
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-2">
							{#if isEditing}
								<Label>{m.profile_password_new_label()} <span class="text-muted-foreground text-xs">{m.settings_users_password_keep_hint()}</span></Label>
							{:else}
								<Label>{m.login_password_label()} <span class="text-destructive">*</span></Label>
							{/if}
							<Input
								type="password"
								bind:value={formPassword}
								placeholder={isEditing ? m.profile_password_new_placeholder() : m.settings_users_password_placeholder()}
								autocomplete="new-password"
								class={formErrors.password ? 'border-destructive focus-visible:ring-destructive' : ''}
								oninput={() => formErrors.password = undefined}
							/>
							<PasswordStrengthIndicator password={formPassword} />
							{#if formErrors.password}
								<p class="text-xs text-destructive">{formErrors.password}</p>
							{/if}
						</div>
						<div class="space-y-2">
							{#if isEditing}
								<Label>{m.settings_users_confirm_password_label()}</Label>
							{:else}
								<Label>{m.settings_users_confirm_password_label()} <span class="text-destructive">*</span></Label>
							{/if}
							<Input
								type="password"
								bind:value={formPasswordRepeat}
								placeholder={isEditing ? m.profile_password_repeat_placeholder() : m.settings_users_password_repeat_placeholder()}
								autocomplete="new-password"
								class={formErrors.passwordRepeat ? 'border-destructive focus-visible:ring-destructive' : ''}
								oninput={() => formErrors.passwordRepeat = undefined}
							/>
							{#if formErrors.passwordRepeat}
								<p class="text-xs text-destructive">{formErrors.passwordRepeat}</p>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			<!-- MFA Section (Enterprise only, editing existing user with MFA enabled) -->
			{#if isEnterprise && isEditing && user && !user.isSso}
				<div class="space-y-3">
					<h3 class="text-sm font-medium flex items-center gap-2 text-muted-foreground">
						<Smartphone class="w-4 h-4" />
						{m.profile_mfa_title()}
					</h3>
					<div class="flex items-center justify-between p-3 border rounded-lg">
						<div>
							<p class="text-sm font-medium">{m.settings_users_mfa_status()}</p>
							<p class="text-xs text-muted-foreground">
								{#if user.mfaEnabled}
									{m.settings_users_mfa_configured()}
								{:else}
									{m.settings_users_mfa_not_configured()}
								{/if}
							</p>
						</div>
						<TogglePill
							checked={user.mfaEnabled}
							disabled={!user.mfaEnabled || mfaDisabling}
							onchange={handleMfaToggle}
						/>
					</div>
				</div>
			{/if}

			<!-- Role Assignment Section -->
			{#if isEnterprise}
				{@const systemRoles = roles.filter(r => r.isSystem)}
				{@const customRoles = roles.filter(r => !r.isSystem)}
				<div class="space-y-3">
					<div>
						<Label class="text-sm">{m.settings_users_roles()}</Label>
						<p class="text-xs text-muted-foreground">{m.settings_users_roles_hint()}</p>
					</div>

					<div class="border rounded-lg divide-y max-h-[240px] overflow-y-auto">
						<!-- System Roles -->
						{#if systemRoles.length > 0}
							<div class="p-3 bg-muted/30">
								<p class="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
									<Shield class="w-3.5 h-3.5" />
									{m.settings_users_system_roles()}
								</p>
								<div class="grid grid-cols-3 gap-2">
									{#each systemRoles as role}
										{@const isAssigned = formRoleAssignments.some(a => a.roleId === role.id)}
										{@const RoleIcon = getRoleIcon(role.name)}
										<button
											type="button"
											class="flex items-center gap-2 px-3 py-2 rounded-md text-sm border transition-all {isAssigned ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'bg-background hover:bg-muted border-border'}"
											onclick={() => toggleRole(role.id, !isAssigned, role.isSystem)}
										>
											{#if isAssigned}
												<Check class="w-4 h-4 flex-shrink-0" />
											{:else}
												<RoleIcon class="w-4 h-4 flex-shrink-0 opacity-50" />
											{/if}
											<span class="truncate">{role.name}</span>
										</button>
									{/each}
								</div>
							</div>
						{/if}

						<!-- Custom Roles -->
						{#if customRoles.length > 0}
							<div class="p-3">
								<p class="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
									<Globe class="w-3.5 h-3.5" />
									{m.settings_users_custom_roles()}
								</p>
								<div class="grid grid-cols-2 gap-2">
									{#each customRoles as role}
										{@const isAssigned = formRoleAssignments.some(a => a.roleId === role.id)}
										{@const envCount = role.environmentIds?.length ?? 0}
										{@const isGlobal = role.environmentIds === null}
										{@const RoleIcon = getRoleIcon(role.name)}
										<button
											type="button"
											class="flex items-center gap-2 px-3 py-2 rounded-md text-sm border transition-all text-left {isAssigned ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'bg-background hover:bg-muted border-border'}"
											onclick={() => toggleRole(role.id, !isAssigned, role.isSystem)}
										>
											{#if isAssigned}
												<Check class="w-4 h-4 flex-shrink-0" />
											{:else}
												<RoleIcon class="w-4 h-4 flex-shrink-0 opacity-50" />
											{/if}
											<div class="flex-1 min-w-0">
												<span class="truncate block">{role.name}</span>
												<span class="text-2xs opacity-70 flex items-center gap-1">
													{#if isGlobal}
														<Globe class="w-2.5 h-2.5" />
														{m.settings_users_all_environments()}
													{:else}
														{m.settings_users_environments_count({ count: envCount })}
													{/if}
												</span>
											</div>
										</button>
									{/each}
								</div>
							</div>
						{/if}

						{#if roles.length === 0}
							<div class="p-4 text-center text-sm text-muted-foreground">
								{m.settings_users_no_roles()}
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<div class="space-y-1">
					<p class="text-xs text-muted-foreground">
						{m.settings_users_full_access_notice()}
					</p>
					<p class="text-xs text-muted-foreground flex items-center gap-1">
						<Crown class="w-3 h-3 text-amber-500" />
						{m.settings_users_enterprise_rbac_hint()}
					</p>
				</div>
			{/if}
		</div>
		<Dialog.Footer class="mt-4">
			{#if isEditing}
				<Button variant="outline" type="button" onclick={handleClose}>{m.settings_users_cancel()}</Button>
				<Button type="submit" disabled={formSaving}>
					{#if formSaving}
						<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
					{:else}
						<Check class="w-4 h-4" />
					{/if}
					{m.settings_users_save()}
				</Button>
			{:else}
				<Button variant="outline" type="button" onclick={handleClose}>{m.settings_users_cancel()}</Button>
				<Button type="submit" disabled={formSaving}>
					{#if formSaving}
						<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
					{:else}
						<UserPlus class="w-4 h-4" />
					{/if}
					{m.settings_users_create_user()}
				</Button>
			{/if}
		</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
