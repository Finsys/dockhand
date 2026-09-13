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

	let { scope = 'global' as 'global' | 'user' } = $props();
	const isUser = $derived(scope === 'user');

	// Every landing/env-click page, MIRRORING the sidebar (same routes, icons, permission /
	// gate / enterprise conditions) so the dropdown only offers pages the user can actually
	// reach. `needsEnv` = the page is env-scoped (shown with the chosen env in the hint and
	// eligible for env-click). `permission` / `gate` / `enterpriseOnly` mirror canSeeMenuItem.
	const ALL_PAGES = [
		{ value: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard, needsEnv: false, permission: 'always' },
		{ value: 'containers', label: 'Containers', Icon: Box, needsEnv: true, permission: 'containers' },
		{ value: 'logs', label: 'Logs', Icon: ScrollText, needsEnv: true, permission: 'containers' },
		{ value: 'terminal', label: 'Shell', Icon: Terminal, needsEnv: true, permission: 'containers' },
		{ value: 'stacks', label: 'Compose stacks', Icon: Layers, needsEnv: true, permission: 'stacks' },
		{ value: 'images', label: 'Images', Icon: Images, needsEnv: true, permission: 'images' },
		{ value: 'volumes', label: 'Volumes', Icon: HardDrive, needsEnv: true, permission: 'volumes' },
		{ value: 'networks', label: 'Networks', Icon: Network, needsEnv: true, permission: 'networks' },
		{ value: 'templates', label: 'Templates', Icon: LibraryBig, needsEnv: false, permission: 'templates' },
		{ value: 'registry', label: 'Registry', Icon: Download, needsEnv: false, permission: 'registries' },
		{ value: 'activity', label: 'Activity', Icon: Activity, needsEnv: false, permission: 'activity' },
		{ value: 'backups', label: 'Backups', Icon: Archive, needsEnv: false, permission: 'backups', gate: 'backups' },
		{ value: 'schedules', label: 'Schedules', Icon: Timer, needsEnv: false, permission: 'schedules' },
		{ value: 'audit', label: 'Audit log', Icon: ClipboardList, needsEnv: false, permission: 'audit_logs', enterpriseOnly: true }
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
	const pageLabel = (v: string | null): string => v ? pageOf(v).label : 'Dashboard';

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
			if (!res.ok) toast.error('Failed to save navigation preference');
		} catch {
			toast.error('Failed to save navigation preference');
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
		<Label>Open the app on</Label>
		<div class="flex items-center gap-2.5">
			<Select.Root type="single" value={homeSel} onValueChange={(v) => { if (v) pickHome(v); }}>
				<Select.Trigger class="flex-1 min-w-0">
					<div class="flex items-center gap-2">
						{#if isUser && landingPage === null}
							<span class="text-muted-foreground truncate">Global default ({pageLabel(globalDefaults.landingPage ?? 'dashboard')})</span>
						{:else}
							{@const m = pageOf(landingPage)}
							<m.Icon class="w-4 h-4 text-muted-foreground" />
							<span class="truncate">{m.label}</span>
						{/if}
					</div>
				</Select.Trigger>
				<Select.Content>
					{#if isUser}
						<Select.Item value={INHERIT}><span class="text-muted-foreground">Use global default</span></Select.Item>
					{/if}
					{#each PAGES as page}
						<Select.Item value={page.value}>
							<div class="flex items-center gap-2">
								<page.Icon class="w-4 h-4 text-muted-foreground" />
								<span>{page.label}</span>
							</div>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<p class="text-xs text-muted-foreground">Where the app opens (on the last-used environment).</p>
	</div>

	<!-- 3. Dashboard env-click target. Clicking an environment is an intentional "show me THIS
	     view of this env", so it's always a concrete page (default: containers). -->
	<div class="space-y-1.5 min-w-0 flex-1">
		<Label>Environment click</Label>
		<Select.Root type="single" value={clickSel} onValueChange={(v) => { if (v) pickClick(v); }}>
			<Select.Trigger class="w-full">
				<div class="flex items-center gap-2">
					{#if isUser && envClickPageV === null}
						<span class="text-muted-foreground">Global default ({pageLabel(globalDefaults.envClickPage ?? 'containers')})</span>
					{:else}
						{@const m = pageOf(envClickPageV ?? 'containers')}
						<m.Icon class="w-4 h-4 text-muted-foreground" />
						<span>{m.label}</span>
					{/if}
				</div>
			</Select.Trigger>
			<Select.Content>
				{#if isUser}
					<Select.Item value={INHERIT}><span class="text-muted-foreground">Use global default</span></Select.Item>
				{/if}
				{#each CLICK_PAGES as page}
					<Select.Item value={page.value}>
						<div class="flex items-center gap-2">
							<page.Icon class="w-4 h-4 text-muted-foreground" />
							<span>{page.label}</span>
						</div>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<p class="text-xs text-muted-foreground">Where a tile click goes.</p>
	</div>
</div>
