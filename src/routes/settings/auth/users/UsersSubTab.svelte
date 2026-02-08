<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import {
		Users,
		User,
		Pencil,
		Trash2,
		RefreshCw,
		Shield,
		ShieldCheck,
		UserPlus,
		AlertTriangle,
		Crown,
		Wrench,
		Eye,
		Tag,
		KeyRound,
		Network,
		Search,
		ArrowUpDown,
		ArrowUp,
		ArrowDown
	} from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { EmptyState } from '$lib/components/ui/empty-state';
	import { canAccess } from '$lib/stores/auth';
	import { licenseStore } from '$lib/stores/license';
	import UserModal from './UserModal.svelte';

	const MAX_VISIBLE_ROLES = 5;

	// Search and sort state
	type SortField = 'username' | 'email' | 'provider';
	type SortDirection = 'asc' | 'desc';
	let searchQuery = $state('');
	let sortField = $state<SortField>('username');
	let sortDirection = $state<SortDirection>('asc');

	interface UserRole {
		id: number;
		name: string;
		environmentId?: number | null;
	}

	interface LocalUser {
		id: number;
		username: string;
		email?: string;
		displayName?: string;
		mfaEnabled: boolean;
		isAdmin: boolean;
		isActive: boolean;
		isSso: boolean;
		authProvider?: string;
		lastLogin?: string;
		createdAt: string;
		roles?: UserRole[];
	}

	interface Role {
		id: number;
		name: string;
		description?: string;
		isSystem: boolean;
		permissions: any;
		createdAt: string;
	}

	interface Props {
		roles: Role[];
	}

	let { roles }: Props = $props();

	// Local users state
	let localUsers = $state<LocalUser[]>([]);
	let usersLoading = $state(true);
	let showUserModal = $state(false);
	let editingUser = $state<LocalUser | null>(null);
	let confirmDeleteUserId = $state<number | null>(null);
	let showLastAdminWarning = $state(false);
	let lastAdminDeleteUserId = $state<number | null>(null);

	async function fetchUsers() {
		usersLoading = true;
		try {
			const response = await fetch('/api/users');
			if (response.ok) {
				localUsers = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch users:', error);
			toast.error('Failed to fetch users');
		} finally {
			usersLoading = false;
		}
	}

	function openUserModal(user: LocalUser | null) {
		editingUser = user;
		showUserModal = true;
	}

	function handleUserModalClose() {
		showUserModal = false;
		editingUser = null;
	}

	async function handleUserModalSaved() {
		showUserModal = false;
		editingUser = null;
		await fetchUsers();
	}

	async function deleteLocalUser(userId: number, confirmDisableAuth = false) {
		try {
			const url = confirmDisableAuth
				? `/api/users/${userId}?confirmDisableAuth=true`
				: `/api/users/${userId}`;
			const response = await fetch(url, { method: 'DELETE' });

			if (response.ok) {
				const data = await response.json();
				await fetchUsers();
				if (data.authDisabled) {
					toast.success('User deleted. Authentication has been disabled.');
				} else {
					toast.success('User deleted');
				}
				showLastAdminWarning = false;
				lastAdminDeleteUserId = null;
			} else if (response.status === 409) {
				// Check if this is the last admin warning
				const data = await response.json();
				if (data.isLastAdmin) {
					// Show last admin warning dialog
					lastAdminDeleteUserId = userId;
					showLastAdminWarning = true;
				} else {
					toast.error(data.error || 'Failed to delete user');
				}
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to delete user');
			}
		} catch (error) {
			console.error('Failed to delete user:', error);
			toast.error('Failed to delete user');
		} finally {
			confirmDeleteUserId = null;
		}
	}

	function confirmLastAdminDelete() {
		if (lastAdminDeleteUserId) {
			deleteLocalUser(lastAdminDeleteUserId, true);
		}
	}

	function cancelLastAdminDelete() {
		showLastAdminWarning = false;
		lastAdminDeleteUserId = null;
	}

	// Get icon component for a role based on its name
	function getRoleIcon(roleName: string): typeof Crown {
		const name = roleName.toLowerCase();
		if (name.includes('admin')) return Crown;
		if (name.includes('operator')) return Wrench;
		if (name.includes('viewer') || name.includes('view') || name.includes('read')) return Eye;
		return Tag;
	}

	// Get provider display info
	function getProviderInfo(user: LocalUser): { icon: typeof KeyRound; label: string; class: string; sortKey: string } {
		if (!user.isSso) {
			return { icon: KeyRound, label: 'Local', class: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30', sortKey: 'local' };
		}
		const providerParts = user.authProvider?.split(':') || [];
		const providerType = providerParts[0]?.toLowerCase() || 'sso';
		const providerName = providerParts[1] || '';

		if (providerType === 'ldap') {
			return { icon: Network, label: providerName || 'LDAP', class: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30', sortKey: 'ldap' };
		}
		return { icon: ShieldCheck, label: providerName || 'OIDC', class: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30', sortKey: 'oidc' };
	}

	// Filter and sort users
	const filteredAndSortedUsers = $derived.by(() => {
		let result = localUsers;

		// Filter by search query
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			result = result.filter(user =>
				user.username.toLowerCase().includes(query) ||
				(user.email?.toLowerCase().includes(query)) ||
				(user.displayName?.toLowerCase().includes(query)) ||
				(user.roles?.some(r => r.name.toLowerCase().includes(query)))
			);
		}

		// Sort
		result = [...result].sort((a, b) => {
			let aVal: string, bVal: string;
			switch (sortField) {
				case 'username':
					aVal = a.username.toLowerCase();
					bVal = b.username.toLowerCase();
					break;
				case 'email':
					aVal = (a.email || '').toLowerCase();
					bVal = (b.email || '').toLowerCase();
					break;
				case 'provider':
					aVal = getProviderInfo(a).sortKey;
					bVal = getProviderInfo(b).sortKey;
					break;
				default:
					aVal = a.username.toLowerCase();
					bVal = b.username.toLowerCase();
			}
			const cmp = aVal.localeCompare(bVal);
			return sortDirection === 'asc' ? cmp : -cmp;
		});

		return result;
	});

	function toggleSort(field: SortField) {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = 'asc';
		}
	}

	onMount(() => {
		fetchUsers();
	});
</script>

<div class="flex flex-col flex-1 min-h-0">
	<Card.Root class="flex flex-col flex-1 min-h-0">
		<Card.Header class="flex-shrink-0 py-3">
			<div class="flex items-center justify-between">
				<div>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Users class="w-4 h-4" />
						Users
					</Card.Title>
					<p class="text-xs text-muted-foreground mt-1">Manage user accounts for local authentication, SSO, and LDAP.</p>
				</div>
				{#if $canAccess('users', 'create')}
					<Button size="sm" onclick={() => openUserModal(null)}>
						<UserPlus class="w-4 h-4" />
						Add user
					</Button>
				{/if}
			</div>
		</Card.Header>
		<Card.Content class="flex-1 flex flex-col min-h-0">
			{#if usersLoading}
				<div class="flex items-center justify-center py-4">
					<RefreshCw class="w-6 h-6 animate-spin text-muted-foreground" />
				</div>
			{:else if localUsers.length === 0}
				<EmptyState
					icon={Users}
					title="No users configured"
					description="Create the first user to enable login"
				/>
			{:else}
				<!-- Filter bar -->
				<div class="flex items-center gap-2 mb-3">
					<div class="relative flex-1 max-w-xs">
						<Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
						<Input
							type="text"
							placeholder="Search users..."
							bind:value={searchQuery}
							class="pl-8 h-8 text-sm"
						/>
					</div>
					<div class="flex items-center gap-1 text-xs text-muted-foreground ml-auto">
						<span>{filteredAndSortedUsers.length} of {localUsers.length} users</span>
					</div>
				</div>
				<!-- Table -->
				<div class="flex-1 min-h-0 overflow-auto rounded-lg border">
					<table class="w-full text-sm">
						<thead class="bg-muted sticky top-0 z-10">
							<tr class="border-b">
								<th class="text-left py-1.5 px-3 font-medium w-[25%]">
									<button
										type="button"
										class="flex items-center gap-1 hover:text-foreground transition-colors"
										onclick={() => toggleSort('username')}
									>
										User
										{#if sortField === 'username'}
											{#if sortDirection === 'asc'}<ArrowUp class="w-3 h-3" />{:else}<ArrowDown class="w-3 h-3" />{/if}
										{:else}
											<ArrowUpDown class="w-3 h-3 opacity-30" />
										{/if}
									</button>
								</th>
								<th class="text-left py-1.5 px-3 font-medium w-[25%]">
									<button
										type="button"
										class="flex items-center gap-1 hover:text-foreground transition-colors"
										onclick={() => toggleSort('email')}
									>
										Email
										{#if sortField === 'email'}
											{#if sortDirection === 'asc'}<ArrowUp class="w-3 h-3" />{:else}<ArrowDown class="w-3 h-3" />{/if}
										{:else}
											<ArrowUpDown class="w-3 h-3 opacity-30" />
										{/if}
									</button>
								</th>
								<th class="text-left py-1.5 px-3 font-medium w-[8%]">MFA</th>
								{#if $licenseStore.isEnterprise}
									<th class="text-left py-1.5 px-3 font-medium w-[25%]">Roles</th>
								{/if}
								<th class="text-left py-1.5 px-3 font-medium w-[15%]">
									<button
										type="button"
										class="flex items-center gap-1 hover:text-foreground transition-colors"
										onclick={() => toggleSort('provider')}
									>
										Provider
										{#if sortField === 'provider'}
											{#if sortDirection === 'asc'}<ArrowUp class="w-3 h-3" />{:else}<ArrowDown class="w-3 h-3" />{/if}
										{:else}
											<ArrowUpDown class="w-3 h-3 opacity-30" />
										{/if}
									</button>
								</th>
								<th class="text-right py-1.5 px-3 font-medium w-[10%]"></th>
							</tr>
						</thead>
						<tbody>
							{#each filteredAndSortedUsers as user}
								{@const provider = getProviderInfo(user)}
								{@const ProviderIcon = provider.icon}
								{@const visibleRoles = user.roles?.slice(0, MAX_VISIBLE_ROLES) || []}
								{@const hiddenRolesCount = (user.roles?.length || 0) - MAX_VISIBLE_ROLES}
								<tr class="border-b border-muted hover:bg-muted/30 transition-colors">
									<!-- User -->
									<td class="py-2 px-3">
										<div class="flex items-center gap-2">
											<div class="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
												<User class="w-3 h-3 text-primary" />
											</div>
											<div class="flex items-center gap-1.5">
												<span class="font-medium">{user.username}</span>
												{#if !user.isActive}
													<Badge variant="destructive" class="text-2xs px-1 py-0 h-4">Disabled</Badge>
												{/if}
											</div>
										</div>
									</td>
									<!-- Email -->
									<td class="py-2 px-3">
										<span class="text-muted-foreground truncate block">{user.email || '—'}</span>
									</td>
									<!-- MFA -->
									<td class="py-2 px-3">
										{#if user.mfaEnabled}
											<Badge variant="outline" class="text-2xs px-1.5 py-0 h-4 gap-1 rounded-sm bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30">
												<Shield class="w-2.5 h-2.5" />
												Enabled
											</Badge>
										{:else}
											<span class="text-muted-foreground">—</span>
										{/if}
									</td>
									<!-- Roles (Enterprise only) -->
									{#if $licenseStore.isEnterprise}
										<td class="py-2 px-3">
											{#if user.roles && user.roles.length > 0}
												<div class="flex items-center gap-1 flex-wrap">
													{#each visibleRoles as role}
														{@const RoleIcon = getRoleIcon(role.name)}
														<Badge variant="outline" class="text-2xs px-1.5 py-0 h-4 gap-1 rounded-sm bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30">
															<RoleIcon class="w-2.5 h-2.5" />
															{role.name}
														</Badge>
													{/each}
													{#if hiddenRolesCount > 0}
														<span class="text-2xs text-muted-foreground">+{hiddenRolesCount} more</span>
													{/if}
												</div>
											{:else}
												<span class="text-muted-foreground">—</span>
											{/if}
										</td>
									{/if}
									<!-- Provider -->
									<td class="py-2 px-3">
										<Badge variant="outline" class="text-2xs px-1.5 py-0 h-4 gap-1 rounded-sm {provider.class}">
											<ProviderIcon class="w-2.5 h-2.5" />
											{provider.label}
										</Badge>
									</td>
									<!-- Actions -->
									<td class="py-2 px-3 text-right">
										<div class="flex items-center justify-end gap-1">
											{#if $canAccess('users', 'edit')}
												<Button
													variant="ghost"
													size="sm"
													class="h-7 w-7 p-0"
													onclick={() => openUserModal(user)}
												>
													<Pencil class="w-3.5 h-3.5" />
												</Button>
											{/if}
											{#if $canAccess('users', 'delete')}
												<ConfirmPopover
													open={confirmDeleteUserId === user.id}
													action="Delete"
													itemType="user"
													itemName={user.username}
													onConfirm={() => deleteLocalUser(user.id)}
													onOpenChange={(open) => { if (!open) confirmDeleteUserId = null; else confirmDeleteUserId = user.id; }}
												>
													<span class="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-accent hover:text-accent-foreground">
														<Trash2 class="w-3.5 h-3.5 text-destructive" />
													</span>
												</ConfirmPopover>
											{/if}
										</div>
									</td>
								</tr>
							{:else}
								<tr>
									<td colspan={$licenseStore.isEnterprise ? 6 : 5} class="py-8 text-center text-muted-foreground">
										<Search class="w-8 h-8 mx-auto mb-2 opacity-50" />
										<p>No users found matching "{searchQuery}"</p>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<UserModal
	bind:open={showUserModal}
	user={editingUser}
	{roles}
	isEnterprise={$licenseStore.isEnterprise}
	onClose={handleUserModalClose}
	onSaved={handleUserModalSaved}
/>

<!-- Last Admin Warning Dialog -->
<Dialog.Root bind:open={showLastAdminWarning}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2 text-destructive">
				<AlertTriangle class="w-5 h-5" />
				Delete last admin?
			</Dialog.Title>
			<Dialog.Description class="text-left">
				This is the only admin account. Deleting it will <strong>disable authentication</strong> and allow anyone to access Dockhand without logging in.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={cancelLastAdminDelete}>Cancel</Button>
			<Button variant="destructive" onclick={confirmLastAdminDelete}>
				<Trash2 class="w-4 h-4" />
				Delete and disable auth
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
