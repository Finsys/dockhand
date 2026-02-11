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
				toast.success('MFA disabled for user');
				user.mfaEnabled = false;
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to disable MFA');
			}
		} catch {
			toast.error('Failed to disable MFA');
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
			toast.error('Failed to fetch user roles');
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
			toast.error('Failed to sync user roles');
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
			formErrors.username = 'Username is required';
			hasErrors = true;
		}

		if (!formPassword.trim()) {
			formErrors.password = 'Password is required';
			hasErrors = true;
		}

		if (formPassword !== formPasswordRepeat) {
			formErrors.passwordRepeat = 'Passwords do not match';
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
				toast.success('User created');
			} else {
				const data = await response.json();
				formError = data.details ? `${data.error}: ${data.details}` : (data.error || 'Failed to create user');
				toast.error(formError);
			}
		} catch {
			formError = 'Failed to create user';
			toast.error('Failed to create user');
		} finally {
			formSaving = false;
		}
	}

	async function updateUser() {
		formErrors = {};
		let hasErrors = false;

		if (!user || !formUsername.trim()) {
			formErrors.username = 'Username is required';
			hasErrors = true;
		}

		if (formPassword.trim() && formPassword !== formPasswordRepeat) {
			formErrors.passwordRepeat = 'Passwords do not match';
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
				toast.success('User updated');
			} else {
				const data = await response.json();
				formError = data.error || 'Failed to update user';
				toast.error(formError);
			}
		} catch {
			formError = 'Failed to update user';
			toast.error('Failed to update user');
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
					Edit user
				{:else}
					<UserPlus class="w-5 h-5" />
					Add user
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
						SSO user - profile synced from identity provider
					</p>
				</div>
			{/if}

			<!-- User Details Section -->
			<div class="space-y-4">
				<h3 class="text-sm font-medium flex items-center gap-2 text-muted-foreground">
					<User class="w-4 h-4" />
					User details
				</h3>
				<div class="grid grid-cols-2 gap-4">
					<div class="space-y-2">
						<Label>Username {#if !isEditing}<span class="text-destructive">*</span>{/if}</Label>
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
						<Label>Email</Label>
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
					<Label>Display name</Label>
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
						Password
					</h3>
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-2">
							{#if isEditing}
								<Label>New password <span class="text-muted-foreground text-xs">(leave blank to keep current)</span></Label>
							{:else}
								<Label>Password <span class="text-destructive">*</span></Label>
							{/if}
							<Input
								type="password"
								bind:value={formPassword}
								placeholder={isEditing ? 'Enter new password' : 'Enter password'}
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
								<Label>Confirm password</Label>
							{:else}
								<Label>Confirm password <span class="text-destructive">*</span></Label>
							{/if}
							<Input
								type="password"
								bind:value={formPasswordRepeat}
								placeholder={isEditing ? 'Repeat new password' : 'Repeat password'}
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
						Two-factor authentication
					</h3>
					<div class="flex items-center justify-between p-3 border rounded-lg">
						<div>
							<p class="text-sm font-medium">MFA status</p>
							<p class="text-xs text-muted-foreground">
								{#if user.mfaEnabled}
									User has MFA configured
								{:else}
									User has not configured MFA
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
						<Label class="text-sm">Roles</Label>
						<p class="text-xs text-muted-foreground">Assign roles to this user. Environment scope is configured on the role itself.</p>
					</div>

					<div class="border rounded-lg divide-y max-h-[240px] overflow-y-auto">
						<!-- System Roles -->
						{#if systemRoles.length > 0}
							<div class="p-3 bg-muted/30">
								<p class="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
									<Shield class="w-3.5 h-3.5" />
									System roles
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
									Custom roles
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
														All environments
													{:else}
														{envCount} environment{envCount !== 1 ? 's' : ''}
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
								No roles defined yet
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<div class="space-y-1">
					<p class="text-xs text-muted-foreground">
						All users have full access to all environments.
					</p>
					<p class="text-xs text-muted-foreground flex items-center gap-1">
						<Crown class="w-3 h-3 text-amber-500" />
						Upgrade to Enterprise for role-based access control.
					</p>
				</div>
			{/if}
		</div>
		<Dialog.Footer class="mt-4">
			{#if isEditing}
				<Button variant="outline" type="button" onclick={handleClose}>Cancel</Button>
				<Button type="submit" disabled={formSaving}>
					{#if formSaving}
						<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
					{:else}
						<Check class="w-4 h-4" />
					{/if}
					Save
				</Button>
			{:else}
				<Button variant="outline" type="button" onclick={handleClose}>Cancel</Button>
				<Button type="submit" disabled={formSaving}>
					{#if formSaving}
						<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
					{:else}
						<UserPlus class="w-4 h-4" />
					{/if}
					Create user
				</Button>
			{/if}
		</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
