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
	import { environments } from '$lib/stores/environment';
	import * as Alert from '$lib/components/ui/alert';
	import { themeStore, applyTheme } from '$lib/stores/theme';

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
	let selectedProvider = $state('local');
	let loadingProviders = $state(true);

	// Get redirect URL from query params
	const redirectUrl = $derived($page.url.searchParams.get('redirect') || '/');

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
			// Set default to first credential provider or first provider
			const defaultProvider = data.defaultProvider || 'local';
			selectedProvider = credentialProviders.find(p => p.id === defaultProvider)?.id || credentialProviders[0]?.id || 'local';
		} catch {
			providers = [{ id: 'local', name: 'Local', type: 'local' }];
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

		// Set error from URL if present
		if (urlError) {
			error = decodeURIComponent(urlError);
		}

		// Fetch providers first
		await fetchProviders();

		// Check if already authenticated
		await authStore.check();

		// If auth is disabled or already authenticated, redirect
		if (!$authStore.authEnabled || $authStore.authenticated) {
			goto(redirectUrl);
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
				error = result.error || 'Login failed';
				loading = false;
				return;
			}

			// Success - refresh environments (they were cleared during pre-login fetch) then redirect
			await environments.refresh();
			goto(redirectUrl);
		} catch (e) {
			error = 'An unexpected error occurred';
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
			error = 'Failed to initiate SSO login';
			ssoLoading = null;
		}
	}

	function getProviderIcon(type: 'local' | 'ldap' | 'oidc') {
		if (type === 'ldap') return Network;
		if (type === 'oidc') return KeyRound;
		return User;
	}
</script>

<svelte:head>
	<title>Login - Dockhand</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center bg-background p-4">
	<Card.Root class="w-full max-w-md">
		<Card.Header class="space-y-1 text-center">
			<div class="flex justify-center mb-4">
				<img
					src="/logo-light.webp"
					alt="Dockhand Logo"
					class="h-16 w-auto object-contain dark:hidden"
				/>
				<img
					src="/logo-dark.webp"
					alt="Dockhand Logo"
					class="h-16 w-auto object-contain hidden dark:block"
				/>
			</div>
			<Card.Title class="text-2xl font-bold">Welcome back</Card.Title>
			<Card.Description>
				{#if requiresMfa}
					Enter your two-factor authentication code
				{:else}
					Sign in to your Dockhand account
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

			<!-- SSO Buttons -->
			{#if hasOidcProviders && !requiresMfa}
				<div class="space-y-2 mb-4">
					{#each oidcProviders as provider}
						<Button
							variant="outline"
							class="w-full justify-start gap-3"
							onclick={() => handleSsoLogin(provider)}
							disabled={ssoLoading !== null}
						>
							{#if ssoLoading === provider.id}
								<Loader2 class="h-5 w-5 animate-spin" />
							{:else}
								<KeyRound class="h-5 w-5" />
							{/if}
							<span>Continue with {provider.name}</span>
						</Button>
					{/each}
				</div>

				{#if hasCredentialProviders}
					<div class="relative my-4">
						<div class="absolute inset-0 flex items-center">
							<span class="w-full border-t"></span>
						</div>
						<div class="relative flex justify-center text-xs uppercase">
							<span class="bg-card px-2 text-muted-foreground">or continue with</span>
						</div>
					</div>
				{/if}
			{/if}

			{#if hasCredentialProviders}
				<form onsubmit={handleSubmit} class="space-y-4">
					{#if !requiresMfa}
						{#if credentialProviders.length > 1}
							<div class="space-y-2">
								<Label>Sign in with</Label>
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
														Local account
													{:else if provider.type === 'ldap'}
														LDAP directory
													{:else}
														Single sign-on
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
							<Label for="username">Username</Label>
							<Input
								id="username"
								type="text"
								placeholder="Enter your username"
								bind:value={username}
								required
								disabled={loading}
								autocomplete="username"
							/>
						</div>

						<div class="space-y-2">
							<Label for="password">Password</Label>
							<Input
								id="password"
								type="password"
								placeholder="Enter your password"
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
								<span>Two-factor authentication required</span>
							</div>
							<Label for="mfaToken">Authentication code</Label>
							<Input
								id="mfaToken"
								type="text"
								placeholder="Enter code"
								bind:value={mfaToken}
								required
								disabled={loading}
								autocomplete="one-time-code"
								autofocus
							/>
							<p class="text-xs text-muted-foreground">
								Enter the 6-digit code from your authenticator app, or use a backup code
							</p>
						</div>
					{/if}

					<Button type="submit" class="w-full" disabled={loading}>
						{#if loading}
							<Loader2 class="mr-2 h-4 w-4 animate-spin" />
							{requiresMfa ? 'Verifying...' : 'Signing in...'}
						{:else}
							<LogIn class="mr-2 h-4 w-4" />
							{requiresMfa ? 'Verify' : 'Sign in'}
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
							Back to login
						</Button>
					{/if}
				</form>
			{/if}
		</Card.Content>

		<Card.Footer class="flex flex-col space-y-2 text-center text-sm text-muted-foreground">
			<p>Dockhand Docker Management</p>
		</Card.Footer>
	</Card.Root>
</div>
