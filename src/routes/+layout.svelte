<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
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
	import { licenseStore, daysUntilExpiry } from '$lib/stores/license';
	import { authStore } from '$lib/stores/auth';
	import { themeStore, applyTheme } from '$lib/stores/theme';
	import { gridPreferencesStore } from '$lib/stores/grid-preferences';
	import { shouldShowWhatsNew } from '$lib/utils/version';
	import { AlertTriangle, Search } from 'lucide-svelte';

	// Check if current route is login page (no sidebar needed)
	const isLoginPage = $derived($page.url.pathname === '/login');

	let { children } = $props();
	let envId = $state<number | null>(null);
	let commandPaletteOpen = $state(false);

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
		// Apply theme from localStorage immediately (for flash-free loading)
		applyTheme(themeStore.get());

		// Initialize grid preferences
		gridPreferencesStore.init();

		// Connect to SSE for real-time Docker events (global)
		connectSSE(envId);

		// Check enterprise license status
		licenseStore.check();

		// Check auth status
		authStore.check();

		// Check What's New popup
		checkWhatsNew();

		return () => {
			disconnectSSE();
		};
	});

	async function checkWhatsNew() {
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
</script>

<svelte:head>
	<link rel="icon" href="/logo_light.webp" />
	<title>Dockhand - Docker Management</title>
</svelte:head>

{#if isLoginPage}
	<!-- Login page: no sidebar, no header -->
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
						<span class="hidden sm:inline">Search...</span>
						<kbd class="pointer-events-none hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-2xs font-medium text-muted-foreground">
							{#if isMac}
								<span class="text-xs">⌘</span>
							{:else}
								<span class="text-xs">Ctrl</span>
							{/if}
							K
						</kbd>
					</button>
					{#if $licenseStore.isEnterprise && $daysUntilExpiry !== null && $daysUntilExpiry <= 30}
						<a
							href="/settings?tab=license"
							class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors
								{$daysUntilExpiry <= 7
									? 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
									: 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/50'}"
						>
							<AlertTriangle class="w-3.5 h-3.5" />
							{#if $daysUntilExpiry <= 0}
								License expired
							{:else if $daysUntilExpiry === 1}
								License expires tomorrow
							{:else}
								License expires in {$daysUntilExpiry} days
							{/if}
						</a>
					{/if}
					<ThemeToggle />
				</div>
			</header>
			<div class="flex-1 min-h-0 h-[calc(100%-3.5rem)] overflow-auto py-2 px-3 flex flex-col">
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
