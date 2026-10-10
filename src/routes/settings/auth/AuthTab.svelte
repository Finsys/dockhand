<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import {
		Shield,
		User,
		Settings,
		Crown,
		KeyRound,
		Network,
		LogIn,
		RefreshCw,
		Save,
		Info
	} from 'lucide-svelte';
	import { TogglePill, ToggleGroup } from '$lib/components/ui/toggle-pill';
	import { canAccess, isAdmin, authStore } from '$lib/stores/auth';
	import { licenseStore } from '$lib/stores/license';

	// Sub-tab components
	import UsersSubTab from './users/UsersSubTab.svelte';
	import LdapSubTab from './ldap/LdapSubTab.svelte';
	import SsoSubTab from './oidc/SsoSubTab.svelte';
	import RolesSubTab from './roles/RolesSubTab.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { splitAtName } from '$lib/i18n/split';

	// Props
	interface Props {
		onTabChange?: (tab: string) => void;
	}

	let { onTabChange = (_tab: string) => {} }: Props = $props();

	// Role type for passing to sub-tabs
	interface Role {
		id: number;
		name: string;
		description?: string;
		isSystem: boolean;
		permissions: any;
		createdAt: string;
	}

	// Authentication state
	let authSubTab = $state<'general' | 'local' | 'ldap' | 'sso' | 'roles'>('general');
	let authEnabled = $state(false);
	// Set when the server refuses to describe the auth setup, so the page can say that
	// rather than render its defaults as though they were the configuration.
	let authForbidden = $state(false);
	let authLoading = $state(true);
	let sessionTimeout = $state(86400);
	let passkeysEnabled = $state(false);
	// Whether ORIGIN lets a ceremony run at all, so the screen can say why an
	// enabled setting is still not offering anything.
	let passkeysConfigurable = $state(true);
	let neverExpire = $state(false);
	let authSaving = $state(false);

	// Roles state (shared with sub-tabs that need it)
	let roles = $state<Role[]>([]);

	// === Authentication Functions ===
	async function fetchAuthSettings() {
		authLoading = true;
		try {
			const response = await fetch('/api/auth/settings');
			if (response.status === 401 || response.status === 403) {
				authForbidden = true;
			} else if (response.ok) {
				authForbidden = false;
				const data = await response.json();
				authEnabled = data.authEnabled;
				// 0 is the "never expire" sentinel; keep the last real timeout for the input.
				neverExpire = data.sessionTimeout === 0;
				sessionTimeout = data.sessionTimeout || 86400;
				passkeysEnabled = data.passkeysEnabled === true;
				passkeysConfigurable = data.passkeysConfigurable !== false;
			}
		} catch (error) {
			console.error('Failed to fetch auth settings:', error);
		} finally {
			authLoading = false;
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

	async function handleAuthEnabledToggle(checked: boolean) {
		authSaving = true;
		try {
			const response = await fetch('/api/auth/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ authEnabled: checked })
			});
			if (response.ok) {
				// authEnabled already updated via binding
				toast.success(checked ? m.settings_auth_toast_enabled() : m.settings_auth_toast_disabled());
				// Update global auth store so other components react immediately
				await authStore.check();
			} else {
				const data = await response.json();
				toast.error(data.error || m.settings_auth_toast_update_failed());
				// Revert toggle on error - checked is new value, so previous was !checked
				authEnabled = !checked;
			}
		} catch (error) {
			console.error('Failed to update auth settings:', error);
			toast.error(m.settings_auth_toast_update_failed());
			// Revert toggle on error
			authEnabled = !checked;
		} finally {
			authSaving = false;
		}
	}

	async function saveAuthSettings() {
		authSaving = true;
		try {
			const response = await fetch('/api/auth/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionTimeout: neverExpire ? 0 : sessionTimeout, passkeysEnabled })
			});
			if (response.ok) {
				toast.success(m.settings_auth_toast_saved());
			} else {
				console.error('Failed to save auth settings');
				toast.error(m.settings_auth_toast_save_failed());
			}
		} catch (error) {
			console.error('Failed to save auth settings:', error);
			toast.error(m.settings_auth_toast_save_failed());
		} finally {
			authSaving = false;
		}
	}

	// Initialize on mount
	onMount(() => {
		fetchAuthSettings();
	});

	// Fetch roles reactively when enterprise license is detected or when switching to users tab
	$effect(() => {
		if ($licenseStore.isEnterprise) {
			fetchRoles();
		}
	});

	// Refetch roles when switching to users tab (in case roles were added/modified)
	$effect(() => {
		if (authSubTab === 'local' && $licenseStore.isEnterprise) {
			fetchRoles();
		}
	});
</script>

<div class="flex flex-col flex-1 min-h-0">
<!-- Auth Enable/Disable Toggle at Top -->
{#if !authForbidden}
<div class="flex items-start gap-3 p-3 mb-3 border rounded-md bg-muted/30 flex-shrink-0">
	<Shield class="w-5 h-5 text-muted-foreground mt-0.5" />
	<div class="flex-1">
		<div class="flex items-center gap-3">
			<p class="text-sm font-medium">{m.settings_auth_title()}</p>
			<TogglePill
				bind:checked={authEnabled}
				onchange={(checked) => handleAuthEnabledToggle(checked)}
				disabled={authLoading || authSaving || !$canAccess('settings', 'edit')}
			/>
		</div>
		<p class="text-xs text-muted-foreground mt-1">
			{authEnabled
				? m.settings_auth_enabled_description()
				: m.settings_auth_disabled_description()}
		</p>
		<p class="text-xs text-muted-foreground mt-1 flex items-center gap-1">
			<Crown class="w-3 h-3 text-amber-500" />
			{#if $licenseStore.isEnterprise}
				{authEnabled
					? m.settings_auth_audit_active()
					: m.settings_auth_audit_enable_hint()}
			{:else}
				{m.settings_auth_audit_enable_hint()}
			{/if}
		</p>
	</div>
</div>
{/if}

<!-- Auth Subtabs Navigation -->
<div class="inline-flex gap-1 p-1 bg-muted/50 rounded-lg mb-3 flex-shrink-0">
	<button
		class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-all {authSubTab ===
		'general'
			? 'bg-background text-foreground shadow-sm'
			: 'text-muted-foreground hover:text-foreground'}"
		onclick={() => (authSubTab = 'general')}
	>
		<Settings class="w-4 h-4" />
		{m.settings_auth_tab_general()}
	</button>
	<!-- The list behind this tab carries every account's email and says which are
	     administrators, so the tab follows the same permission the API asks for. -->
	{#if $canAccess('users', 'view')}
		<button
			class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-all {authSubTab ===
			'local'
				? 'bg-background text-foreground shadow-sm'
				: 'text-muted-foreground hover:text-foreground'}"
			onclick={() => (authSubTab = 'local')}
		>
			<User class="w-4 h-4" />
			{m.audit_entity_users()}
		</button>
	{/if}
	<!-- Behind this is the identity-provider configuration, which /api/auth/oidc holds
	     to settings:view. Without the tab, a refused read renders as an empty list that
	     reads like "nothing is configured" - a confident wrong answer. -->
	{#if $canAccess('settings', 'view')}
		<button
			class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-all {authSubTab ===
			'sso'
				? 'bg-background text-foreground shadow-sm'
				: 'text-muted-foreground hover:text-foreground'}"
			onclick={() => (authSubTab = 'sso')}
		>
			<LogIn class="w-4 h-4" />
			SSO / OIDC
		</button>
	{/if}
	<!-- /api/auth/ldap asks for admin, not settings:view, so this tab follows that
	     instead - the same empty-list problem otherwise reappears one permission down. -->
	{#if $isAdmin}
		<button
			class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-all {authSubTab ===
			'ldap'
				? 'bg-background text-foreground shadow-sm'
				: 'text-muted-foreground hover:text-foreground'}"
			onclick={() => (authSubTab = 'ldap')}
		>
			<Network class="w-4 h-4" />
			LDAP / AD
			<Crown class="w-3 h-3 text-amber-500" />
		</button>
	{/if}
	<!-- A role carries its full permission matrix, which is a map of who may do what
	     here, so this follows the permission /api/roles asks for. -->
	{#if $canAccess('users', 'view')}
		<button
			class="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-all {authSubTab ===
			'roles'
				? 'bg-background text-foreground shadow-sm'
				: 'text-muted-foreground hover:text-foreground'}"
			onclick={() => (authSubTab = 'roles')}
		>
			<Shield class="w-4 h-4" />
			{m.audit_entity_roles()}
			<Crown class="w-3 h-3 text-amber-500" />
		</button>
	{/if}
</div>

<!-- Sub-tab Content -->
<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
<!-- General Settings Subtab -->
{#if authSubTab === 'general'}
	<div class="flex-1 min-h-0 overflow-y-auto space-y-4">
		{#if authForbidden}
			<!-- The server refused to describe the auth setup to this account. Saying so
			     beats rendering the defaults, which would read as "auth is disabled". -->
			<div class="flex items-start gap-3 p-3 border rounded-md bg-muted/30">
				<Shield class="w-5 h-5 text-muted-foreground mt-0.5" />
				<div class="flex-1">
					<p class="text-sm font-medium">{m.settings_auth_forbidden_title()}</p>
					<p class="text-xs text-muted-foreground mt-1">
						{m.settings_auth_forbidden_description()}
					</p>
				</div>
			</div>
		{:else if authEnabled}
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<KeyRound class="w-4 h-4" />
						{m.settings_auth_session_title()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-1.5">
						<Label class="text-sm">{m.settings_auth_session_timeout_label()}</Label>
						<p class="text-xs text-muted-foreground mb-2">
							{m.settings_auth_session_timeout_description()}
						</p>
						<div class="flex items-center gap-2 mb-2">
							<ToggleGroup
								value={neverExpire ? 'never' : 'timed'}
								options={[{ value: 'timed', label: m.settings_auth_session_timed() }, { value: 'never', label: m.settings_auth_session_never_expire() }]}
								onchange={(v) => neverExpire = v === 'never'}
								disabled={!$canAccess('settings', 'edit')}
							/>
							<span class="text-xs text-muted-foreground">
								{neverExpire ? m.settings_auth_session_never_expire_hint() : m.settings_auth_session_timed_hint()}
							</span>
						</div>
						<div class="flex items-center gap-2">
							<Input
								type="number"
								value={sessionTimeout}
								min={3600}
								max={604800}
								onchange={(e) => {
									const val = parseInt(e.currentTarget.value);
									sessionTimeout = Math.max(3600, Math.min(604800, isNaN(val) ? 86400 : val));
									e.currentTarget.value = String(sessionTimeout);
								}}
								class="w-32"
								disabled={neverExpire || !$canAccess('settings', 'edit')}
							/>
							<span class="text-sm text-muted-foreground">{m.settings_auth_session_seconds()}</span>
							<span class="text-xs text-muted-foreground">
								({m.settings_auth_session_hours({ count: Math.floor(sessionTimeout / 3600) })})
							</span>
						</div>
					</div>
					<div class="space-y-1.5 border-t border-border/60 pt-4">
						<div class="flex items-center gap-3">
							<Label class="text-sm">{m.settings_auth_passkeys_label()}</Label>
							<TogglePill bind:checked={passkeysEnabled} disabled={!$canAccess('settings', 'edit')} />
						</div>
						<p class="text-xs text-muted-foreground">
							{m.settings_auth_passkeys_description()}
						</p>
						{#if passkeysEnabled && !passkeysConfigurable}
							{@const [originBefore, originAfter] = splitAtName(m.settings_auth_passkeys_origin_hint)}
							<div class="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
								<Info class="w-3.5 h-3.5 mt-0.5 shrink-0" />
								<span>
									{originBefore}<code>ORIGIN</code>{originAfter}
								</span>
							</div>
						{/if}
					</div>
					{#if $canAccess('settings', 'edit')}
						<Button size="sm" onclick={saveAuthSettings} disabled={authSaving}>
							{#if authSaving}
								<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
							{:else}
								<Save class="w-4 h-4" />
							{/if}
							{m.settings_auth_save_settings()}
						</Button>
					{/if}
				</Card.Content>
			</Card.Root>
		{:else}
			<div class="text-center py-12 text-muted-foreground">
				<Shield class="w-12 h-12 mx-auto mb-3 opacity-30" />
				<p class="text-sm">{m.settings_auth_session_enable_hint()}</p>
			</div>
		{/if}
	</div>
{/if}

<!-- Local Users Subtab -->
{#if authSubTab === 'local' && $canAccess('users', 'view')}
	<div class="flex flex-col flex-1 min-h-0">
		<UsersSubTab {roles} />
	</div>
{/if}

<!-- LDAP / AD Subtab -->
{#if authSubTab === 'ldap' && $isAdmin}
	<div class="flex-1 min-h-0 overflow-y-auto">
		<LdapSubTab {onTabChange} />
	</div>
{/if}

<!-- SSO / OIDC Subtab -->
{#if authSubTab === 'sso' && $canAccess('settings', 'view')}
	<div class="flex-1 min-h-0 overflow-y-auto">
		<SsoSubTab {roles} />
	</div>
{/if}

<!-- Roles Subtab -->
{#if authSubTab === 'roles' && $canAccess('users', 'view')}
	<div class="flex-1 min-h-0 overflow-y-auto">
		<RolesSubTab {onTabChange} />
	</div>
{/if}
</div>
</div>
