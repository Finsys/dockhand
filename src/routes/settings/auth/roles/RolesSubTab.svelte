<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Shield,
		Plus,
		Pencil,
		Trash2,
		RefreshCw,
		Crown,
		Key,
		Box,
		Image,
		HardDrive,
		Cable,
		Layers,
		Globe,
		Download,
		Bell,
		Sliders,
		Settings,
		Users,
		Eye,
		SquarePlus,
		Play,
		Square,
		RotateCcw,
		Terminal,
		ScrollText,
		Search,
		Upload,
		Hammer,
		Send,
		Zap,
		PlugZap,
		Unplug,
		Copy,
		GitBranch,
		KeyRound,
		Container,
		ClipboardList,
		Timer
	} from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { licenseStore } from '$lib/stores/license';
	import RoleModal from './RoleModal.svelte';
	import { getIconComponent } from '$lib/utils/icons';

	interface Role {
		id: number;
		name: string;
		description?: string;
		isSystem: boolean;
		permissions: any;
		environmentIds?: number[] | null;
		createdAt: string;
	}

	interface Environment {
		id: number;
		name: string;
		icon?: string;
	}

	interface Props {
		onTabChange?: (tab: string) => void;
	}

	let { onTabChange = () => {} }: Props = $props();

	// Roles state
	let roles = $state<Role[]>([]);
	let environments = $state<Environment[]>([]);
	let rolesLoading = $state(true);
	let showRoleModal = $state(false);
	let editingRole = $state<Role | null>(null);
	let copyingRole = $state<Role | null>(null);
	let confirmDeleteRoleId = $state<number | null>(null);

	// Permission definitions
	const categoryIcons: Record<string, typeof Box> = {
		containers: Box,
		images: Image,
		volumes: HardDrive,
		networks: Cable,
		stacks: Layers,
		environments: Globe,
		registries: Download,
		notifications: Bell,
		configsets: Sliders,
		settings: Settings,
		users: Users,
		git: GitBranch,
		license: KeyRound,
		audit_logs: ClipboardList,
		schedules: Timer
	};

	const categoryColors: Record<string, string> = {
		containers: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30',
		images: 'bg-purple-500/15 text-purple-700 dark:text-purple-400 border-purple-500/30',
		volumes: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
		networks: 'bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30',
		stacks: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 border-cyan-500/30',
		environments: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30',
		registries: 'bg-pink-500/15 text-pink-700 dark:text-pink-400 border-pink-500/30',
		notifications: 'bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30',
		configsets: 'bg-teal-500/15 text-teal-700 dark:text-teal-400 border-teal-500/30',
		settings: 'bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/30',
		users: 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30',
		git: 'bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30',
		license: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30',
		audit_logs: 'bg-stone-500/15 text-stone-700 dark:text-stone-400 border-stone-500/30',
		schedules: 'bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30'
	};

	const permissionIcons: Record<string, typeof Eye> = {
		view: Eye,
		create: SquarePlus,
		start: Play,
		stop: Square,
		restart: RotateCcw,
		remove: Trash2,
		delete: Trash2,
		exec: Terminal,
		logs: ScrollText,
		inspect: Search,
		pull: Download,
		push: Upload,
		build: Hammer,
		edit: Pencil,
		manage: Settings,
		send: Send,
		test: Zap,
		connect: PlugZap,
		disconnect: Unplug,
		activate: KeyRound
	};

	// Define which categories are system-wide vs environment-specific
	const systemCategories = ['users', 'settings', 'environments', 'registries', 'notifications', 'configsets', 'git', 'license', 'audit_logs', 'schedules'];
	const envCategories = ['containers', 'images', 'volumes', 'networks', 'stacks'];

	function getRolePermissionPills(permissions: any): { system: Array<{ category: string; perms: string[] }>; env: Array<{ category: string; perms: string[] }> } {
		if (!permissions || typeof permissions !== 'object') return { system: [], env: [] };

		const all = Object.entries(permissions)
			.filter(([_, perms]) => Array.isArray(perms) && perms.length > 0)
			.map(([category, perms]) => ({ category, perms: perms as string[] }));

		return {
			system: all.filter(p => systemCategories.includes(p.category)),
			env: all.filter(p => envCategories.includes(p.category))
		};
	}

	async function fetchRoles() {
		rolesLoading = true;
		try {
			const response = await fetch('/api/roles');
			if (response.ok) {
				roles = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch roles:', error);
			toast.error('Failed to fetch roles');
		} finally {
			rolesLoading = false;
		}
	}

	async function fetchEnvironments() {
		try {
			const response = await fetch('/api/environments');
			if (response.ok) {
				environments = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch environments:', error);
		}
	}

	async function openRoleModal(role: Role | null) {
		await fetchEnvironments(); // Re-fetch to get any newly added environments
		editingRole = role;
		copyingRole = null;
		showRoleModal = true;
	}

	async function copyRole(role: Role) {
		await fetchEnvironments(); // Re-fetch to get any newly added environments
		editingRole = null;
		copyingRole = role;
		showRoleModal = true;
	}

	function handleRoleModalClose() {
		showRoleModal = false;
		editingRole = null;
		copyingRole = null;
	}

	async function handleRoleModalSaved() {
		showRoleModal = false;
		editingRole = null;
		copyingRole = null;
		await fetchRoles();
	}

	async function deleteRole(roleId: number) {
		try {
			const response = await fetch(`/api/roles/${roleId}`, { method: 'DELETE' });
			if (response.ok) {
				await fetchRoles();
				toast.success('Role deleted');
			} else {
				toast.error('Failed to delete role');
			}
		} catch (error) {
			console.error('Failed to delete role:', error);
			toast.error('Failed to delete role');
		} finally {
			confirmDeleteRoleId = null;
		}
	}

	// Fetch data when license is confirmed as enterprise
	let hasFetched = $state(false);
	$effect(() => {
		if ($licenseStore.isEnterprise && !$licenseStore.loading && !hasFetched) {
			hasFetched = true;
			fetchRoles();
			fetchEnvironments();
		}
	});
</script>

{#if $licenseStore.loading}
	<Card.Root>
		<Card.Content class="py-12">
			<div class="flex justify-center">
				<RefreshCw class="w-6 h-6 animate-spin text-muted-foreground" />
			</div>
		</Card.Content>
	</Card.Root>
{:else if !$licenseStore.isEnterprise}
	<Card.Root>
		<Card.Content class="py-12">
			<div class="text-center">
				<h3 class="text-lg font-medium mb-2 flex items-center justify-center gap-2">
					<Crown class="w-5 h-5 text-amber-500" />
					Enterprise feature
				</h3>
				<p class="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
					Role-based access control (RBAC) is available with an enterprise license. Define custom
					roles with granular permissions and assign them to users.
				</p>
				<Button onclick={() => onTabChange('license')}>
					<Key class="w-4 h-4" />
					Activate license
				</Button>
			</div>
		</Card.Content>
	</Card.Root>
{:else}
	<div class="space-y-4">
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<div>
						<Card.Title class="text-sm font-medium flex items-center gap-2">
							<Shield class="w-4 h-4" />
							Roles
						</Card.Title>
						<p class="text-xs text-muted-foreground mt-1">
							Define roles with granular permissions and assign them to users for access control.
						</p>
					</div>
					{#if $canAccess('settings', 'edit')}
						<Button size="sm" onclick={() => openRoleModal(null)}>
							<Plus class="w-4 h-4" />
							Add role
						</Button>
					{/if}
				</div>
			</Card.Header>
			<Card.Content>
				{#if rolesLoading}
					<div class="flex items-center justify-center py-4">
						<RefreshCw class="w-6 h-6 animate-spin text-muted-foreground" />
					</div>
				{:else if roles.length === 0}
					<div class="text-center py-8 text-sm text-muted-foreground">
						<Shield class="w-8 h-8 mx-auto mb-2 opacity-50" />
						<p>No roles configured</p>
						<p class="text-xs">Create a role to define custom permissions</p>
					</div>
				{:else}
					<div class="space-y-2 max-h-96 overflow-y-auto">
						{#each roles as role}
							{@const pills = getRolePermissionPills(role.permissions)}
							<div class="flex items-center justify-between p-3 border rounded-md gap-4">
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 mb-1">
										<span class="font-medium text-sm">{role.name}</span>
										{#if role.isSystem}
											<Badge variant="outline" class="text-xs">System</Badge>
										{/if}
									</div>
									{#if role.description}
										<p class="text-xs text-muted-foreground mb-2">{role.description}</p>
									{/if}
									<!-- Permission Pills - System -->
									{#if pills.system.length > 0}
										<div class="flex flex-wrap items-center gap-1 mb-1">
											<span class="text-2xs text-muted-foreground font-medium uppercase tracking-wide mr-1">System:</span>
											{#each pills.system as { category, perms }}
												{@const CategoryIcon = categoryIcons[category]}
												<span
													class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border {categoryColors[
														category
													] || 'bg-gray-500/15 text-gray-700 dark:text-gray-400 border-gray-500/30'}"
												>
													{#if CategoryIcon}
														<svelte:component this={CategoryIcon} class="w-3 h-3" />
													{/if}
													<span class="capitalize">{category}</span>
													<span class="inline-flex items-center gap-0.5 opacity-70">
														{#each perms as perm}
															{@const PermIcon = permissionIcons[perm]}
															{#if PermIcon}
																<span title={perm}>
																	<svelte:component this={PermIcon} class="w-2.5 h-2.5" />
																</span>
															{/if}
														{/each}
													</span>
												</span>
											{/each}
										</div>
									{/if}
									<!-- Permission Pills - Environment -->
									{#if pills.env.length > 0}
										<div class="flex flex-wrap items-center gap-1">
											<span class="text-2xs text-muted-foreground font-medium uppercase tracking-wide mr-1">Env</span>
											{#if role.environmentIds === null || role.environmentIds === undefined}
												<Badge variant="secondary" class="text-2xs gap-0.5 px-1 py-0 h-4">
													<Globe class="w-2.5 h-2.5" />
													All
												</Badge>
											{:else if role.environmentIds.length > 0}
												{@const envs = role.environmentIds
													.map(id => environments.find(e => e.id === id))
													.filter(Boolean)}
												{#each envs as env}
													{@const EnvIcon = getIconComponent(env.icon || 'globe')}
													<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30">
														<EnvIcon class="w-3 h-3" />
														{env.name}
													</span>
												{/each}
											{/if}
											<span class="text-2xs text-muted-foreground mx-0.5">:</span>
											{#each pills.env as { category, perms }}
												{@const CategoryIcon = categoryIcons[category]}
												<span
													class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border {categoryColors[
														category
													] || 'bg-gray-500/15 text-gray-700 dark:text-gray-400 border-gray-500/30'}"
												>
													{#if CategoryIcon}
														<svelte:component this={CategoryIcon} class="w-3 h-3" />
													{/if}
													<span class="capitalize">{category}</span>
													<span class="inline-flex items-center gap-0.5 opacity-70">
														{#each perms as perm}
															{@const PermIcon = permissionIcons[perm]}
															{#if PermIcon}
																<span title={perm}>
																	<svelte:component this={PermIcon} class="w-2.5 h-2.5" />
																</span>
															{/if}
														{/each}
													</span>
												</span>
											{/each}
										</div>
									{/if}
								</div>
								{#if $canAccess('settings', 'edit')}
									<div class="flex items-center gap-1 flex-shrink-0">
										{#if role.isSystem}
											<!-- System roles: only Copy button -->
											<Button variant="ghost" size="sm" onclick={() => copyRole(role)} title="Copy as new role">
												<Copy class="w-4 h-4" />
											</Button>
										{:else}
											<!-- Custom roles: Copy, Edit and Delete -->
											<Button variant="ghost" size="sm" onclick={() => copyRole(role)} title="Copy as new role">
												<Copy class="w-4 h-4" />
											</Button>
											<Button variant="ghost" size="sm" onclick={() => openRoleModal(role)} title="Edit role">
												<Pencil class="w-4 h-4" />
											</Button>
											<ConfirmPopover
												open={confirmDeleteRoleId === role.id}
												action="Delete"
												itemType="role"
												itemName={role.name}
												title="Delete"
												onConfirm={() => deleteRole(role.id)}
												onOpenChange={(open) => (confirmDeleteRoleId = open ? role.id : null)}
											>
												{#snippet children({ open })}
													<Trash2
														class="w-4 h-4 {open
															? 'text-destructive'
															: 'text-muted-foreground hover:text-destructive'}"
													/>
												{/snippet}
											</ConfirmPopover>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{/if}

<RoleModal
	bind:open={showRoleModal}
	role={editingRole}
	copyFrom={copyingRole}
	{environments}
	onClose={handleRoleModalClose}
	onSaved={handleRoleModalSaved}
/>
