<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { useSidebar } from '$lib/components/ui/sidebar';
	import {
		LayoutDashboard,
		Box,
		Layers,
		Images,
		ScrollText,
		HardDrive,
		Network,
		PanelLeftClose,
		PanelLeft,
		Download,
		Settings,
		Terminal,
		Info,
		Crown,
		LogOut,
		User,
		ClipboardList,
		Activity,
		Timer
	} from 'lucide-svelte';
	import { licenseStore } from '$lib/stores/license';
	import { authStore, hasAnyAccess } from '$lib/stores/auth';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as Tooltip from '$lib/components/ui/tooltip';

	const appVersion = __APP_VERSION__ || 'unknown';
	const buildCommit = __BUILD_COMMIT__ ?? null;

	import type { Permissions } from '$lib/stores/auth';

	// TypeScript interface for menu items
	interface MenuItem {
		href: string;
		Icon: typeof LayoutDashboard;
		label: string;
		// Permission resource required to see this menu item (enterprise only)
		// Show menu if user has ANY permission for this resource, or 'always' (no check)
		permission?: keyof Permissions | 'always';
		// If true, item is only visible with enterprise license
		enterpriseOnly?: boolean;
	}

	const currentPath = $derived($page.url.pathname);
	const sidebar = useSidebar();

	function isActive(path: string): boolean {
		if (path === '/') return currentPath === '/';
		return currentPath === path || currentPath.startsWith(`${path}/`);
	}

	async function handleLogout() {
		sidebar.setOpenMobile(false);
		await authStore.logout();
		goto('/login');
	}

	/**
	 * Check if a menu item should be visible based on permissions
	 * - Enterprise-only items require enterprise license
	 * - FREE edition: all non-enterprise items visible (no permission checks)
	 * - ENTERPRISE edition: check if user has ANY permission for the resource
	 */
	function canSeeMenuItem(item: MenuItem): boolean {
		// Enterprise-only items are hidden without enterprise license
		if (item.enterpriseOnly && !$licenseStore.isEnterprise) {
			return false;
		}

		// FREE edition or auth disabled = all items visible (except enterprise-only)
		if (!$licenseStore.isEnterprise || !$authStore.authEnabled) {
			return true;
		}

		// ENTERPRISE edition: check permissions
		// Admins see everything
		if ($authStore.user?.isAdmin) {
			return true;
		}

		// No permission specified = always visible
		if (!item.permission || item.permission === 'always') {
			return true;
		}

		// Check if user has ANY permission for this resource
		return $hasAnyAccess(item.permission);
	}

	const menuItems: readonly MenuItem[] = [
		{ href: '/', Icon: LayoutDashboard, label: 'Dashboard', permission: 'always' },
		{ href: '/containers', Icon: Box, label: 'Containers', permission: 'containers' },
		{ href: '/logs', Icon: ScrollText, label: 'Logs', permission: 'containers' },
		{ href: '/terminal', Icon: Terminal, label: 'Shell', permission: 'containers' },
		{ href: '/stacks', Icon: Layers, label: 'Stacks', permission: 'stacks' },
		{ href: '/images', Icon: Images, label: 'Images', permission: 'images' },
		{ href: '/volumes', Icon: HardDrive, label: 'Volumes', permission: 'volumes' },
		{ href: '/networks', Icon: Network, label: 'Networks', permission: 'networks' },
		{ href: '/registry', Icon: Download, label: 'Registry', permission: 'registries' },
		{ href: '/activity', Icon: Activity, label: 'Activity', permission: 'activity' },
		{ href: '/schedules', Icon: Timer, label: 'Schedules', permission: 'schedules' },
		{ href: '/audit', Icon: ClipboardList, label: 'Audit log', permission: 'audit_logs', enterpriseOnly: true },
		{ href: '/settings', Icon: Settings, label: 'Settings', permission: 'settings' }
	] as const;
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header class="overflow-visible flex items-center justify-center p-0">
		<!-- Expanded state: logo + collapse button -->
		<div class="relative flex items-center justify-center w-full group-data-[state=collapsed]:hidden">
			<a href="/" class="flex justify-center relative">
				<img src="/logo-light.webp" alt="Dockhand Logo" class="h-[52px] w-auto object-contain mt-2 mb-1 dark:hidden" style="filter: drop-shadow(1px 1px 2px rgba(0,0,0,0.3)) drop-shadow(-1px -1px 1px rgba(255,255,255,0.9));" />
				<img src="/logo-dark.webp" alt="Dockhand Logo" class="h-[52px] w-auto object-contain mt-2 mb-1 hidden dark:block" style="filter: drop-shadow(2px 2px 3px rgba(0,0,0,0.6)) drop-shadow(-1px -1px 1px rgba(255,255,255,0.2));" />
				{#if $licenseStore.isEnterprise}
					<Crown class="w-4 h-4 absolute top-0 -right-[6px] text-amber-500 fill-amber-400 drop-shadow-sm rotate-[20deg]" />
				{/if}
			</a>
			<button
				type="button"
				onclick={() => sidebar.toggle()}
				class="absolute right-1 p-1.5 rounded-md hover:bg-sidebar-accent text-gray-300 hover:text-gray-400 transition-colors"
				title="Collapse sidebar"
				aria-label="Collapse sidebar"
			>
				<PanelLeftClose class="w-4 h-4" aria-hidden="true" />
			</button>
		</div>
		<!-- Collapsed state: expand button only -->
		<button
			type="button"
			onclick={() => sidebar.toggle()}
			class="hidden group-data-[state=collapsed]:flex p-1.5 rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground transition-colors"
			title="Expand sidebar"
			aria-label="Expand sidebar"
		>
			<PanelLeft class="w-4 h-4" aria-hidden="true" />
		</button>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.Menu>
				{#each menuItems as item}
					{#if canSeeMenuItem(item)}
					<Sidebar.MenuItem>
						<Sidebar.MenuButton href={item.href} isActive={isActive(item.href)} tooltipContent={item.label} onclick={() => sidebar.setOpenMobile(false)}>
							<item.Icon aria-hidden="true" />
							<span class="group-data-[state=collapsed]:hidden">{item.label}</span>
						</Sidebar.MenuButton>
					</Sidebar.MenuItem>
					{/if}
				{/each}
			</Sidebar.Menu>
		</Sidebar.Group>
	</Sidebar.Content>

	<!-- Version (expanded sidebar only) -->
	<div class="group-data-[state=collapsed]:hidden px-3 py-2 mt-auto text-center">
		<Tooltip.Root>
			<Tooltip.Trigger>
				<span class="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-default">
					{appVersion}
				</span>
			</Tooltip.Trigger>
			<Tooltip.Content side="top" align="start" sideOffset={8} class="text-xs">
				<div class="space-y-0.5">
					<div class="flex items-center gap-1.5"><svg class="w-4 h-4 shrink-0" viewBox="0 0 24 18" fill="currentColor"><path d="M23.76 8.68c-.26-.18-.86-.58-1.53-.58-.24 0-.48.04-.72.12-.12-.84-.68-1.56-1.34-2.14l-.28-.22-.24.26c-.28.34-.48.72-.56 1.14-.1.42-.06.82.1 1.2-.42.22-.88.36-1.32.42-.24.04-.48.06-.72.06H.78a.77.77 0 0 0-.78.78c-.02 1.46.22 2.9.72 4.24.56 1.44 1.4 2.5 2.5 3.16 1.26.74 3.32 1.16 5.64 1.16.98 0 2-.1 2.98-.3a11.5 11.5 0 0 0 3.3-1.3 9.67 9.67 0 0 0 2.54-2.34c1.16-1.42 1.86-3.02 2.34-4.38h.2c1.22 0 1.98-.48 2.4-.9.28-.26.5-.58.64-.94l.08-.24-.28-.2zM2.74 8.84H4.7c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18H2.74c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.72 0h1.96c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18H5.46c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 0h1.96c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18H8.22c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 0h1.96c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18h-1.96c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zM5.46 6.2h1.96c.1 0 .18-.08.18-.18V4.38c0-.1-.08-.18-.18-.18H5.46c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 0h1.96c.1 0 .18-.08.18-.18V4.38c0-.1-.08-.18-.18-.18H8.22c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 0h1.96c.1 0 .18-.08.18-.18V4.38c0-.1-.08-.18-.18-.18h-1.96c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm0-2.64h1.96c.1 0 .18-.08.18-.18V1.74c0-.1-.08-.18-.18-.18h-1.96c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 5.28h1.96c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18h-1.96c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18z"/></svg><span class="font-mono">fnsys/dockhand:{appVersion}</span></div>
					{#if buildCommit}
						<div>Commit: <span class="font-mono">{buildCommit.slice(0, 7)}</span></div>
					{/if}
				</div>
			</Tooltip.Content>
		</Tooltip.Root>
	</div>

	<!-- User info footer (only when auth is enabled) -->
	{#if $authStore.authEnabled && $authStore.authenticated && $authStore.user}
		<Sidebar.Footer class="border-t">
			<Sidebar.Menu>
				<Sidebar.MenuItem>
					<a
						href="/profile"
						onclick={() => sidebar.setOpenMobile(false)}
						class="flex items-center gap-2 px-2 py-1.5 group-data-[state=collapsed]:px-1 group-data-[state=collapsed]:py-1 rounded-md hover:bg-sidebar-accent transition-colors group-data-[state=collapsed]:justify-center"
						title="View profile"
					>
						<Avatar.Root class="w-8 h-8 group-data-[state=collapsed]:w-6 group-data-[state=collapsed]:h-6 shrink-0 transition-all">
							<Avatar.Image src={$authStore.user.avatar} alt={$authStore.user.username} />
							<Avatar.Fallback class="bg-primary/10 text-primary text-xs">
								{($authStore.user.displayName || $authStore.user.username)?.slice(0, 2).toUpperCase()}
							</Avatar.Fallback>
						</Avatar.Root>
						<div class="flex flex-col min-w-0 group-data-[state=collapsed]:hidden">
							<span class="text-sm font-medium truncate">{$authStore.user.displayName || $authStore.user.username}</span>
							<span class="text-xs text-muted-foreground truncate">{$authStore.user.isAdmin ? 'Admin' : 'User'}</span>
						</div>
					</a>
				</Sidebar.MenuItem>
				<Sidebar.MenuItem>
					<button
						type="button"
						onclick={handleLogout}
						class="flex items-center gap-2 w-full px-2 py-1.5 group-data-[state=collapsed]:px-1 group-data-[state=collapsed]:py-1 text-sm text-muted-foreground hover:text-foreground hover:bg-sidebar-accent rounded-md transition-colors group-data-[state=collapsed]:justify-center"
						title="Sign out"
					>
						<LogOut class="w-4 h-4 shrink-0 group-data-[state=collapsed]:w-3.5 group-data-[state=collapsed]:h-3.5" />
						<span class="group-data-[state=collapsed]:hidden">Sign out</span>
					</button>
				</Sidebar.MenuItem>
			</Sidebar.Menu>
		</Sidebar.Footer>
	{/if}
</Sidebar.Root>
