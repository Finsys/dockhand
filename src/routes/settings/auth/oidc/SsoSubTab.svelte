<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import {
		LogIn,
		Plus,
		Pencil,
		Trash2,
		RefreshCw,
		Check,
		Pause,
		Play,
		Zap,
		XCircle
	} from 'lucide-svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { licenseStore } from '$lib/stores/license';
	import OidcModal from './OidcModal.svelte';
	import { EmptyState } from '$lib/components/ui/empty-state';

	interface OidcConfig {
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

	// OIDC/SSO state
	let oidcConfigs = $state<OidcConfig[]>([]);
	let oidcLoading = $state(true);
	let showOidcModal = $state(false);
	let editingOidc = $state<OidcConfig | null>(null);
	let confirmDeleteOidcId = $state<number | null>(null);
	let oidcTesting = $state<number | null>(null);
	let oidcTestResult = $state<{ success: boolean; error?: string; issuer?: string; endpoints?: any } | null>(null);

	async function fetchOidcConfigs() {
		oidcLoading = true;
		try {
			const response = await fetch('/api/auth/oidc');
			if (response.ok) {
				oidcConfigs = await response.json();
			}
		} catch (error) {
			console.error('Failed to fetch OIDC configs:', error);
			toast.error('Failed to fetch OIDC configurations');
		} finally {
			oidcLoading = false;
		}
	}

	function openOidcModal(config: OidcConfig | null) {
		editingOidc = config;
		showOidcModal = true;
	}

	function handleOidcModalClose() {
		showOidcModal = false;
		editingOidc = null;
	}

	async function handleOidcModalSaved() {
		showOidcModal = false;
		editingOidc = null;
		await fetchOidcConfigs();
	}

	async function deleteOidcConfig(configId: number) {
		try {
			const response = await fetch(`/api/auth/oidc/${configId}`, { method: 'DELETE' });
			if (response.ok) {
				await fetchOidcConfigs();
				toast.success('OIDC provider deleted');
			} else {
				toast.error('Failed to delete OIDC provider');
			}
		} catch (error) {
			console.error('Failed to delete OIDC config:', error);
			toast.error('Failed to delete OIDC provider');
		} finally {
			confirmDeleteOidcId = null;
		}
	}

	async function testOidcConnection(configId: number) {
		oidcTesting = configId;
		oidcTestResult = null;
		try {
			const response = await fetch(`/api/auth/oidc/${configId}/test`, { method: 'POST' });
			const data = await response.json();
			oidcTestResult = data;
			if (data.success) {
				toast.success('OIDC connection successful');
			} else {
				toast.error(`OIDC connection failed: ${data.error}`);
			}
		} catch (error) {
			oidcTestResult = { success: false, error: 'Failed to test connection' };
			toast.error('Failed to test OIDC connection');
		} finally {
			oidcTesting = null;
		}
	}

	async function toggleOidcEnabled(config: OidcConfig) {
		try {
			const response = await fetch(`/api/auth/oidc/${config.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...config, enabled: !config.enabled })
			});
			if (response.ok) {
				await fetchOidcConfigs();
				toast.success(`OIDC provider ${config.enabled ? 'disabled' : 'enabled'}`);
			} else {
				toast.error('Failed to toggle OIDC provider');
			}
		} catch (error) {
			console.error('Failed to toggle OIDC config:', error);
			toast.error('Failed to toggle OIDC provider');
		}
	}

	onMount(() => {
		fetchOidcConfigs();
	});
</script>

<div class="space-y-4">
	<Card.Root>
		<Card.Header>
			<div class="flex items-center justify-between">
				<div>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<LogIn class="w-4 h-4" />
						SSO providers
					</Card.Title>
					<p class="text-xs text-muted-foreground mt-1">Enable SSO using OpenID Connect providers like Okta, Auth0, Azure AD, or Google Workspace.</p>
				</div>
				{#if $canAccess('settings', 'edit')}
					<Button size="sm" onclick={() => openOidcModal(null)}>
						<Plus class="w-4 h-4" />
						Add provider
					</Button>
				{/if}
			</div>
		</Card.Header>
		<Card.Content>
			{#if oidcLoading}
				<div class="flex items-center justify-center py-4">
					<RefreshCw class="w-6 h-6 animate-spin text-muted-foreground" />
				</div>
			{:else if oidcConfigs.length === 0}
				<EmptyState
					icon={LogIn}
					title="No SSO providers configured"
					description="Add an OIDC provider to enable single sign-on"
					class="py-8"
				/>
			{:else}
				<div class="space-y-2">
					{#each oidcConfigs as config}
						<div class="flex items-center justify-between p-3 border rounded-md">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="font-medium text-sm">{config.name}</span>
									{#if config.enabled}
										<Badge variant="default" class="text-xs">Enabled</Badge>
									{:else}
										<Badge variant="outline" class="text-xs">Disabled</Badge>
									{/if}
								</div>
								<span class="text-xs text-muted-foreground truncate block">{config.issuerUrl}</span>
							</div>
							<div class="flex items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									title="Test connection"
									onclick={() => testOidcConnection(config.id)}
									disabled={oidcTesting === config.id}
								>
									{#if oidcTesting === config.id}
										<RefreshCw class="w-4 h-4 animate-spin" />
									{:else}
										<Zap class="w-4 h-4" />
									{/if}
								</Button>
								{#if $canAccess('settings', 'edit')}
									<Button
										variant="ghost"
										size="sm"
										title={config.enabled ? 'Disable provider' : 'Enable provider'}
										onclick={() => toggleOidcEnabled(config)}
									>
										{#if config.enabled}
											<Pause class="w-4 h-4" />
										{:else}
											<Play class="w-4 h-4" />
										{/if}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										title="Edit provider"
										onclick={() => openOidcModal(config)}
									>
										<Pencil class="w-4 h-4" />
									</Button>
									<ConfirmPopover
										open={confirmDeleteOidcId === config.id}
										action="Delete"
										itemType="OIDC provider"
										itemName={config.name}
										title="Delete"
										onConfirm={() => deleteOidcConfig(config.id)}
										onOpenChange={(open) => confirmDeleteOidcId = open ? config.id : null}
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
			{/if}

			{#if oidcTestResult}
				<div class="mt-4 p-3 border rounded-md {oidcTestResult.success ? 'border-green-500 bg-green-500/10' : 'border-destructive bg-destructive/10'}">
					{#if oidcTestResult.success}
						<div class="flex items-center gap-2 text-green-600">
							<Check class="w-4 h-4" />
							<p class="text-sm font-medium">Connection successful</p>
						</div>
						{#if oidcTestResult.issuer}
							<p class="text-xs text-muted-foreground mt-1">Issuer: {oidcTestResult.issuer}</p>
						{/if}
					{:else}
						<div class="flex items-center gap-2 text-destructive">
							<XCircle class="w-4 h-4" />
							<p class="text-sm">Connection failed: {oidcTestResult.error}</p>
						</div>
					{/if}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>

<OidcModal
	bind:open={showOidcModal}
	oidc={editingOidc}
	{roles}
	isEnterprise={$licenseStore.isEnterprise}
	onClose={handleOidcModalClose}
	onSaved={handleOidcModalSaved}
/>
