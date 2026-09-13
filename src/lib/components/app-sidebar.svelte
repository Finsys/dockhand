<script lang="ts">
	import { onMount } from 'svelte';
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
		Timer,
		Archive,
		LibraryBig,
		CircleArrowUp,
		Pencil,
		Check,
		GripVertical,
		Eye,
		EyeOff,
		RotateCcw
	} from 'lucide-svelte';
	import { flip } from 'svelte/animate';
	import { licenseStore } from '$lib/stores/license';
	import { authStore, hasAnyAccess } from '$lib/stores/auth';
	import { selfUpdate } from '$lib/stores/self-update';
	import { appSettings } from '$lib/stores/settings';
	import { sidebarPreferencesStore, orderItems } from '$lib/stores/sidebar-preferences';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as Tooltip from '$lib/components/ui/tooltip';

	const appVersion = __APP_VERSION__ || 'unknown';
	const buildCommit = __BUILD_COMMIT__ ?? null;

	onMount(() => {
		// One-shot Dockhand update check (#1146). Result is cached for the
		// browser session — the Settings → About page reads the same store.
		selfUpdate.checkOnce();
		sidebarPreferencesStore.init();
	});

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
		// The Dashboard link carries a ?home marker; compare on the path only.
		const p = path.split('?')[0];
		if (p === '/') return currentPath === '/';
		return currentPath === p || currentPath.startsWith(`${p}/`);
	}

	async function handleLogout() {
		sidebar.setOpenMobile(false);
		// Per-user layout must not leak to the next user on this browser
		sidebarPreferencesStore.clearLocal();
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
		// BETA GATE: hide Backups unless FEAT_BACKUPS_ENABLED is on (see features.ts)
		if (item.href === '/backups' && !$page.data.backupsEnabled) {
			return false;
		}

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
		{ href: '/?home', Icon: LayoutDashboard, label: 'Dashboard', permission: 'always' },
		{ href: '/containers', Icon: Box, label: 'Containers', permission: 'containers' },
		{ href: '/logs', Icon: ScrollText, label: 'Logs', permission: 'containers' },
		{ href: '/terminal', Icon: Terminal, label: 'Shell', permission: 'containers' },
		{ href: '/stacks', Icon: Layers, label: 'Stacks', permission: 'stacks' },
		{ href: '/images', Icon: Images, label: 'Images', permission: 'images' },
		{ href: '/volumes', Icon: HardDrive, label: 'Volumes', permission: 'volumes' },
		{ href: '/networks', Icon: Network, label: 'Networks', permission: 'networks' },
		{ href: '/templates', Icon: LibraryBig, label: 'Templates', permission: 'templates' },
		{ href: '/registry', Icon: Download, label: 'Registry', permission: 'registries' },
		{ href: '/activity', Icon: Activity, label: 'Activity', permission: 'activity' },
		{ href: '/backups', Icon: Archive, label: 'Backups', permission: 'backups' },
		{ href: '/schedules', Icon: Timer, label: 'Schedules', permission: 'schedules' },
		{ href: '/audit', Icon: ClipboardList, label: 'Audit log', permission: 'audit_logs', enterpriseOnly: true },
		{ href: '/settings', Icon: Settings, label: 'Settings', permission: 'settings' }
	] as const;

	// --- Sidebar customization (#1252): reorder + hide/show menu items ---

	let editMode = $state(false);
	let dragHref = $state<string | null>(null);
	// Order buffer while dragging - persisted once on drop, not per dragover
	let draftOrder = $state<string[] | null>(null);

	// Full menu (incl. permission-hidden items) in the user's saved order,
	// so reordering never loses positions of items the user can't see.
	const orderedItems = $derived(orderItems(menuItems, draftOrder ?? $sidebarPreferencesStore.order));
	const hiddenSet = $derived(new Set($sidebarPreferencesStore.hidden));
	// Permission filter first, then user-hidden filter
	const editableItems = $derived(orderedItems.filter(canSeeMenuItem));
	const visibleItems = $derived(editableItems.filter((item) => !hiddenSet.has(item.href)));

	// Edit mode only makes sense expanded - exit when the sidebar collapses
	$effect(() => {
		if (sidebar.state === 'collapsed' && editMode) {
			editMode = false;
		}
	});

	function persist(order: string[]) {
		sidebarPreferencesStore.save({ order, hidden: [...hiddenSet] });
	}

	function toggleHidden(href: string) {
		const hidden = new Set(hiddenSet);
		if (hidden.has(href)) {
			hidden.delete(href);
		} else {
			hidden.add(href);
		}
		sidebarPreferencesStore.save({ order: orderedItems.map((i) => i.href), hidden: [...hidden] });
	}

	/**
	 * Place fromHref before/after toHref in the full order list.
	 * No-ops when the result wouldn't change, which keeps dragover
	 * events from thrashing the list while the pointer hovers a row.
	 */
	function moveTo(fromHref: string, toHref: string, before: boolean) {
		const current = orderedItems.map((i) => i.href);
		if (!current.includes(fromHref) || !current.includes(toHref)) return;
		const order = current.filter((h) => h !== fromHref);
		const insertAt = order.indexOf(toHref) + (before ? 0 : 1);
		order.splice(insertAt, 0, fromHref);
		if (order.join('\n') !== current.join('\n')) {
			draftOrder = order;
		}
	}

	function moveBy(href: string, delta: -1 | 1) {
		const visible = editableItems.map((i) => i.href);
		const from = visible.indexOf(href);
		const to = from + delta;
		if (to < 0 || to >= visible.length) return;
		moveTo(href, visible[to], delta < 0);
		if (draftOrder) {
			persist(draftOrder);
			draftOrder = null;
		}
	}

	function endDrag() {
		if (draftOrder) {
			persist(draftOrder);
			draftOrder = null;
		}
		dragHref = null;
	}

	// Transparent 1x1 drag image: suppresses the browser's ghost snapshot so
	// the flip animation of the list itself reads as the drag movement.
	let ghostImg: HTMLImageElement | null = null;
	function transparentGhost(): HTMLImageElement {
		if (!ghostImg) {
			ghostImg = new Image(1, 1);
			ghostImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
		}
		return ghostImg;
	}
</script>

{#snippet versionTooltip()}
	<div class="space-y-0.5 text-left">
		<div class="flex items-center gap-1.5"><svg class="w-4 h-4 shrink-0" viewBox="0 0 24 18" fill="currentColor"><path d="M23.76 8.68c-.26-.18-.86-.58-1.53-.58-.24 0-.48.04-.72.12-.12-.84-.68-1.56-1.34-2.14l-.28-.22-.24.26c-.28.34-.48.72-.56 1.14-.1.42-.06.82.1 1.2-.42.22-.88.36-1.32.42-.24.04-.48.06-.72.06H.78a.77.77 0 0 0-.78.78c-.02 1.46.22 2.9.72 4.24.56 1.44 1.4 2.5 2.5 3.16 1.26.74 3.32 1.16 5.64 1.16.98 0 2-.1 2.98-.3a11.5 11.5 0 0 0 3.3-1.3 9.67 9.67 0 0 0 2.54-2.34c1.16-1.42 1.86-3.02 2.34-4.38h.2c1.22 0 1.98-.48 2.4-.9.28-.26.5-.58.64-.94l.08-.24-.28-.2zM2.74 8.84H4.7c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18H2.74c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.72 0h1.96c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18H5.46c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 0h1.96c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18H8.22c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 0h1.96c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18h-1.96c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zM5.46 6.2h1.96c.1 0 .18-.08.18-.18V4.38c0-.1-.08-.18-.18-.18H5.46c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 0h1.96c.1 0 .18-.08.18-.18V4.38c0-.1-.08-.18-.18-.18H8.22c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 0h1.96c.1 0 .18-.08.18-.18V4.38c0-.1-.08-.18-.18-.18h-1.96c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm0-2.64h1.96c.1 0 .18-.08.18-.18V1.74c0-.1-.08-.18-.18-.18h-1.96c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18zm2.76 5.28h1.96c.1 0 .18-.08.18-.18V7.02c0-.1-.08-.18-.18-.18h-1.96c-.1 0-.18.08-.18.18v1.64c0 .1.08.18.18.18z"/></svg><span class="font-mono">fnsys/dockhand:{appVersion}</span></div>
		{#if buildCommit}
			<div>Commit: <span class="font-mono">{buildCommit.slice(0, 7)}</span></div>
		{/if}
		{#if $selfUpdate.updateAvailable && $selfUpdate.latestVersion}
			<div class="flex items-center gap-1.5 pt-1 text-amber-500">
				<CircleArrowUp class="w-3.5 h-3.5 shrink-0" />
				Update available: <span class="font-mono">v{$selfUpdate.latestVersion}</span>
			</div>
		{/if}
	</div>
{/snippet}

<Sidebar.Root collapsible="icon">
	<Sidebar.Header class="overflow-visible flex items-center justify-center p-0">
		<!-- Expanded state: logo + collapse button -->
		<div class="relative flex items-center justify-center w-full group-data-[state=collapsed]:hidden">
			<a href="/?home" class="flex justify-center relative">
				<img src="/logo.svg" alt="Dockhand Logo" class="h-[52px] w-auto object-contain mt-2 mb-1" />
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
				{#each editMode ? editableItems : visibleItems as item (item.href)}
					<li class="group/menu-item relative" animate:flip={{ duration: 200 }}>
						{#if editMode}
							<div
								role="listitem"
								class="flex items-center gap-1.5 px-1.5 py-1 rounded-md text-xs select-none transition-opacity
									{hiddenSet.has(item.href) ? 'opacity-40' : ''}
									{dragHref === item.href ? 'opacity-30 bg-sidebar-accent' : ''}"
								draggable="true"
								ondragstart={(e) => {
									dragHref = item.href;
									if (e.dataTransfer) {
										e.dataTransfer.effectAllowed = 'move';
										// Safari won't start a drag without data
										e.dataTransfer.setData('text/plain', item.href);
										e.dataTransfer.setDragImage(transparentGhost(), 0, 0);
									}
								}}
								ondragover={(e) => {
									e.preventDefault();
									if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
									if (!dragHref || dragHref === item.href) return;
									// Only reorder when the pointer is past the row midpoint,
									// so a hover near the boundary doesn't flip back and forth
									const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
									const before = e.clientY < rect.top + rect.height / 2;
									moveTo(dragHref, item.href, before);
								}}
								ondrop={(e) => e.preventDefault()}
								ondragend={endDrag}
							>
								<button
									type="button"
									class="cursor-grab text-muted-foreground/60 hover:text-foreground focus:outline-none focus-visible:text-foreground"
									aria-label="Reorder {item.label}"
									title="Drag to reorder (or use arrow keys)"
									onkeydown={(e) => {
										if (e.key === 'ArrowUp') { e.preventDefault(); moveBy(item.href, -1); }
										if (e.key === 'ArrowDown') { e.preventDefault(); moveBy(item.href, 1); }
									}}
								>
									<GripVertical class="w-3 h-3" />
								</button>
								<item.Icon class="!w-3.5 !h-3.5 shrink-0" aria-hidden="true" />
								<span class="flex-1 truncate">{item.label}</span>
								<button
									type="button"
									class="text-muted-foreground/60 hover:text-foreground transition-colors"
									title={hiddenSet.has(item.href) ? `Show ${item.label}` : `Hide ${item.label}`}
									aria-label={hiddenSet.has(item.href) ? `Show ${item.label}` : `Hide ${item.label}`}
									onclick={() => toggleHidden(item.href)}
								>
									{#if hiddenSet.has(item.href)}
										<EyeOff class="w-3 h-3" />
									{:else}
										<Eye class="w-3 h-3" />
									{/if}
								</button>
							</div>
						{:else}
							<Sidebar.MenuButton href={item.href} isActive={isActive(item.href)} tooltipContent={item.label} onclick={() => sidebar.setOpenMobile(false)}>
								<item.Icon aria-hidden="true" />
								<span class="group-data-[state=collapsed]:hidden">{item.label}</span>
							</Sidebar.MenuButton>
						{/if}
					</li>
				{/each}
			</Sidebar.Menu>
			{#if editMode}
				<div class="flex items-center justify-between px-2 py-1 mt-1 text-xs leading-none">
					<button
						type="button"
						class="flex items-center gap-1 whitespace-nowrap font-medium text-muted-foreground hover:text-foreground transition-colors"
						title="Reset menu to default order and visibility"
						onclick={() => {
							sidebarPreferencesStore.reset();
							editMode = false;
						}}
					>
						<RotateCcw class="w-3 h-3 shrink-0 text-red-400" />
						Reset
					</button>
					<button
						type="button"
						class="flex items-center gap-1 whitespace-nowrap font-medium text-muted-foreground hover:text-foreground transition-colors"
						onclick={() => (editMode = false)}
					>
						<Check class="w-3 h-3 shrink-0 text-emerald-500" />
						Apply
					</button>
				</div>
			{/if}
		</Sidebar.Group>
	</Sidebar.Content>

	<!-- Collapsed-only update indicator at the bottom. Same CSS-popover trick
	     as the expanded version row — anchored to the icon's top edge, grows
	     upward, opens to the right of the narrow sidebar. -->
	{#if $selfUpdate.updateAvailable}
		<div class="hidden group-data-[state=collapsed]:flex justify-center mt-auto pb-2 relative group/update">
			<a
				href="/settings?tab=about"
				class="inline-flex p-1 rounded-md hover:bg-sidebar-accent transition-colors"
				aria-label="Dockhand update available"
			>
				<CircleArrowUp class="w-4 h-4 text-amber-500 {$appSettings.highlightUpdates ? 'glow-amber' : ''}" />
			</a>
			<div
				role="tooltip"
				class="pointer-events-none absolute left-0 bottom-full mb-1 whitespace-nowrap rounded-md border bg-popover text-popover-foreground text-xs px-3 py-1.5 shadow-lg opacity-0 group-hover/update:opacity-100 transition-opacity z-50"
			>
				{@render versionTooltip()}
			</div>
		</div>
	{/if}

	<!-- Version (expanded sidebar only). Pure-CSS popover anchored to the row's
	     top edge, so it always grows upward into available space. -->
	<div class="group-data-[state=collapsed]:hidden px-3 py-1 mt-auto text-center relative group/version">
		<span class="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-default">
			{appVersion}
			{#if $selfUpdate.updateAvailable}
				<a
					href="/settings?tab=about"
					class="inline-flex"
					aria-label="Dockhand update available"
				>
					<CircleArrowUp class="w-3 h-3 text-amber-500 {$appSettings.highlightUpdates ? 'glow-amber' : ''}" />
				</a>
			{/if}
		</span>
		<!-- Customize-menu toggle (#1252): invisible until this bottom strip is
		     hovered, so it never distracts users who don't customize. Hidden
		     while editing - the Apply button under the menu exits edit mode. -->
		{#if !editMode}
			<button
				type="button"
				class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-sidebar-accent transition-all opacity-0 group-hover/version:opacity-100 focus-visible:opacity-100"
				title="Customize menu"
				aria-label="Customize menu"
				onclick={() => (editMode = true)}
			>
				<Pencil class="w-3 h-3" />
			</button>
		{/if}
		<div
			role="tooltip"
			class="pointer-events-none absolute left-0 bottom-full mb-1 whitespace-nowrap rounded-md border bg-popover text-popover-foreground text-xs px-3 py-1.5 shadow-lg opacity-0 group-hover/version:opacity-100 transition-opacity z-50"
		>
			{@render versionTooltip()}
		</div>
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
