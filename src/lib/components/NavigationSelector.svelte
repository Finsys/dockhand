<script lang="ts">
	// Navigation preferences (default env + start page + env-click target). Saved to
	// /api/settings/navigation under the given scope ('global' from Settings, 'user' from Profile).
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { toast } from 'svelte-sonner';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { licenseStore } from '$lib/stores/license';
	import { authStore, hasAnyAccess } from '$lib/stores/auth';
	import { LayoutDashboard, Box, ScrollText, Layers, Images, HardDrive, Network,
		Terminal, LibraryBig, Download, Activity, Archive, Timer, ClipboardList } from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';

	let { scope = 'global' as 'global' | 'user' } = $props();
	const isUser = $derived(scope === 'user');

	// Every landing/env-click page, MIRRORING the sidebar (same routes, icons, permission /
	// gate / enterprise conditions) so the dropdown only offers pages the user can actually
	// reach. `needsEnv` = the page is env-scoped (shown with the chosen env in the hint and
	// eligible for env-click). `permission` / `gate` / `enterpriseOnly` mirror canSeeMenuItem.
	// `label` is a function so it is read in the active language at render time.
	const ALL_PAGES = [
		{ value: 'dashboard', label: m.nav_dashboard, Icon: LayoutDashboard, needsEnv: false, permission: 'always' },
		{ value: 'containers', label: m.nav_containers, Icon: Box, needsEnv: true, permission: 'containers' },
		{ value: 'logs', label: m.nav_logs, Icon: ScrollText, needsEnv: true, permission: 'containers' },
		{ value: 'terminal', label: m.nav_shell, Icon: Terminal, needsEnv: true, permission: 'containers' },
		{ value: 'stacks', label: m.navselector_compose_stacks, Icon: Layers, needsEnv: true, permission: 'stacks' },
		{ value: 'images', label: m.nav_images, Icon: Images, needsEnv: true, permission: 'images' },
		{ value: 'volumes', label: m.nav_volumes, Icon: HardDrive, needsEnv: true, permission: 'volumes' },
		{ value: 'networks', label: m.nav_networks, Icon: Network, needsEnv: true, permission: 'networks' },
		{ value: 'templates', label: m.nav_templates, Icon: LibraryBig, needsEnv: false, permission: 'templates' },
		{ value: 'registry', label: m.nav_registry, Icon: Download, needsEnv: false, permission: 'registries' },
		{ value: 'activity', label: m.nav_activity, Icon: Activity, needsEnv: false, permission: 'activity' },
		{ value: 'backups', label: m.nav_backups, Icon: Archive, needsEnv: false, permission: 'backups', gate: 'backups' },
		{ value: 'schedules', label: m.nav_schedules, Icon: Timer, needsEnv: false, permission: 'schedules' },
		{ value: 'audit', label: m.nav_audit_log, Icon: ClipboardList, needsEnv: false, permission: 'audit_logs', enterpriseOnly: true }
	] as const;

	// Visibility mirrors app-sidebar's canSeeMenuItem: hide the Backups beta unless the gate is
	// on, enterprise-only pages without an enterprise license, and (enterprise + auth on, non-
	// admin) pages the user has no permission for. Free/auth-off shows everything non-enterprise.
	function canSee(item: (typeof ALL_PAGES)[number]): boolean {
		const p = item as { permission?: string; gate?: string; enterpriseOnly?: boolean };
		if (p.gate === 'backups' && !$page.data?.backupsEnabled) return false;
		if (p.enterpriseOnly && !$licenseStore.isEnterprise) return false;
		if (!$licenseStore.isEnterprise || !$authStore.authEnabled) return true;
		if ($authStore.user?.isAdmin) return true;
		if (!p.permission || p.permission === 'always') return true;
		return $hasAnyAccess(p.permission as any);
	}

	const PAGES = $derived(ALL_PAGES.filter(canSee));
	// Env-click: only env-scoped pages, and never Dashboard (you already clicked an env).
	const CLICK_PAGES = $derived(PAGES.filter((p) => p.needsEnv));

	// In the 'user' scope, a null field means "inherit the global default". We surface that as a
	// pickable sentinel option so the user can go back to inheriting.
	const INHERIT = '__inherit__';

	// State. Values: a page string, or null (=inherit in user scope). In GLOBAL scope null is
	// never stored — an unset field defaults to 'dashboard' (landing) / 'containers' (env-click).
	let landingPage = $state<string | null>(null);
	let envClickPageV = $state<string | null>(null);
	let loaded = $state(false);
	// The global values, shown as the "(default: X)" hint in user scope.
	let globalDefaults = $state<{ landingPage: string | null; envClickPage: string | null }>({ landingPage: null, envClickPage: null });

	const pageOf = (v: string | null) => PAGES.find((p) => p.value === v) ?? PAGES[0];

	// Resolve a stored field to the value the Select should show. In user scope an unset
	// field (null) stays inherit; in global scope it falls back to the given default.
	const resolve = (v: string | null, globalDefault: string) => v ?? (isUser ? INHERIT : globalDefault);
	// Home defaults to Dashboard; env-click defaults to a concrete page (containers).
	const homeSel = $derived(resolve(landingPage, 'dashboard'));
	const clickSel = $derived(resolve(envClickPageV, 'containers'));

	// Label helper for the trigger + the (default: X) hint.
	const pageLabel = (v: string | null): string => v ? pageOf(v).label() : m.nav_dashboard();

	onMount(async () => {
		try {
			const res = await fetch('/api/settings/navigation');
			if (res.ok) {
				const data = await res.json();
				globalDefaults = { landingPage: data.global?.landingPage ?? null, envClickPage: data.global?.envClickPage ?? null };
				const p = isUser ? (data.user ?? {}) : (data.global ?? {});
				landingPage = p.landingPage ?? null;
				envClickPageV = p.envClickPage ?? null;
			}
		} catch { /* keep defaults */ }
		loaded = true;
	});

	function pickHome(v: string) {
		landingPage = v === INHERIT ? null : v;
		persist();
	}
	function pickClick(v: string) {
		envClickPageV = v === INHERIT ? null : v;
		persist();
	}

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	async function save() {
		try {
			const res = await fetch(`/api/settings/navigation?scope=${scope}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					// '' clears (inherit in user scope). A page value sets it.
					landingPage: landingPage ?? '',
					envClickPage: envClickPageV ?? ''
				})
			});
			if (!res.ok) toast.error(m.navselector_save_failed());
		} catch {
			toast.error(m.navselector_save_failed());
		}
	}
	function persist() {
		if (!loaded) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(save, 250);
	}
</script>

<!-- Two groups side by side: "Open the app on" (which page + which env) and "Environment
     click". Wraps to a column on narrow screens. -->
<div class="flex flex-col sm:flex-row sm:items-start gap-6">

	<!-- 1. Open the app on: the landing PAGE. The environment is not forced - the app opens on
	     the last-used one. -->
	<div class="space-y-1.5 min-w-0 flex-1">
		<Label>{m.navselector_landing_label()}</Label>
		<div class="flex items-center gap-2.5">
			<Select.Root type="single" value={homeSel} onValueChange={(v) => { if (v) pickHome(v); }}>
				<Select.Trigger class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						{#if isUser && landingPage === null}
							<span class="text-muted-foreground truncate">{m.navselector_global_default({ page: pageLabel(globalDefaults.landingPage ?? 'dashboard') })}</span>
						{:else}
							{@const sel = pageOf(landingPage)}
							<sel.Icon class="w-4 h-4 text-muted-foreground" />
							<span class="truncate">{sel.label()}</span>
						{/if}
					</div>
				</Select.Trigger>
				<Select.Content>
					{#if isUser}
						<Select.Item value={INHERIT}><span class="text-muted-foreground">{m.navselector_use_global_default()}</span></Select.Item>
					{/if}
					{#each PAGES as page}
						<Select.Item value={page.value}>
							<div class="flex items-center gap-2">
								<page.Icon class="w-4 h-4 text-muted-foreground" />
								<span>{page.label()}</span>
							</div>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<p class="text-xs text-muted-foreground">{m.navselector_landing_hint()}</p>
	</div>

	<!-- 3. Dashboard env-click target. Clicking an environment is an intentional "show me THIS
	     view of this env", so it's always a concrete page (default: containers). -->
	<div class="space-y-1.5 min-w-0 flex-1">
		<Label>{m.navselector_env_click_label()}</Label>
		<Select.Root type="single" value={clickSel} onValueChange={(v) => { if (v) pickClick(v); }}>
			<Select.Trigger class="w-full">
				<div class="flex items-center gap-2">
					{#if isUser && envClickPageV === null}
						<span class="text-muted-foreground">{m.navselector_global_default({ page: pageLabel(globalDefaults.envClickPage ?? 'containers') })}</span>
					{:else}
						{@const sel = pageOf(envClickPageV ?? 'containers')}
						<sel.Icon class="w-4 h-4 text-muted-foreground" />
						<span>{sel.label()}</span>
					{/if}
				</div>
			</Select.Trigger>
			<Select.Content>
				{#if isUser}
					<Select.Item value={INHERIT}><span class="text-muted-foreground">{m.navselector_use_global_default()}</span></Select.Item>
				{/if}
				{#each CLICK_PAGES as page}
					<Select.Item value={page.value}>
						<div class="flex items-center gap-2">
							<page.Icon class="w-4 h-4 text-muted-foreground" />
							<span>{page.label()}</span>
						</div>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<p class="text-xs text-muted-foreground">{m.navselector_env_click_hint()}</p>
	</div>
</div>
