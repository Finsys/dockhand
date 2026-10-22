<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import {
		User,
		Mail,
		Shield,
		ShieldCheck,
		Key,
		KeyRound,
		RefreshCw,
		Check,
		Smartphone,
		QrCode,
		AlertTriangle,
		Crown,
		Calendar,
		Clock,
		Camera,
		Trash2,
		TriangleAlert,
		Palette,
		Plus,
		Compass
	} from 'lucide-svelte';
	import { authStore } from '$lib/stores/auth';
	import { formatDateTime } from '$lib/stores/settings';
	import * as Alert from '$lib/components/ui/alert';
	import AvatarCropper from '$lib/components/AvatarCropper.svelte';
	import * as Avatar from '$lib/components/ui/avatar';
	import ChangePasswordModal from './ChangePasswordModal.svelte';
	import MfaSetupModal from './MfaSetupModal.svelte';
	import DisableMfaModal from './DisableMfaModal.svelte';
	import ApiTokenModal from './ApiTokenModal.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import * as Table from '$lib/components/ui/table';
	import ThemeSelector from '$lib/components/ThemeSelector.svelte';
	import LanguageSelector from '$lib/components/LanguageSelector.svelte';
	import NavigationSelector from '$lib/components/NavigationSelector.svelte';
	import AnimateIconsToggle from '$lib/components/AnimateIconsToggle.svelte';
	import IndentGuidesToggle from '$lib/components/IndentGuidesToggle.svelte';
	import ColoredActionsToggle from '$lib/components/ColoredActionsToggle.svelte';
	import EditorThemeSelector from '$lib/components/EditorThemeSelector.svelte';
	import { themeStore } from '$lib/stores/theme';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { startRegistration } from '@simplewebauthn/browser';
	import { m } from '$lib/paraglide/messages.js';

	interface Profile {
		id: number;
		username: string;
		email: string | null;
		displayName: string | null;
		avatar: string | null;
		mfaEnabled: boolean;
		isAdmin: boolean;
		provider: string;
		lastLogin: string | null;
		createdAt: string;
		updatedAt: string;
	}

	let profile = $state<Profile | null>(null);
	let loading = $state(true);
	let error = $state('');
	let profileFetched = $state(false);

	// Profile form state
	let formEmail = $state('');
	let formDisplayName = $state('');
	let formSaving = $state(false);
	let formError = $state('');
	let formSuccess = $state('');

	// Password change state
	let showPasswordModal = $state(false);

	// MFA state
	let showMfaSetupModal = $state(false);
	let mfaQrCode = $state('');
	let mfaSecret = $state('');
	let mfaLoading = $state(false);
	let mfaError = $state('');
	let showDisableMfaModal = $state(false);

	// API tokens state
	interface ApiToken {
		id: number;
		name: string;
		tokenPrefix: string;
		lastUsed: string | null;
		expiresAt: string | null;
		createdAt: string;
	}
	let apiTokens = $state<ApiToken[]>([]);
	let showApiTokenModal = $state(false);
	let tokensLoading = $state(false);

	interface Passkey {
		id: number;
		name: string | null;
		deviceType: string;
		backedUp: boolean;
		createdAt: string;
	}
	let passkeys = $state<Passkey[]>([]);
	let passkeysLoading = $state(false);
	// Whether this instance offers passkeys. Existing keys stay listed when it is
	// off, so somebody can see what they registered before it was turned off.
	let passkeysEnabled = $state(false);
	let passkeyActionLoading = $state(false);
	let passkeyName = $state('');
	let passkeyError = $state('');

	async function fetchPasskeys() {
		passkeysLoading = true;
		try {
			const response = await fetch('/api/profile/passkeys');
			if (response.ok) {
				const data = await response.json();
				passkeys = data.passkeys || [];
				passkeysEnabled = data.enabled === true;
			}
		} finally {
			passkeysLoading = false;
		}
	}

	async function addPasskey() {
		const name = passkeyName.trim();
		if (!name) {
			passkeyError = m.profile_passkey_error_name_required();
			return;
		}
		passkeyActionLoading = true;
		passkeyError = '';
		try {
			const optionsResponse = await fetch('/api/auth/passkeys/register/options', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			const optionsData = await optionsResponse.json();
			if (!optionsResponse.ok) throw new Error(optionsData.error || m.profile_passkey_error_unavailable());

			const registrationResponse = await startRegistration({ optionsJSON: optionsData.options });
			const verifyResponse = await fetch('/api/auth/passkeys/register/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					ceremonyId: optionsData.ceremonyId,
					response: registrationResponse
				})
			});
			const verifyData = await verifyResponse.json();
			if (!verifyResponse.ok) throw new Error(verifyData.error || m.profile_passkey_error_failed());
			passkeyName = '';
			await fetchPasskeys();
			showSuccessMessage(m.profile_passkey_added_success());
		} catch (e) {
			passkeyError = e instanceof Error && e.name !== 'NotAllowedError'
				? e.message
				: m.profile_passkey_error_cancelled();
		} finally {
			passkeyActionLoading = false;
		}
	}

	async function deletePasskey(passkey: Passkey) {
		if (!window.confirm(m.profile_passkey_delete_confirm({ name: passkey.name || m.profile_passkey_default_name() }))) return;
		passkeyError = '';
		const response = await fetch(`/api/profile/passkeys/${passkey.id}`, { method: 'DELETE' });
		if (response.ok) {
			await fetchPasskeys();
			showSuccessMessage(m.profile_passkey_removed());
		} else {
			const data = await response.json();
			passkeyError = data.error || m.profile_passkey_error_remove_failed();
		}
	}

	async function fetchApiTokens() {
		tokensLoading = true;
		try {
			const response = await fetch('/api/auth/tokens');
			if (response.ok) {
				apiTokens = await response.json();
			}
		} catch {
			// Silently fail - tokens section will show empty
		} finally {
			tokensLoading = false;
		}
	}

	async function revokeToken(tokenId: number) {
		try {
			const response = await fetch(`/api/auth/tokens/${tokenId}`, { method: 'DELETE' });
			if (response.ok) {
				apiTokens = apiTokens.filter(t => t.id !== tokenId);
			}
		} catch {
			// Ignore
		}
	}

	function isTokenExpired(expiresAt: string | null): boolean {
		if (!expiresAt) return false;
		return new Date(expiresAt) < new Date();
	}

	// Avatar state
	let showAvatarCropper = $state(false);
	let avatarSaving = $state(false);
	let avatarFileInput = $state<HTMLInputElement | null>(null);
	let imageForCrop = $state('');

	function handleAvatarFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			if (!file.type.startsWith('image/')) {
				formError = m.profile_avatar_error_not_image();
				return;
			}
			const reader = new FileReader();
			reader.onload = (e) => {
				imageForCrop = e.target?.result as string;
				showAvatarCropper = true;
			};
			reader.readAsDataURL(file);
		}
	}

	function triggerAvatarUpload() {
		avatarFileInput?.click();
	}

	function cancelAvatarCrop() {
		showAvatarCropper = false;
		imageForCrop = '';
		if (avatarFileInput) {
			avatarFileInput.value = '';
		}
	}

	async function fetchProfile() {
		loading = true;
		error = '';

		try {
			const response = await fetch('/api/profile');
			if (response.ok) {
				profile = await response.json();
				formEmail = profile?.email || '';
				formDisplayName = profile?.displayName || '';
			} else if (response.status === 401) {
				goto('/login');
			} else {
				const data = await response.json();
				error = data.error || m.profile_error_load_failed();
			}
		} catch (e) {
			error = m.profile_error_load_failed();
		} finally {
			loading = false;
		}
	}

	async function saveProfile() {
		formSaving = true;
		formError = '';
		formSuccess = '';

		try {
			const response = await fetch('/api/profile', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					email: formEmail.trim() || null,
					displayName: formDisplayName.trim() || null
				})
			});

			if (response.ok) {
				profile = await response.json();
				formSuccess = m.profile_updated_success();
				// Refresh auth store to update sidebar
				await authStore.check();
				setTimeout(() => formSuccess = '', 3000);
			} else {
				const data = await response.json();
				formError = data.error || m.profile_error_update_failed();
			}
		} catch (e) {
			formError = m.profile_error_update_failed();
		} finally {
			formSaving = false;
		}
	}

	function showSuccessMessage(message: string) {
		formSuccess = message;
		setTimeout(() => formSuccess = '', 3000);
	}

	async function setupMfa() {
		if (!profile) return;

		mfaLoading = true;
		mfaError = '';
		mfaQrCode = '';
		mfaSecret = '';

		try {
			const response = await fetch(`/api/users/${profile.id}/mfa`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});

			if (response.ok) {
				const data = await response.json();
				mfaQrCode = data.qrDataUrl;
				mfaSecret = data.secret;
				showMfaSetupModal = true;
			} else {
				const data = await response.json();
				mfaError = data.error || m.profile_mfa_error_setup_failed();
			}
		} catch (e) {
			mfaError = m.profile_mfa_error_setup_failed();
		} finally {
			mfaLoading = false;
		}
	}

	async function handleMfaEnabled() {
		await fetchProfile();
		showSuccessMessage(m.profile_mfa_enabled_success());
	}

	async function handleMfaDisabled() {
		await fetchProfile();
		showSuccessMessage(m.profile_mfa_disabled_success());
	}

	function formatProfileDate(dateStr: string | null): string {
		if (!dateStr) return m.profile_never();
		return formatDateTime(dateStr, true);
	}

	async function saveAvatar(dataUrl: string) {
		avatarSaving = true;
		formError = '';

		try {
			const response = await fetch('/api/profile/avatar', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ avatar: dataUrl })
			});

			if (response.ok) {
				const data = await response.json();
				if (profile) {
					profile.avatar = data.avatar;
				}
				formSuccess = m.profile_avatar_updated_success();
				await authStore.check();
				setTimeout(() => formSuccess = '', 3000);
				// Close cropper
				showAvatarCropper = false;
				imageForCrop = '';
				if (avatarFileInput) {
					avatarFileInput.value = '';
				}
			} else {
				const data = await response.json();
				formError = data.error || m.profile_avatar_error_upload_failed();
			}
		} catch (e) {
			formError = m.profile_avatar_error_upload_failed();
		} finally {
			avatarSaving = false;
		}
	}

	async function removeAvatar() {
		avatarSaving = true;
		formError = '';

		try {
			const response = await fetch('/api/profile/avatar', {
				method: 'DELETE'
			});

			if (response.ok) {
				if (profile) {
					profile.avatar = null;
				}
				formSuccess = m.profile_avatar_removed_success();
				await authStore.check();
				setTimeout(() => formSuccess = '', 3000);
			} else {
				const data = await response.json();
				formError = data.error || m.profile_avatar_error_remove_failed();
			}
		} catch (e) {
			formError = m.profile_avatar_error_remove_failed();
		} finally {
			avatarSaving = false;
		}
	}

	// Wait for auth store to finish loading before making routing decisions
	$effect(() => {
		if (!$authStore.loading) {
			if (!$authStore.authEnabled) {
				goto('/');
				return;
			}
			if (!$authStore.authenticated) {
				goto('/login');
				return;
			}
			if (!profileFetched) {
				profileFetched = true;
				fetchProfile();
				fetchApiTokens();
				fetchPasskeys();
			}
		}
	});
</script>

<svelte:head>
	<title>{m.profile_page_title()}</title>
</svelte:head>

<div class="container mx-auto p-6">
	<div class="flex items-center gap-3 mb-6">
		<PageHeader icon={User} title={m.profile_title()} showConnection={false}>
			<p class="text-muted-foreground text-sm">{m.profile_subtitle()}</p>
		</PageHeader>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<RefreshCw class="w-6 h-6 animate-spin text-muted-foreground" />
		</div>
	{:else if error}
		<Card.Root>
			<Card.Content class="py-6">
				<div class="flex items-center gap-2 text-destructive">
					<AlertTriangle class="w-5 h-5" />
					<span>{error}</span>
				</div>
			</Card.Content>
		</Card.Root>
	{:else if profile}
		<div class="grid gap-6">
			<!-- Success message -->
			{#if formSuccess}
				<div class="bg-green-500/10 text-green-600 dark:text-green-400 p-3 rounded-md flex items-center gap-2">
					<Check class="w-4 h-4" />
					{formSuccess}
				</div>
			{/if}

			<!-- Row 1: Account info + Profile details -->
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

			<!-- Account info card -->
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<User class="w-5 h-5" />
						{m.profile_account_title()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="flex items-start gap-6">
						<!-- Hidden file input -->
						<input
							type="file"
							accept="image/*"
							bind:this={avatarFileInput}
							onchange={handleAvatarFileSelect}
							class="hidden"
						/>

						<!-- Avatar section -->
						<div class="flex flex-col items-center gap-2">
							<div class="relative group">
								<button
									type="button"
									onclick={triggerAvatarUpload}
									class="block rounded-full focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
									disabled={avatarSaving}
								>
									<Avatar.Root class="w-24 h-24 border-2 border-border cursor-pointer hover:opacity-80 transition-opacity">
										<Avatar.Image src={profile.avatar} alt={profile.displayName || profile.username} />
										<Avatar.Fallback class="bg-primary/10 text-primary text-2xl">
											{(profile.displayName || profile.username)?.slice(0, 2).toUpperCase()}
										</Avatar.Fallback>
									</Avatar.Root>
								</button>
								<button
									type="button"
									onclick={triggerAvatarUpload}
									class="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
									disabled={avatarSaving}
								>
									<Camera class="w-6 h-6 text-white" />
								</button>
								{#if profile.avatar}
									<button
										type="button"
										onclick={removeAvatar}
										disabled={avatarSaving}
										class="absolute -bottom-1 -right-1 p-1 rounded-full bg-background border border-border text-muted-foreground hover:text-destructive hover:border-destructive transition-colors"
										title={m.profile_avatar_remove()}
									>
										<Trash2 class="w-3.5 h-3.5" />
									</button>
								{/if}
							</div>
						</div>

						<!-- Account details -->
						<div class="flex-1 space-y-4">
							<div class="grid grid-cols-2 gap-4">
								<div>
									<Label class="text-muted-foreground text-xs">{m.login_username_label()}</Label>
									<p class="font-medium">{profile.username}</p>
								</div>
								<div>
									<Label class="text-muted-foreground text-xs">{m.profile_role_label()}</Label>
									<div class="flex items-center gap-2">
										{#if profile.isAdmin}
											<Badge variant="default" class="gap-1 rounded-sm">
												<Crown class="w-3 h-3" />
												{m.sidebar_role_admin()}
											</Badge>
										{:else}
											<Badge variant="secondary" class="rounded-sm">{m.sidebar_role_user()}</Badge>
										{/if}
									</div>
								</div>
							</div>

							<div class="grid grid-cols-2 gap-4">
								<div>
									<Label class="text-muted-foreground text-xs">{m.profile_created_label()}</Label>
									<p class="text-sm flex items-center gap-1">
										<Calendar class="w-3.5 h-3.5" />
										{formatProfileDate(profile.createdAt)}
									</p>
								</div>
								<div>
									<Label class="text-muted-foreground text-xs">{m.profile_last_login_label()}</Label>
									<p class="text-sm flex items-center gap-1">
										<Clock class="w-3.5 h-3.5" />
										{formatProfileDate(profile.lastLogin)}
									</p>
								</div>
							</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>

			<!-- Profile details card -->
			<Card.Root class="flex flex-col">
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Mail class="w-5 h-5" />
						{m.profile_details_title()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="flex-1 flex flex-col space-y-4">
					{#if formError}
						<Alert.Root variant="destructive">
							<TriangleAlert class="h-4 w-4" />
							<Alert.Description>{formError}</Alert.Description>
						</Alert.Root>
					{/if}

					<div class="space-y-4 flex-1">
						<div class="space-y-2">
							<Label>{m.profile_display_name_label()}</Label>
							<Input
								bind:value={formDisplayName}
								placeholder={m.profile_display_name_placeholder()}
							/>
						</div>
						<div class="space-y-2">
							<Label>{m.profile_email_label()}</Label>
							<Input
								type="email"
								bind:value={formEmail}
								placeholder={m.profile_email_placeholder()}
							/>
						</div>
					</div>

					<div class="flex justify-end">
						<Button onclick={saveProfile} disabled={formSaving}>
							{#if formSaving}
								<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
							{:else}
								<Check class="w-4 h-4" />
							{/if}
							{m.profile_save_changes()}
						</Button>
					</div>
				</Card.Content>
			</Card.Root>

			</div>

			<!-- Row 2: Security + API tokens -->
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

			<!-- Security card -->
			<Card.Root class="flex flex-col">
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Shield class="w-5 h-5" />
						{m.profile_security_title()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<!-- Password - only show for local auth users -->
					{#if profile.provider === 'local'}
						<div class="flex items-center justify-between p-3 border rounded-lg">
							<div class="flex items-center gap-3">
								<Key class="w-5 h-5 text-muted-foreground" />
								<div>
									<p class="font-medium">{m.login_password_label()}</p>
									<p class="text-sm text-muted-foreground">{m.profile_password_change_hint()}</p>
								</div>
							</div>
							<Button variant="outline" onclick={() => showPasswordModal = true}>
								{m.profile_password_change()}
							</Button>
						</div>
					{:else}
						<div class="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
							<div class="flex items-center gap-3">
								<Key class="w-5 h-5 text-muted-foreground" />
								<div>
									<p class="font-medium">{m.login_password_label()}</p>
									<p class="text-sm text-muted-foreground">{m.profile_managed_by_sso()}</p>
								</div>
							</div>
							<Badge class="gap-1 rounded-sm bg-yellow-500/20 text-yellow-600 border-yellow-500/30 hover:bg-yellow-500/30">
								<ShieldCheck class="w-3 h-3" />
								SSO
							</Badge>
						</div>
					{/if}

					<!-- MFA - only show for local auth users -->
					{#if profile.provider === 'local'}
						<div class="flex items-center justify-between p-3 border rounded-lg">
							<div class="flex items-center gap-3">
								<Smartphone class="w-5 h-5 text-muted-foreground" />
								<div>
									<div class="flex items-center gap-2">
										<p class="font-medium">{m.profile_mfa_title()}</p>
										{#if profile.mfaEnabled}
											<Badge variant="default" class="bg-green-500 gap-1 rounded-sm">
												<ShieldCheck class="w-3 h-3" />
												{m.profile_mfa_badge_enabled()}
											</Badge>
										{:else}
											<Badge variant="secondary" class="rounded-sm">{m.profile_mfa_badge_disabled()}</Badge>
										{/if}
									</div>
									<p class="text-sm text-muted-foreground">
										{#if profile.mfaEnabled}
											{m.profile_mfa_enabled_hint()}
										{:else}
											{m.profile_mfa_disabled_hint()}
										{/if}
									</p>
								</div>
							</div>
							{#if profile.mfaEnabled}
								<Button variant="outline" onclick={() => showDisableMfaModal = true}>
									{m.profile_mfa_disable()}
								</Button>
							{:else}
								<Button onclick={setupMfa} disabled={mfaLoading}>
									{#if mfaLoading}
										<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
									{:else}
										<QrCode class="w-4 h-4" />
									{/if}
									{m.profile_mfa_setup()}
								</Button>
							{/if}
						</div>
					{:else}
						<div class="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
							<div class="flex items-center gap-3">
								<Smartphone class="w-5 h-5 text-muted-foreground" />
								<div>
									<p class="font-medium">{m.profile_mfa_title()}</p>
									<p class="text-sm text-muted-foreground">{m.profile_managed_by_sso()}</p>
								</div>
							</div>
							<Badge class="gap-1 rounded-sm bg-yellow-500/20 text-yellow-600 border-yellow-500/30 hover:bg-yellow-500/30">
								<ShieldCheck class="w-3 h-3" />
								SSO
							</Badge>
						</div>
					{/if}

					{#if mfaError && !showMfaSetupModal}
						<Alert.Root variant="destructive">
							<TriangleAlert class="h-4 w-4" />
							<Alert.Description>{mfaError}</Alert.Description>
						</Alert.Root>
					{/if}

					<div class="p-3 border rounded-lg space-y-3">
						<div class="flex items-center gap-3">
							<KeyRound class="w-5 h-5 text-muted-foreground" />
							<div>
								<p class="font-medium">{m.profile_passkeys_title()}</p>
								<p class="text-sm text-muted-foreground">{m.profile_passkeys_description()}</p>
							</div>
						</div>

						{#if !passkeysEnabled}
							<p class="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
								{m.profile_passkeys_disabled_notice()}
							</p>
						{:else}
						<div class="space-y-2">
							<Label for="passkey-name">{m.profile_passkey_name_label()}</Label>
							<div class="flex flex-col sm:flex-row gap-2">
							<Input id="passkey-name" bind:value={passkeyName} maxlength={64} placeholder={m.profile_passkey_name_placeholder()} />
							<Button onclick={addPasskey} disabled={passkeyActionLoading || !passkeyName.trim()} class="shrink-0">
								{#if passkeyActionLoading}
									<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
								{:else}
									<Plus class="w-4 h-4 mr-1" />
								{/if}
								{m.profile_passkey_add()}
							</Button>
							</div>
						</div>
						{/if}

						{#if passkeysLoading}
							<p class="text-sm text-muted-foreground">{m.profile_passkeys_loading()}</p>
						{:else if passkeys.length === 0}
							<p class="text-sm text-muted-foreground">{m.profile_passkeys_empty()}</p>
						{:else}
							<div class="divide-y rounded-md border">
								{#each passkeys as passkey (passkey.id)}
									<div class="flex items-center justify-between gap-3 p-3">
										<div class="min-w-0">
											<p class="font-medium truncate">{passkey.name || m.profile_passkey_default_name()}</p>
											<p class="text-xs text-muted-foreground mt-1">
											{passkey.deviceType === 'multiDevice' ? m.profile_passkey_synced() : m.profile_passkey_device_bound()}
											{passkey.backedUp ? ` · ${m.profile_passkey_backed_up()}` : ''} · {m.profile_passkey_added_on({ date: formatDateTime(passkey.createdAt) })}
											</p>
										</div>
										<Button
											variant="outline"
											size="sm"
											class="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
											onclick={() => deletePasskey(passkey)}
											aria-label={m.profile_passkey_delete_label({ name: passkey.name || m.profile_passkey_default_name() })}
											title={m.profile_passkey_delete_label({ name: passkey.name || m.profile_passkey_default_name() })}
										>
											<Trash2 class="w-4 h-4 mr-1" />
											{m.profile_passkey_delete()}
										</Button>
									</div>
								{/each}
							</div>
						{/if}

						{#if passkeyError}
							<Alert.Root variant="destructive">
								<TriangleAlert class="h-4 w-4" />
								<Alert.Description>{passkeyError}</Alert.Description>
							</Alert.Root>
						{/if}
					</div>
				</Card.Content>
			</Card.Root>

			<!-- API tokens card -->
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2 justify-between">
						<span class="flex items-center gap-2">
							<KeyRound class="w-5 h-5" />
							{m.profile_tokens_title()}
						</span>
						<Button variant="outline" size="sm" onclick={() => showApiTokenModal = true}>
							<Plus class="w-4 h-4 mr-1" />
							{m.profile_token_generate()}
						</Button>
					</Card.Title>
					<Card.Description>{m.profile_tokens_description()}</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if tokensLoading}
						<p class="text-sm text-muted-foreground">{m.profile_tokens_loading()}</p>
					{:else if apiTokens.length === 0}
						<p class="text-sm text-muted-foreground">{m.profile_tokens_empty()}</p>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head>{m.profile_tokens_col_name()}</Table.Head>
									<Table.Head>{m.profile_tokens_col_prefix()}</Table.Head>
									<Table.Head>{m.profile_tokens_col_last_used()}</Table.Head>
									<Table.Head>{m.profile_tokens_col_expires()}</Table.Head>
									<Table.Head class="w-[80px]"></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each apiTokens as token (token.id)}
									<Table.Row class={isTokenExpired(token.expiresAt) ? 'opacity-50' : ''}>
										<Table.Cell class="font-medium">{token.name}</Table.Cell>
										<Table.Cell>
											<code class="text-xs bg-muted px-1.5 py-0.5 rounded">dh_{token.tokenPrefix}...</code>
										</Table.Cell>
										<Table.Cell class="text-sm text-muted-foreground">
											{token.lastUsed ? formatDateTime(token.lastUsed) : m.profile_never()}
										</Table.Cell>
										<Table.Cell class="text-sm">
											{#if isTokenExpired(token.expiresAt)}
												<Badge variant="destructive">{m.profile_tokens_expired()}</Badge>
											{:else if token.expiresAt}
												{formatDateTime(token.expiresAt)}
											{:else}
												<span class="text-muted-foreground">{m.profile_never()}</span>
											{/if}
										</Table.Cell>
										<Table.Cell>
											<ConfirmPopover
												localized
												action={m.profile_confirm_action_revoke()}
												itemType={m.profile_item_token()}
												itemName={token.name}
												title={m.profile_token_revoke_title()}
												confirmText={m.profile_token_revoke()}
												onConfirm={() => revokeToken(token.id)}
											>
												<Button variant="ghost" size="sm" class="text-destructive hover:text-destructive">
													<Trash2 class="w-4 h-4" />
												</Button>
											</ConfirmPopover>
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
			</Card.Root>

			</div>

			<!-- Row 3: Appearance (left-aligned with Security) -->
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

			<!-- Appearance card -->
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Palette class="w-5 h-5" />
						{m.profile_appearance_title()}
					</Card.Title>
					<Card.Description>{m.profile_appearance_description()}</Card.Description>
				</Card.Header>
				<Card.Content class="space-y-4">
					<ThemeSelector userId={profile.id} />
					<LanguageSelector />
					<ColoredActionsToggle userId={profile.id} />
					<AnimateIconsToggle userId={profile.id} />
				<IndentGuidesToggle userId={profile.id} />
				</Card.Content>
			</Card.Root>

			<!-- Navigation card (per-user overrides) -->
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Compass class="w-5 h-5" />
						{m.profile_navigation_title()}
					</Card.Title>
					<Card.Description>{m.profile_navigation_description()}</Card.Description>
				</Card.Header>
				<Card.Content>
					<NavigationSelector scope="user" />
				</Card.Content>
			</Card.Root>

			</div>

			<!-- Editor theme on its own full-width row so the live preview isn't cramped. -->
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Palette class="w-5 h-5" />
						{m.profile_editor_theme_title()}
					</Card.Title>
					<Card.Description>{m.profile_editor_theme_description()}</Card.Description>
				</Card.Header>
				<Card.Content>
					<EditorThemeSelector userId={profile.id} />
				</Card.Content>
			</Card.Root>
		</div>
	{/if}
</div>

<!-- Change Password Modal -->
<ChangePasswordModal
	bind:open={showPasswordModal}
	onClose={() => showPasswordModal = false}
	onSuccess={showSuccessMessage}
/>

<!-- MFA Setup Modal -->
{#if profile}
	<MfaSetupModal
		bind:open={showMfaSetupModal}
		qrCode={mfaQrCode}
		secret={mfaSecret}
		userId={profile.id}
		onClose={() => showMfaSetupModal = false}
		onSuccess={handleMfaEnabled}
	/>

	<DisableMfaModal
		bind:open={showDisableMfaModal}
		userId={profile.id}
		onClose={() => showDisableMfaModal = false}
		onSuccess={handleMfaDisabled}
	/>
{/if}

<!-- API Token Modal -->
<ApiTokenModal
	bind:open={showApiTokenModal}
	onCreated={fetchApiTokens}
	provider={profile?.provider ?? 'local'}
/>

<!-- Avatar Cropper Modal -->
<AvatarCropper
	show={showAvatarCropper}
	imageUrl={imageForCrop}
	onCancel={cancelAvatarCrop}
	onSave={saveAvatar}
/>
