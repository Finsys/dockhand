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
		Palette
	} from 'lucide-svelte';
	import { authStore } from '$lib/stores/auth';
	import { formatDateTime } from '$lib/stores/settings';
	import * as Alert from '$lib/components/ui/alert';
	import AvatarCropper from '$lib/components/AvatarCropper.svelte';
	import * as Avatar from '$lib/components/ui/avatar';
	import ChangePasswordModal from './ChangePasswordModal.svelte';
	import MfaSetupModal from './MfaSetupModal.svelte';
	import DisableMfaModal from './DisableMfaModal.svelte';
	import ThemeSelector from '$lib/components/ThemeSelector.svelte';
	import { themeStore } from '$lib/stores/theme';
	import PageHeader from '$lib/components/PageHeader.svelte';

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
				formError = 'Please select an image file';
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
				error = data.error || 'Failed to load profile';
			}
		} catch (e) {
			error = 'Failed to load profile';
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
				formSuccess = 'Profile updated successfully';
				// Refresh auth store to update sidebar
				await authStore.check();
				setTimeout(() => formSuccess = '', 3000);
			} else {
				const data = await response.json();
				formError = data.error || 'Failed to update profile';
			}
		} catch (e) {
			formError = 'Failed to update profile';
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
				mfaError = data.error || 'Failed to setup MFA';
			}
		} catch (e) {
			mfaError = 'Failed to setup MFA';
		} finally {
			mfaLoading = false;
		}
	}

	async function handleMfaEnabled() {
		await fetchProfile();
		showSuccessMessage('MFA enabled successfully');
	}

	async function handleMfaDisabled() {
		await fetchProfile();
		showSuccessMessage('MFA disabled successfully');
	}

	function formatProfileDate(dateStr: string | null): string {
		if (!dateStr) return 'Never';
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
				formSuccess = 'Avatar updated successfully';
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
				formError = data.error || 'Failed to upload avatar';
			}
		} catch (e) {
			formError = 'Failed to upload avatar';
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
				formSuccess = 'Avatar removed successfully';
				await authStore.check();
				setTimeout(() => formSuccess = '', 3000);
			} else {
				const data = await response.json();
				formError = data.error || 'Failed to remove avatar';
			}
		} catch (e) {
			formError = 'Failed to remove avatar';
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
			}
		}
	});
</script>

<svelte:head>
	<title>Profile - Dockhand</title>
</svelte:head>

<div class="container mx-auto p-6 max-w-4xl">
	<div class="flex items-center gap-3 mb-6">
		<PageHeader icon={User} title="Profile" showConnection={false}>
			<p class="text-muted-foreground text-sm">Manage your account settings</p>
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

			<!-- Account info card -->
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<User class="w-5 h-5" />
						Account information
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
										title="Remove photo"
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
									<Label class="text-muted-foreground text-xs">Username</Label>
									<p class="font-medium">{profile.username}</p>
								</div>
								<div>
									<Label class="text-muted-foreground text-xs">Role</Label>
									<div class="flex items-center gap-2">
										{#if profile.isAdmin}
											<Badge variant="default" class="gap-1 rounded-sm">
												<Crown class="w-3 h-3" />
												Admin
											</Badge>
										{:else}
											<Badge variant="secondary" class="rounded-sm">User</Badge>
										{/if}
									</div>
								</div>
							</div>

							<div class="grid grid-cols-2 gap-4">
								<div>
									<Label class="text-muted-foreground text-xs">Created</Label>
									<p class="text-sm flex items-center gap-1">
										<Calendar class="w-3.5 h-3.5" />
										{formatProfileDate(profile.createdAt)}
									</p>
								</div>
								<div>
									<Label class="text-muted-foreground text-xs">Last login</Label>
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
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Mail class="w-5 h-5" />
						Profile details
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					{#if formError}
						<Alert.Root variant="destructive">
							<TriangleAlert class="h-4 w-4" />
							<Alert.Description>{formError}</Alert.Description>
						</Alert.Root>
					{/if}

					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-2">
							<Label>Display name</Label>
							<Input
								bind:value={formDisplayName}
								placeholder="Enter display name"
							/>
						</div>
						<div class="space-y-2">
							<Label>Email</Label>
							<Input
								type="email"
								bind:value={formEmail}
								placeholder="Enter email"
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
							Save changes
						</Button>
					</div>
				</Card.Content>
			</Card.Root>

			<!-- Security card -->
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Shield class="w-5 h-5" />
						Security
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<!-- Password - only show for local auth users -->
					{#if profile.provider === 'local'}
						<div class="flex items-center justify-between p-3 border rounded-lg">
							<div class="flex items-center gap-3">
								<Key class="w-5 h-5 text-muted-foreground" />
								<div>
									<p class="font-medium">Password</p>
									<p class="text-sm text-muted-foreground">Change your password</p>
								</div>
							</div>
							<Button variant="outline" onclick={() => showPasswordModal = true}>
								Change password
							</Button>
						</div>
					{:else}
						<div class="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
							<div class="flex items-center gap-3">
								<Key class="w-5 h-5 text-muted-foreground" />
								<div>
									<p class="font-medium">Password</p>
									<p class="text-sm text-muted-foreground">Managed by your SSO provider</p>
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
										<p class="font-medium">Two-factor authentication</p>
										{#if profile.mfaEnabled}
											<Badge variant="default" class="bg-green-500 gap-1 rounded-sm">
												<ShieldCheck class="w-3 h-3" />
												Enabled
											</Badge>
										{:else}
											<Badge variant="secondary" class="rounded-sm">Disabled</Badge>
										{/if}
									</div>
									<p class="text-sm text-muted-foreground">
										{#if profile.mfaEnabled}
											MFA is enabled for your account
										{:else}
											Add an extra layer of security
										{/if}
									</p>
								</div>
							</div>
							{#if profile.mfaEnabled}
								<Button variant="outline" onclick={() => showDisableMfaModal = true}>
									Disable MFA
								</Button>
							{:else}
								<Button onclick={setupMfa} disabled={mfaLoading}>
									{#if mfaLoading}
										<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
									{:else}
										<QrCode class="w-4 h-4" />
									{/if}
									Setup MFA
								</Button>
							{/if}
						</div>
					{:else}
						<div class="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
							<div class="flex items-center gap-3">
								<Smartphone class="w-5 h-5 text-muted-foreground" />
								<div>
									<p class="font-medium">Two-factor authentication</p>
									<p class="text-sm text-muted-foreground">Managed by your SSO provider</p>
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
				</Card.Content>
			</Card.Root>

			<!-- Appearance card -->
			<Card.Root>
				<Card.Header>
					<Card.Title class="flex items-center gap-2">
						<Palette class="w-5 h-5" />
						Appearance
					</Card.Title>
					<Card.Description>Customize the look of the application</Card.Description>
				</Card.Header>
				<Card.Content>
					<ThemeSelector userId={profile.id} />
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

<!-- Avatar Cropper Modal -->
<AvatarCropper
	show={showAvatarCropper}
	imageUrl={imageForCrop}
	onCancel={cancelAvatarCrop}
	onSave={saveAvatar}
/>
