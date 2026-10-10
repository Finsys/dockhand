<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { toast } from 'svelte-sonner';
	import { Toaster } from '$lib/components/ui/sonner';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import ThemeToggle from '$lib/components/theme-toggle.svelte';
	import HostInfo from '$lib/components/host-info.svelte';
	import MainContent from '$lib/components/main-content.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import WhatsNewModal from '$lib/components/WhatsNewModal.svelte';
	import { SidebarProvider, SidebarTrigger } from '$lib/components/ui/sidebar';
	import { connectSSE, disconnectSSE } from '$lib/stores/events';
	import { currentEnvironment, environments } from '$lib/stores/environment';
	import { licenseStore, daysUntilExpiry, expiryMessage } from '$lib/stores/license';
	import { licenceHoldMessage } from '$lib/utils/licence-hold';
	import { get } from 'svelte/store';
	import { authStore } from '$lib/stores/auth';
	import { extractPath, isSessionExpiryCandidate } from '$lib/utils/session-expiry';
	import { themeStore, applyTheme } from '$lib/stores/theme';
	import { gridPreferencesStore } from '$lib/stores/grid-preferences';
	import { appSettings } from '$lib/stores/settings';
	import { shouldShowWhatsNew } from '$lib/utils/version';
	import { AlertTriangle, Search } from 'lucide-svelte';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { m } from '$lib/paraglide/messages.js';

	// Check if current route is login page (no sidebar needed)
	const isLoginPage = $derived($page.url.pathname === '/login');
	// Same for the OpenAPI docs viewer (Scalar) — it brings its own
	// full-page chrome. Matches with or without a trailing slash.
	const isDocsPage = $derived($page.url.pathname.replace(/\/$/, '') === '/api/docs/ui');
	const noSidebar = $derived(isLoginPage || isDocsPage);

	let { children, data } = $props();
	let envId = $state<number | null>(null);
	let commandPaletteOpen = $state(false);
	// Said once, at the top: a lapsed licence refuses every read, so each page would
	// otherwise report it separately as an empty table or a request that failed.
	const licenceHold = $derived(
		licenceHoldMessage({
			hasEnterpriseLicense: $licenseStore.hasEnterpriseLicense,
			isEnterprise: $licenseStore.isEnterprise,
			isAdmin: $authStore.user?.isAdmin ?? false,
			isAuthenticated: $authStore.authEnabled ? !!$authStore.user : false,
			loading: $licenseStore.loading || $authStore.loading
		})
	);



	// What's New modal state
	let showWhatsNewModal = $state(false);
	let changelog = $state<Array<{ version: string; date: string; changes: Array<{ type: string; text: string }> }>>([]);
	let lastSeenVersion = $state<string | null>(null);

	// App version from git tag (injected at build time)
	declare const __APP_VERSION__: string | null;
	const currentVersion = __APP_VERSION__;

	// Detect if Mac for keyboard hint
	const isMac = typeof navigator !== 'undefined' && navigator.platform?.toUpperCase().indexOf('MAC') >= 0;

	// Subscribe to environment changes using $effect
	$effect(() => {
		const env = $currentEnvironment;
		envId = env?.id ?? null;
	});

	// Initialize theme after auth state is known
	$effect(() => {
		if (!$authStore.loading) {
			// Use user-specific preferences if authenticated, otherwise global settings
			const userId = $authStore.authEnabled && $authStore.user ? $authStore.user.id : undefined;
			themeStore.init(userId);
		}
	});

	// Refresh environments when user becomes authenticated
	// This handles OIDC callback where login happens server-side
	let wasAuthenticated = $state(false);
	$effect(() => {
		if (!$authStore.loading && $authStore.authenticated && !wasAuthenticated) {
			environments.refresh();
		}
		if (!$authStore.loading) {
			wasAuthenticated = $authStore.authenticated;
		}
	});

	onMount(() => {
		// app.html ships lang="en"; tell the browser (and screen readers) the UI language
		document.documentElement.lang = getLocale();

		// Apply theme from localStorage immediately (for flash-free loading)
		applyTheme(themeStore.get());

		// Initialize grid preferences
		gridPreferencesStore.init();

		// Connect to SSE for real-time Docker events (global)
		connectSSE(envId);

		// Check enterprise license status, and again whenever somebody comes back to
		// the page - a licence activated elsewhere is only visible after asking again.
		licenseStore.check();
		const stopWatchingLicense = licenseStore.watchForChanges();

		// Check auth status
		authStore.check();

		// Redirect to the login page when the session expires mid-use (#1577): once auth is
		// enabled, a stale session makes every /api/* call return 401, but the UI otherwise
		// keeps showing the last page. Intercept fetch to catch that centrally, so we don't
		// have to touch every call site. A 401 is only treated as expiry after re-checking
		// the session with the server, so a proxied upstream-auth 401 (e.g. bad registry
		// credentials on /api/registry/image) doesn't wrongly log the user out.
		const originalFetch = window.fetch;
		let checkingExpiry = false; // dedupe concurrent 401s while the session re-check is in flight
		window.fetch = async (...args) => {
			const response = await originalFetch(...args);
			try {
				const path = extractPath(args[0], window.location.origin);
				if (
					isSessionExpiryCandidate(response.status, path) &&
					get(authStore).authEnabled &&
					!checkingExpiry &&
					window.location.pathname !== '/login'
				) {
					checkingExpiry = true;
					try {
						await authStore.check(); // confirm with the server whether the session is actually gone
						const auth = get(authStore);
						if (auth.authEnabled && !auth.authenticated && window.location.pathname !== '/login') {
							toast.error(m.layout_session_expired());
							goto('/login');
						}
					} finally {
						checkingExpiry = false;
					}
				}
			} catch {
				// URL parsing / check failures are non-fatal; never break the original response.
			}
			return response;
		};

		return () => {
			window.fetch = originalFetch;
			disconnectSSE();
			stopWatchingLicense();
		};
	});

	async function checkWhatsNew() {
		// Suppressed via DISABLE_WHATS_NEW env var or the "Show What's New" setting (#1235)
		if (data?.disableWhatsNew) return;
		if ($appSettings.showWhatsNew === false) return;
		if (browser && currentVersion && currentVersion !== 'unknown') {
			lastSeenVersion = localStorage.getItem('dockhand-whats-new-version');
			if (shouldShowWhatsNew(currentVersion, lastSeenVersion)) {
				try {
					const res = await fetch('/api/changelog');
					if (res.ok) {
						changelog = await res.json();
						showWhatsNewModal = true;
					}
				} catch {
					// Silently fail - don't show popup if changelog fetch fails
				}
			}
		}
	}

	function dismissWhatsNew() {
		showWhatsNewModal = false;
		if (browser && currentVersion) {
			localStorage.setItem('dockhand-whats-new-version', currentVersion);
		}
	}

	// Show What's New only after auth resolves — avoids leaking version info on login page (#717)
	let whatsNewChecked = false;
	$effect(() => {
		if (!whatsNewChecked && !$authStore.loading && (!$authStore.authEnabled || $authStore.authenticated)) {
			whatsNewChecked = true;
			checkWhatsNew();
		}
	});
</script>

<svelte:head>
	<link rel="icon" href="/logo_light.webp" />
	<title>{m.layout_page_title()}</title>
</svelte:head>

{#if noSidebar}
	<!-- Login page / OpenAPI docs viewer: no sidebar, no header -->
	{@render children?.()}
	<Toaster richColors position="bottom-right" />
{:else}
	<!-- Main app: full layout with sidebar -->
	<SidebarProvider>
		<AppSidebar />
		<MainContent>
			<header class="h-14 shrink-0 flex items-center justify-between gap-4 border-b bg-background px-4">
				<div class="flex items-center gap-2 min-w-0">
					<SidebarTrigger class="md:hidden shrink-0" />
					<HostInfo />
				</div>
				<div class="flex items-center gap-3 shrink-0">
					<button
						type="button"
						onclick={() => commandPaletteOpen = true}
						class="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground border rounded-md hover:bg-muted/50 transition-colors"
					>
						<Search class="w-3.5 h-3.5" />
						<span class="hidden sm:inline">{m.layout_search()}</span>
						<kbd class="pointer-events-none hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-2xs font-medium text-muted-foreground">
							{#if isMac}
								<span class="text-xs">⌘</span>
							{:else}
								<span class="text-xs">Ctrl</span>
							{/if}
							K
						</kbd>
					</button>
					{#if $expiryMessage}
						<a
							href="/settings?tab=license"
							class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors
								{!$licenseStore.isEnterprise || $daysUntilExpiry <= 7
									? 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
									: 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/50'}"
						>
							<AlertTriangle class="w-3.5 h-3.5" />
							{$expiryMessage}
						</a>
					{/if}
					<ThemeToggle />
				</div>
			</header>
			<div class="flex-1 min-h-0 h-[calc(100%-3.5rem)] overflow-auto py-2 px-3 flex flex-col">
				{#if licenceHold}
					<!-- A lapsed licence refuses every read at once, so each page would
					     otherwise show its own empty table or spinner and read as broken. -->
					<div class="flex items-start gap-2 mb-2 px-3 py-2 rounded-md border border-amber-500/40 bg-amber-100 text-amber-900 dark:bg-amber-900/25 dark:text-amber-300 flex-shrink-0">
						<AlertTriangle class="w-4 h-4 mt-0.5 flex-shrink-0" />
						<p class="text-xs">{licenceHold}</p>
					</div>
				{/if}
				{@render children?.()}
			</div>
		</MainContent>
	</SidebarProvider>

	<Toaster richColors position="bottom-right" />
	<CommandPalette bind:open={commandPaletteOpen} />
{/if}

{#if showWhatsNewModal && currentVersion}
	<WhatsNewModal
		bind:open={showWhatsNewModal}
		version={currentVersion}
		{lastSeenVersion}
		{changelog}
		onDismiss={dismissWhatsNew}
	/>
{/if}
