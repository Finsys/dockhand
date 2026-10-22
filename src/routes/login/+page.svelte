<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Card from '$lib/components/ui/card';
	import { Loader2, LogIn, Shield, AlertCircle, Network, User, KeyRound, TriangleAlert } from 'lucide-svelte';
	import { authStore } from '$lib/stores/auth';
	import { autoLoginTarget } from '$lib/utils/oidc-autologin';
	import { environments } from '$lib/stores/environment';
	import { appSettings } from '$lib/stores/settings';
	import * as Alert from '$lib/components/ui/alert';
	import { themeStore, applyTheme } from '$lib/stores/theme';
	import { safeRedirectOrRoot } from '$lib/utils/safe-redirect';
	import { startAuthentication } from '@simplewebauthn/browser';
	import { m } from '$lib/paraglide/messages.js';

	interface AuthProvider {
		id: string;
		name: string;
		type: 'local' | 'ldap' | 'oidc';
		initiateUrl?: string;
	}

	let username = $state('');
	let password = $state('');
	let mfaToken = $state('');
	let loading = $state(false);
	let ssoLoading = $state<string | null>(null);
	let error = $state<string | null>(null);
	let requiresMfa = $state(false);
	let providers = $state<AuthProvider[]>([]);
	// Set by the server when OIDC_AUTOLOGIN is on and there is exactly one provider.
	let autoLoginUrl = $state<string | null>(null);
	let selectedProvider = $state('local');
	let loadingProviders = $state(true);
	let passkeyLoading = $state(false);
	// Offered only when an administrator allows it and ORIGIN supports a ceremony.
	let passkeysOffered = $state(false);

	// Get redirect URL from query params (validated path-relative only)
	const redirectUrl = $derived(safeRedirectOrRoot($page.url.searchParams.get('redirect')));

	// Get error from query params (from OIDC callback)
	const urlError = $derived($page.url.searchParams.get('error'));

	// Check if there are multiple providers available
	const hasMultipleProviders = $derived(providers.length > 1);

	// Separate OIDC providers for SSO buttons
	const oidcProviders = $derived(providers.filter(p => p.type === 'oidc'));
	const credentialProviders = $derived(providers.filter(p => p.type !== 'oidc'));
	const hasOidcProviders = $derived(oidcProviders.length > 0);
	const hasCredentialProviders = $derived(credentialProviders.length > 0);

	async function fetchProviders() {
		try {
			const response = await fetch('/api/auth/providers');
			const data = await response.json();
			providers = data.providers || [{ id: 'local', name: 'Local', type: 'local' }];
			passkeysOffered = data.passkeys === true;
			autoLoginUrl = data.autoLoginUrl ?? null;
			// Set default to first credential provider or first provider
			const defaultProvider = data.defaultProvider || 'local';
			selectedProvider = credentialProviders.find(p => p.id === defaultProvider)?.id || credentialProviders[0]?.id || 'local';
		} catch {
			providers = [{ id: 'local', name: 'Local', type: 'local' }];
			passkeysOffered = false;
		} finally {
			loadingProviders = false;
		}
	}

	onMount(async () => {
		// Set dark mode class based on saved preference or system preference
		// This must happen before applyTheme since applyTheme reads the dark class
		const savedTheme = localStorage.getItem('theme');
		const prefersDark = savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches);
		if (prefersDark) {
			document.documentElement.classList.add('dark');
		} else {
			document.documentElement.classList.remove('dark');
		}

		// Apply theme from localStorage immediately (for flash-free loading)
		applyTheme(themeStore.get());

		// Initialize theme from app settings (no user yet, so fetches from /api/settings/theme)
		await themeStore.init();

		// searchParams.get() has already decoded this. Decoding again throws on a
		// literal '%' - which an identity provider is free to put in the reason it
		// refused a sign-in - and that throw lands before the providers are fetched,
		// leaving a login page with no way to sign in at all.
		if (urlError) {
			error = urlError;
		}

		// Fetch providers first
		await fetchProviders();

		// Check if already authenticated
		await authStore.check();

		// If auth is disabled or already authenticated, redirect
		if (!$authStore.authEnabled || $authStore.authenticated) {
			goto(redirectUrl);
			return;
		}

		// Go straight to the provider when the operator asked for it. The rules for
		// when NOT to are the tested ones in autoLoginTarget, so the ways out of a
		// broken provider live in one place rather than being restated here.
		const target = autoLoginTarget({
			enabled: !!autoLoginUrl,
			oidcInitiateUrls: autoLoginUrl ? [autoLoginUrl] : [],
			error,
			localRequested: $page.url.searchParams.get('local') === '1'
		});
		if (target) {
			window.location.href = `${target}?redirect=${encodeURIComponent(redirectUrl)}`;
		}
	});

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = null;
		loading = true;

		try {
			const result = await authStore.login(username, password, requiresMfa ? mfaToken : undefined, selectedProvider);

			if (result.requiresMfa && !requiresMfa) {
				requiresMfa = true;
				loading = false;
				return;
			}

			if (!result.success) {
				error = result.error || m.login_error_failed();
				loading = false;
				return;
			}

			// Success - refresh settings and environments (they were fetched before auth) then redirect
			await appSettings.refresh();
			await environments.refresh();
			goto(redirectUrl);
		} catch (e) {
			error = m.login_error_unexpected();
			loading = false;
		}
	}

	async function handleSsoLogin(provider: AuthProvider) {
		if (!provider.initiateUrl) return;

		ssoLoading = provider.id;
		error = null;

		try {
			// Redirect to OIDC initiate endpoint with redirect URL
			const initiateUrl = `${provider.initiateUrl}?redirect=${encodeURIComponent(redirectUrl)}`;
			window.location.href = initiateUrl;
		} catch (e) {
			error = m.login_error_sso_initiate();
			ssoLoading = null;
		}
	}

	async function handlePasskeyLogin() {
		passkeyLoading = true;
		error = null;
		try {
			const optionsResponse = await fetch('/api/auth/passkeys/login/options', { method: 'POST' });
			const optionsData = await optionsResponse.json();
			if (!optionsResponse.ok) throw new Error(optionsData.error || m.login_error_passkey_unavailable());

			const authenticationResponse = await startAuthentication({ optionsJSON: optionsData.options });
			const verifyResponse = await fetch('/api/auth/passkeys/login/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ceremonyId: optionsData.ceremonyId, response: authenticationResponse })
			});
			const verifyData = await verifyResponse.json();
			if (!verifyResponse.ok || !verifyData.success) throw new Error(verifyData.error || m.login_error_passkey_failed());

			await authStore.check();
			await appSettings.refresh();
			await environments.refresh();
			goto(redirectUrl);
		} catch (e) {
			error = e instanceof Error && e.name !== 'NotAllowedError'
				? e.message
				: m.login_error_passkey_cancelled();
		} finally {
			passkeyLoading = false;
		}
	}

	function getProviderIcon(type: 'local' | 'ldap' | 'oidc') {
		if (type === 'ldap') return Network;
		if (type === 'oidc') return KeyRound;
		return User;
	}
</script>

<svelte:head>
	<title>{m.login_page_title()}</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
	<Card.Root class="w-full max-w-md">
		<Card.Header class="space-y-1 text-center">
			<div class="flex justify-center mb-4">
				<img
					src="/logo.svg"
					alt={m.sidebar_logo_alt()}
					class="h-16 w-auto object-contain"
				/>
			</div>
			<Card.Title class="text-2xl font-bold">{m.login_welcome_back()}</Card.Title>
			<Card.Description>
				{#if requiresMfa}
					{m.login_mfa_prompt()}
				{:else}
					{m.login_subtitle()}
				{/if}
			</Card.Description>
		</Card.Header>

		<Card.Content>
			{#if error}
				<Alert.Root variant="destructive" class="mb-4">
					<TriangleAlert class="h-4 w-4" />
					<Alert.Description>{error}</Alert.Description>
				</Alert.Root>
			{/if}

			{#if passkeysOffered && !requiresMfa}
				<Button
					variant="outline"
					class="w-full justify-center gap-3 mb-4"
					onclick={handlePasskeyLogin}
					disabled={passkeyLoading || loading || ssoLoading !== null}
				>
					{#if passkeyLoading}
						<Loader2 class="h-5 w-5 animate-spin" />
					{:else}
						<KeyRound class="h-5 w-5" />
					{/if}
					<span>{m.login_passkey_button()}</span>
				</Button>
			{/if}

			<!-- SSO Buttons -->
			{#if hasOidcProviders && !requiresMfa}
				<div class="space-y-2 mb-4">
					{#each oidcProviders as provider}
						<Button
							variant="outline"
							class="w-full justify-center gap-3"
							onclick={() => handleSsoLogin(provider)}
							disabled={ssoLoading !== null}
						>
							{#if ssoLoading === provider.id}
								<Loader2 class="h-5 w-5 animate-spin" />
							{:else}
								<KeyRound class="h-5 w-5" />
							{/if}
							<span>{m.login_continue_with_provider({ provider: provider.name })}</span>
						</Button>
					{/each}
				</div>

				{#if hasCredentialProviders}
					<div class="relative my-4">
						<div class="absolute inset-0 flex items-center">
							<span class="w-full border-t"></span>
						</div>
						<div class="relative flex justify-center text-xs uppercase">
							<span class="bg-card px-2 text-muted-foreground">{m.login_or_continue_with()}</span>
						</div>
					</div>
				{/if}
			{/if}

			{#if hasCredentialProviders}
				<form onsubmit={handleSubmit} class="space-y-4">
					{#if !requiresMfa}
						{#if credentialProviders.length > 1}
							<div class="space-y-2">
								<Label>{m.login_sign_in_with()}</Label>
								<div class="grid gap-2">
									{#each credentialProviders as provider}
										{@const Icon = getProviderIcon(provider.type)}
										<button
											type="button"
											class="flex items-center gap-3 w-full p-3 rounded-md border transition-colors text-left {selectedProvider === provider.id
												? 'border-primary bg-primary/5 text-primary'
												: 'border-border hover:border-muted-foreground/50 hover:bg-muted/50'}"
											onclick={() => selectedProvider = provider.id}
											disabled={loading}
										>
											<Icon class="h-5 w-5 shrink-0" />
											<div class="flex-1 min-w-0">
												<div class="font-medium text-sm">{provider.name}</div>
												<div class="text-xs text-muted-foreground">
													{#if provider.type === 'local'}
														{m.login_provider_local()}
													{:else if provider.type === 'ldap'}
														{m.login_provider_ldap()}
													{:else}
														{m.login_provider_sso()}
													{/if}
												</div>
											</div>
											{#if selectedProvider === provider.id}
												<div class="w-2 h-2 rounded-full bg-primary"></div>
											{/if}
										</button>
									{/each}
								</div>
							</div>
						{/if}

						<div class="space-y-2">
							<Label for="username">{m.login_username_label()}</Label>
							<Input
								id="username"
								type="text"
								placeholder={m.login_username_placeholder()}
								bind:value={username}
								required
								disabled={loading}
								autocomplete="username"
								autofocus
							/>
						</div>

						<div class="space-y-2">
							<Label for="password">{m.login_password_label()}</Label>
							<Input
								id="password"
								type="password"
								placeholder={m.login_password_placeholder()}
								bind:value={password}
								required
								disabled={loading}
								autocomplete="current-password"
							/>
						</div>
					{:else}
						<div class="space-y-2">
							<div class="flex items-center gap-2 text-sm text-muted-foreground mb-4">
								<Shield class="h-4 w-4" />
								<span>{m.login_mfa_required()}</span>
							</div>
							<Label for="mfaToken">{m.login_mfa_code_label()}</Label>
							<Input
								id="mfaToken"
								name="totp"
								type="text"
								placeholder={m.login_mfa_code_placeholder()}
								bind:value={mfaToken}
								required
								disabled={loading}
								autocomplete="one-time-code"
								autofocus
							/>
							<p class="text-xs text-muted-foreground">
								{m.login_mfa_code_hint()}
							</p>
						</div>
					{/if}

					<Button type="submit" class="w-full" disabled={loading}>
						{#if loading}
							<Loader2 class="mr-2 h-4 w-4 animate-spin" />
							{requiresMfa ? m.login_verifying() : m.login_signing_in()}
						{:else}
							<LogIn class="mr-2 h-4 w-4" />
							{requiresMfa ? m.login_verify() : m.login_sign_in()}
						{/if}
					</Button>

					{#if requiresMfa}
						<Button
							type="button"
							variant="ghost"
							class="w-full"
							onclick={() => {
								requiresMfa = false;
								mfaToken = '';
								error = null;
							}}
						>
							{m.login_back_to_login()}
						</Button>
					{/if}
				</form>
			{/if}
		</Card.Content>

		<Card.Footer class="flex flex-col space-y-2 text-center text-sm text-muted-foreground">
			<p>{m.login_footer()}</p>
		</Card.Footer>
	</Card.Root>
</div>
