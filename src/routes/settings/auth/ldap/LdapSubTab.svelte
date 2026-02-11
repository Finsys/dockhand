<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import {
		Network,
		Plus,
		Pencil,
		Trash2,
		RefreshCw,
		Crown,
		Key
	} from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { licenseStore } from '$lib/stores/license';
	import LdapModal from './LdapModal.svelte';
	import { EmptyState } from '$lib/components/ui/empty-state';

	interface LdapRoleMapping {
		groupDn: string;
		roleId: number;
	}

	interface LdapConfig {
		id: number;
		name: string;
		enabled: boolean;
		serverUrl: string;
		bindDn?: string;
		bindPassword?: string;
		baseDn: string;
		userFilter: string;
		usernameAttribute: string;
		emailAttribute: string;
		displayNameAttribute: string;
		groupBaseDn?: string;
		groupFilter?: string;
		adminGroup?: string;
		roleMappings?: LdapRoleMapping[];
		tlsEnabled: boolean;
		tlsCa?: string;
	}

	interface Role {
		id: number;
		name: string;
		isSystem: boolean;
	}

	interface Props {
		onTabChange?: (tab: string) => void;
	}

	let { onTabChange = () => {} }: Props = $props();

	// LDAP state
	let ldapConfigs = $state<LdapConfig[]>([]);
	let ldapLoading = $state(true);
	let showLdapModal = $state(false);
	let editingLdap = $state<LdapConfig | null>(null);
	let confirmDeleteLdapId = $state<number | null>(null);
	let ldapTesting = $state<number | null>(null);
	let ldapTestResult = $state<{ success: boolean; error?: string; userCount?: number } | null>(null);
	let roles = $state<Role[]>([]);

	async function fetchLdapConfigs() {
		ldapLoading = true;
		try {
			const response = await fetch('/api/auth/ldap');
			if (response.ok) {
				ldapConfigs = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch LDAP configs:', error);
			toast.error('Failed to fetch LDAP configurations');
		} finally {
			ldapLoading = false;
		}
	}

	async function fetchRoles() {
		try {
			const response = await fetch('/api/roles');
			if (response.ok) {
				roles = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch roles:', error);
		}
	}

	function openLdapModal(config: LdapConfig | null) {
		editingLdap = config;
		showLdapModal = true;
	}

	function handleLdapModalClose() {
		showLdapModal = false;
		editingLdap = null;
	}

	async function handleLdapModalSaved() {
		showLdapModal = false;
		editingLdap = null;
		await fetchLdapConfigs();
	}

	async function deleteLdapConfig(configId: number) {
		try {
			const response = await fetch(`/api/auth/ldap/${configId}`, { method: 'DELETE' });
			if (response.ok) {
				await fetchLdapConfigs();
				toast.success('LDAP configuration deleted');
			} else {
				toast.error('Failed to delete LDAP configuration');
			}
		} catch (error) {
			console.error('Failed to delete LDAP config:', error);
			toast.error('Failed to delete LDAP configuration');
		} finally {
			confirmDeleteLdapId = null;
		}
	}

	async function testLdapConnection(configId: number) {
		ldapTesting = configId;
		ldapTestResult = null;
		try {
			const response = await fetch(`/api/auth/ldap/${configId}/test`, { method: 'POST' });
			const data = await response.json();
			ldapTestResult = data;
			if (data.success) {
				toast.success(`LDAP connection successful - found ${data.userCount} users`);
			} else {
				toast.error(`LDAP connection failed: ${data.error}`);
			}
		} catch (error) {
			ldapTestResult = { success: false, error: 'Failed to test connection' };
			toast.error('Failed to test LDAP connection');
		} finally {
			ldapTesting = null;
		}
	}

	async function toggleLdapEnabled(config: LdapConfig) {
		try {
			const response = await fetch(`/api/auth/ldap/${config.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...config, enabled: !config.enabled })
			});
			if (response.ok) {
				await fetchLdapConfigs();
				toast.success(`LDAP ${config.enabled ? 'disabled' : 'enabled'}`);
			} else {
				toast.error('Failed to toggle LDAP configuration');
			}
		} catch (error) {
			console.error('Failed to toggle LDAP config:', error);
			toast.error('Failed to toggle LDAP configuration');
		}
	}

	// Fetch data when license is confirmed as enterprise
	let hasFetched = $state(false);
	$effect(() => {
		if ($licenseStore.isEnterprise && !$licenseStore.loading && !hasFetched) {
			hasFetched = true;
			fetchLdapConfigs();
			fetchRoles();
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
					LDAP / Active Directory integration is available with an enterprise license. Connect to your organization's directory services for centralized authentication.
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
							<Network class="w-4 h-4" />
							LDAP configurations
						</Card.Title>
						<p class="text-xs text-muted-foreground mt-1">Connect to LDAP or Active Directory servers for centralized user authentication.</p>
					</div>
					{#if $canAccess('settings', 'edit')}
						<Button size="sm" onclick={() => openLdapModal(null)}>
							<Plus class="w-4 h-4" />
							Add LDAP
						</Button>
					{/if}
				</div>
			</Card.Header>
			<Card.Content>
				{#if ldapLoading}
					<div class="flex justify-center py-8">
						<RefreshCw class="w-6 h-6 animate-spin text-muted-foreground" />
					</div>
				{:else if ldapConfigs.length === 0}
					<EmptyState
						icon={Network}
						title="No LDAP providers configured"
						description="Click 'Add LDAP' to configure a new LDAP server"
						class="py-8"
					/>
				{:else}
					<div class="space-y-3">
						{#each ldapConfigs as config}
							<div class="flex items-center justify-between p-3 border rounded-lg">
								<div class="flex items-center gap-3">
									<Network class="w-5 h-5 text-muted-foreground" />
									<div>
										<div class="flex items-center gap-2">
											<span class="font-medium">{config.name}</span>
											{#if config.enabled}
												<Badge variant="default" class="text-xs">Enabled</Badge>
											{:else}
												<Badge variant="secondary" class="text-xs">Disabled</Badge>
											{/if}
										</div>
										<p class="text-xs text-muted-foreground">{config.serverUrl}</p>
									</div>
								</div>
								<div class="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onclick={() => testLdapConnection(config.id)}
										disabled={ldapTesting === config.id}
									>
										{#if ldapTesting === config.id}
											<RefreshCw class="w-4 h-4 animate-spin" />
										{:else}
											Test
										{/if}
									</Button>
									{#if $canAccess('settings', 'edit')}
										<Button
											variant="outline"
											size="sm"
											onclick={() => toggleLdapEnabled(config)}
										>
											{config.enabled ? 'Disable' : 'Enable'}
										</Button>
										<Button
											variant="outline"
											size="sm"
											onclick={() => openLdapModal(config)}
										>
											<Pencil class="w-4 h-4" />
										</Button>
										<ConfirmPopover
											open={confirmDeleteLdapId === config.id}
											action="Delete"
											itemType="LDAP config"
											itemName={config.name}
											onConfirm={() => deleteLdapConfig(config.id)}
											onOpenChange={(open) => confirmDeleteLdapId = open ? config.id : null}
										>
											{#snippet children({ open })}
												<Trash2 class="w-4 h-4 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
											{/snippet}
										</ConfirmPopover>
									{/if}
								</div>
							</div>
						{/each}
					</div>
					{#if ldapTestResult}
						<div class="mt-4 p-3 rounded-lg {ldapTestResult.success ? 'bg-green-500/10 text-green-600' : 'bg-destructive/10 text-destructive'}">
							{#if ldapTestResult.success}
								<p class="text-sm">Connection successful! Found {ldapTestResult.userCount} users.</p>
							{:else}
								<p class="text-sm">Connection failed: {ldapTestResult.error}</p>
							{/if}
						</div>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{/if}

<LdapModal
	bind:open={showLdapModal}
	ldap={editingLdap}
	{roles}
	isEnterprise={$licenseStore.isEnterprise}
	onClose={handleLdapModalClose}
	onSaved={handleLdapModalSaved}
/>
