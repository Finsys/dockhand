<script lang="ts">
	import { onMount, untrack, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		LayoutDashboard,
		Box,
		Layers,
		Images,
		ScrollText,
		HardDrive,
		Network,
		Download,
		Settings,
		Terminal,
		Eye,
		Timer,
		ClipboardList,
		Search,
		Server,
		Play,
		Square,
		RotateCcw,
		FileText,
		Sun,
		Moon,
		Type,
		Check,
		Palette
	} from 'lucide-svelte';
	import { licenseStore } from '$lib/stores/license';
	import { authStore, canAccess } from '$lib/stores/auth';
	import { currentEnvironment } from '$lib/stores/environment';
	import { themeStore, onDarkModeChange } from '$lib/stores/theme';
	import { lightThemes, darkThemes, fonts } from '$lib/themes';
	import { EDITOR_THEMES } from '$lib/utils/editor-themes';
	import { filterPalette, type PaletteItem } from '$lib/utils/palette-filter';
	import { mapContainerRows, mapStackRows, roundRobin } from '$lib/utils/palette-data';
	import { buildOffsets, visibleRange } from '$lib/utils/palette-virtual';
	import ContainerIcon from '$lib/components/ContainerIcon.svelte';
	import StackIcon from '$lib/components/StackIcon.svelte';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';

	interface Props {
		open?: boolean;
	}

	let { open = $bindable(false) }: Props = $props();

	interface NavItem {
		name: string;
		href: string;
		icon: typeof LayoutDashboard;
		keywords?: string[];
	}
	interface Environment {
		id: number;
		name: string;
		icon?: string;
	}
	interface Container {
		id: string;
		name: string;
		displayName: string;
		state: string;
		image: string;
		envId: number;
		envName: string;
		envIcon: string;
	}
	interface Stack {
		id: string;
		name: string;
		icon?: string | null;
		envId: number;
		envName: string;
		envIcon: string;
	}

	let environments = $state<Environment[]>([]);
	let containers = $state<Container[]>([]);
	let stacks = $state<Stack[]>([]);
	let loading = $state(false);

	const navigationItems: NavItem[] = [
		{ name: 'Dashboard', href: '/', icon: LayoutDashboard, keywords: ['home', 'overview'] },
		{ name: 'Containers', href: '/containers', icon: Box, keywords: ['docker', 'running'] },
		{ name: 'Logs', href: '/logs', icon: ScrollText, keywords: ['output', 'debug'] },
		{ name: 'Shell', href: '/terminal', icon: Terminal, keywords: ['exec', 'bash', 'sh'] },
		{ name: 'Stacks', href: '/stacks', icon: Layers, keywords: ['compose', 'docker-compose'] },
		{ name: 'Images', href: '/images', icon: Images, keywords: ['pull', 'build'] },
		{ name: 'Volumes', href: '/volumes', icon: HardDrive, keywords: ['storage', 'data'] },
		{ name: 'Networks', href: '/networks', icon: Network, keywords: ['bridge', 'host'] },
		{ name: 'Registry', href: '/registry', icon: Download, keywords: ['hub', 'pull'] },
		{ name: 'Activity', href: '/activity', icon: Eye, keywords: ['events', 'history'] },
		{ name: 'Schedules', href: '/schedules', icon: Timer, keywords: ['cron', 'auto'] },
		{ name: 'Settings', href: '/settings', icon: Settings, keywords: ['config', 'preferences'] }
	];

	// Group headings (source order drives render order).
	const G_NAV = 'Navigation';
	const G_ENT = 'Enterprise';
	const G_LIGHT = 'Light theme';
	const G_DARK = 'Dark theme';
	const G_FONT = 'Font';
	const G_EDITOR = 'Editor theme';
	const G_ENV = 'Switch environment';
	const G_STACK = 'Stacks';
	const G_CONT = 'Containers';

	// Presentation + action for each item, resolved by id (kept out of the pure model).
	interface Meta {
		icon: typeof LayoutDashboard;
		preview?: string; // swatch colour for theme rows
		run: () => void;
		container?: Container; // container rows render actions when active/hovered
		stack?: Stack; // stack rows render the real stack icon + env icon
		env?: Environment; // env rows render the real environment icon
	}

	// Build the flat item model + the id->meta lookup. Cheap array maps; re-runs only when
	// a source array changes. No scoring here.
	const built = $derived.by(() => {
		const items: PaletteItem[] = [];
		const meta = new Map<string, Meta>();
		const add = (item: PaletteItem, m: Meta) => {
			items.push(item);
			meta.set(item.id, m);
		};

		for (const nav of navigationItems) {
			if (nav.href === '/terminal' && !$canAccess('containers', 'exec')) continue;
			add(
				{ id: `nav:${nav.href}`, group: G_NAV, label: nav.name, keywords: (nav.keywords ?? []).join(' ') },
				{ icon: nav.icon, run: () => select(nav.href) }
			);
		}

		if ($licenseStore.isEnterprise && $authStore.authEnabled) {
			add(
				{ id: 'ent:audit', group: G_ENT, label: 'Audit log', keywords: 'compliance audit' },
				{ icon: ClipboardList, run: () => select('/audit') }
			);
		}

		for (const t of lightThemes) {
			add(
				{ id: `light:${t.id}`, group: G_LIGHT, label: t.name, keywords: 'light theme', active: $themeStore.lightTheme === t.id },
				{ icon: Sun, preview: t.preview, run: () => applyLightTheme(t.id) }
			);
		}
		for (const t of darkThemes) {
			add(
				{ id: `dark:${t.id}`, group: G_DARK, label: t.name, keywords: 'dark theme', active: $themeStore.darkTheme === t.id },
				{ icon: Moon, preview: t.preview, run: () => applyDarkTheme(t.id) }
			);
		}
		for (const f of fonts) {
			add(
				{ id: `font:${f.id}`, group: G_FONT, label: f.name, keywords: 'font', active: $themeStore.font === f.id },
				{ icon: Type, run: () => applyFont(f.id) }
			);
		}
		for (const t of EDITOR_THEMES) {
			add(
				{ id: `editor:${t.id}`, group: G_EDITOR, label: t.label, keywords: 'editor theme code', active: $themeStore.editorTheme === t.id },
				{ icon: Palette, run: () => applyEditorTheme(t.id) }
			);
		}
		for (const env of environments) {
			add(
				{ id: `env:${env.id}`, group: G_ENV, label: env.name, keywords: 'environment', active: $currentEnvironment?.id === env.id },
				{ icon: Server, run: () => selectEnv(env), env }
			);
		}
		for (const s of stacks) {
			add(
				{ id: `stack:${s.envId}:${s.name}`, group: G_STACK, label: s.name, keywords: `stack compose ${s.envName}`.toLowerCase() },
				{ icon: Layers, run: () => selectStack(s), stack: s }
			);
		}
		for (const c of containers) {
			add(
				// Env-scoped id: the same container id can arrive from several environments
				// that share a daemon, and each must stay a distinct, correctly-labelled row.
				{ id: `cont:${c.envId}:${c.id}`, group: G_CONT, label: c.displayName, keywords: `container ${c.name} ${c.image} ${c.envName}`.toLowerCase() },
				{ icon: Box, run: () => containerAction(c, 'logs'), container: c }
			);
		}

		return { items, meta };
	});

	// Per-group caps for the empty (no-query) view so we never mount every item.
	const DEFAULT_CAPS: Record<string, number> = {
		[G_LIGHT]: 6,
		[G_DARK]: 6,
		[G_FONT]: 6,
		[G_EDITOR]: 6,
		[G_STACK]: 12,
		[G_CONT]: 12
	};

	let query = $state('');

	const filtered = $derived(filterPalette(built.items, query, { defaultCaps: DEFAULT_CAPS }));

	// Flatten to render rows: a header pseudo-row precedes each group's items.
	type Row = { type: 'header'; group: string } | { type: 'item'; item: PaletteItem };
	const rows = $derived.by(() => {
		const out: Row[] = [];
		let lastGroup = '';
		for (const item of filtered) {
			if (item.group !== lastGroup) {
				out.push({ type: 'header', group: item.group });
				lastGroup = item.group;
			}
			out.push({ type: 'item', item });
		}
		return out;
	});

	// Indices of selectable (item) rows, for keyboard nav.
	const itemRowIndices = $derived(rows.map((r, i) => (r.type === 'item' ? i : -1)).filter((i) => i >= 0));

	// --- fixed-height virtualization (DataGrid pattern) ---
	const ITEM_H = 44;
	const HEADER_H = 28;
	const BUFFER = 6;
	let scrollTop = $state(0);
	let viewportH = $state(320);
	let listEl = $state<HTMLDivElement | null>(null);

	const offsets = $derived(buildOffsets(rows.map((r) => (r.type === 'header' ? HEADER_H : ITEM_H))));
	const totalHeight = $derived(offsets[rows.length] ?? 0);

	const range = $derived(visibleRange(offsets, scrollTop, viewportH, BUFFER));
	const startIndex = $derived(range.start);
	const endIndex = $derived(range.end);
	const visible = $derived(rows.slice(startIndex, endIndex).map((row, k) => ({ row, index: startIndex + k })));

	// --- keyboard selection over the ITEM rows ---
	let activeRow = $state(0); // an index into `rows` pointing at an item row

	// Reset scroll + selection to the top when the query changes.
	$effect(() => {
		void query;
		untrack(() => {
			activeRow = itemRowIndices.length > 0 ? itemRowIndices[0] : -1;
			scrollTop = 0;
			if (listEl) listEl.scrollTop = 0;
		});
	});

	// Re-seed the selection when rows arrive without a query change - data loads async, so
	// a query typed before containers/stacks resolve leaves activeRow at -1 (Enter would
	// no-op) until the results appear. This snaps it to the first item once they do.
	$effect(() => {
		if (activeRow < 0 && itemRowIndices.length > 0) {
			untrack(() => (activeRow = itemRowIndices[0]));
		}
	});

	function moveActive(delta: number) {
		if (itemRowIndices.length === 0) return;
		const pos = itemRowIndices.indexOf(activeRow);
		const next = pos < 0 ? 0 : (pos + delta + itemRowIndices.length) % itemRowIndices.length;
		activeRow = itemRowIndices[next];
		scrollActiveIntoView();
	}

	function scrollActiveIntoView() {
		if (activeRow < 0 || !listEl) return;
		const top = offsets[activeRow];
		const bottom = top + ITEM_H;
		if (top < scrollTop) listEl.scrollTop = top;
		else if (bottom > scrollTop + viewportH) listEl.scrollTop = bottom - viewportH;
	}

	function runActive() {
		if (activeRow < 0) return;
		const row = rows[activeRow];
		if (row?.type === 'item') built.meta.get(row.item.id)?.run();
	}

	function onListKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
		else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
		else if (e.key === 'Home') { e.preventDefault(); if (itemRowIndices.length) { activeRow = itemRowIndices[0]; scrollActiveIntoView(); } }
		else if (e.key === 'End') { e.preventDefault(); if (itemRowIndices.length) { activeRow = itemRowIndices[itemRowIndices.length - 1]; scrollActiveIntoView(); } }
	}

	// --- data loading (lazy on open, cached with stale-while-revalidate) ---
	// The palette fetches environments + per-host containers + per-host stacks, a burst
	// that scales with host count. Cache it: within FRESH_MS an open reuses the cached
	// data with no fetch; when stale, the cached list stays visible while a background
	// refresh updates it in place (loadData sets state at the end, never clearing first).
	const FRESH_MS = 30_000;
	let lastLoadedAt = 0;

	async function loadData(force = false) {
		if (loading) return;
		if (!force && lastLoadedAt > 0 && Date.now() - lastLoadedAt < FRESH_MS) return;
		loading = true;
		try {
			const envsRes = await fetch('/api/environments');
			let envs: Environment[] = [];
			if (envsRes.ok) {
				envs = await envsRes.json();
				environments = envs;
			}

			// Containers and stacks are both per-environment: fetch every env in
			// parallel for cross-env search (/api/containers returns [] without ?env=).
			const [containerResults, stackResults] = await Promise.all([
				Promise.all(
					envs.map(async (env) => {
						try {
							const res = await fetch(`/api/containers?all=true&env=${env.id}`);
							if (!res.ok) return [] as Container[];
							return mapContainerRows(await res.json(), env);
						} catch {
							return [] as Container[];
						}
					})
				),
				Promise.all(
					envs.map(async (env) => {
						try {
							const res = await fetch(`/api/stacks?env=${env.id}`);
							if (!res.ok) return [] as Stack[];
							return mapStackRows(await res.json(), env);
						} catch {
							return [] as Stack[];
						}
					})
				)
			]);
			// Interleave containers round-robin across environments so the capped empty
			// view surfaces variety - when several envs share a daemon, a plain flat()
			// would fill the cap with the earliest env's containers (and their copies).
			containers = roundRobin(containerResults);
			stacks = stackResults.flat();
			lastLoadedAt = Date.now();
		} catch (e) {
			console.error('Failed to load command palette data:', e);
		} finally {
			loading = false;
		}
	}

	// --- actions ---
	function select(href: string) {
		open = false;
		goto(href);
	}
	function selectEnv(env: Environment) {
		open = false;
		currentEnvironment.set({ id: env.id, name: env.name });
	}
	function selectStack(s: Stack) {
		open = false;
		// Switch to the stack's environment (the stacks page reads currentEnvironment, not
		// the URL), then filter to the stack and expand it - same as clicking its name.
		currentEnvironment.set({ id: s.envId, name: s.envName });
		goto(`/stacks?env=${s.envId}&expand=${encodeURIComponent(s.name)}`);
	}
	function applyLightTheme(themeId: string) {
		const userId = $authStore.authEnabled && $authStore.user ? $authStore.user.id : undefined;
		themeStore.setPreference('lightTheme', themeId, userId);
		document.documentElement.classList.remove('dark');
		localStorage.setItem('theme', 'light');
		onDarkModeChange();
	}
	function applyDarkTheme(themeId: string) {
		const userId = $authStore.authEnabled && $authStore.user ? $authStore.user.id : undefined;
		themeStore.setPreference('darkTheme', themeId, userId);
		document.documentElement.classList.add('dark');
		localStorage.setItem('theme', 'dark');
		onDarkModeChange();
	}
	function applyFont(fontId: string) {
		const userId = $authStore.authEnabled && $authStore.user ? $authStore.user.id : undefined;
		themeStore.setPreference('font', fontId, userId);
	}
	function applyEditorTheme(themeId: string) {
		const userId = $authStore.authEnabled && $authStore.user ? $authStore.user.id : undefined;
		themeStore.setPreference('editorTheme', themeId, userId);
		open = false;
	}
	async function containerAction(container: Container, action: 'logs' | 'terminal' | 'start' | 'stop' | 'restart') {
		open = false;
		const containerId = container.id;
		const envQuery = container.envId ? `&env=${container.envId}` : '';
		if (action === 'logs' || action === 'terminal') {
			// The logs/terminal pages load their container list from currentEnvironment, not
			// the URL env - so a cross-host jump must switch the environment first, or the
			// target container (on another host) is never found. start/stop/restart just hit
			// the API with ?env= and must NOT move the user off their current host.
			if (container.envId) {
				currentEnvironment.set({ id: container.envId, name: container.envName });
			}
			goto(`/${action === 'logs' ? 'logs' : 'terminal'}?container=${containerId}${envQuery}`);
		} else {
			try {
				await fetch(`/api/containers/${containerId}/${action}${container.envId ? `?env=${container.envId}` : ''}`, { method: 'POST' });
			} catch (e) {
				console.error(`Failed to ${action} container:`, e);
			}
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			open = !open;
		}
	}

	// Load data + reset query/focus when the dialog opens.
	$effect(() => {
		if (open) {
			untrack(() => {
				query = '';
				loadData();
				tick().then(() => inputEl?.focus());
			});
		}
	});

	let inputEl = $state<HTMLInputElement | null>(null);

	onMount(() => {
		document.addEventListener('keydown', handleKeydown);
		return () => document.removeEventListener('keydown', handleKeydown);
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="p-0 gap-0 max-w-2xl overflow-hidden"
		showCloseButton={false}
	>
		<Dialog.Title class="sr-only">Command palette</Dialog.Title>
		<Dialog.Description class="sr-only">Search for pages, themes, environments, stacks and containers</Dialog.Description>

		<div class="flex items-center gap-2 border-b px-3">
			<Search class="h-4 w-4 shrink-0 text-muted-foreground" />
			<input
				bind:this={inputEl}
				bind:value={query}
				onkeydown={onListKeydown}
				placeholder="Search..."
				role="combobox"
				aria-expanded="true"
				aria-controls="palette-list"
				aria-activedescendant={activeRow >= 0 ? `palette-row-${activeRow}` : undefined}
				class="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
			/>
		</div>

		{#if rows.length === 0}
			<div class="py-6 text-center text-sm text-muted-foreground">No results found.</div>
		{:else}
			<div
				id="palette-list"
				role="listbox"
				tabindex="-1"
				bind:this={listEl}
				bind:clientHeight={viewportH}
				onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
				class="max-h-[min(60vh,400px)] overflow-y-auto"
			>
				<div style="height: {totalHeight}px; position: relative;">
					{#each visible as { row, index } (index)}
						{#if row.type === 'header'}
							<div
								class="absolute left-0 right-0 flex items-end px-3 pb-1 text-xs font-medium text-muted-foreground"
								style="top: {offsets[index]}px; height: {HEADER_H}px;"
							>
								{row.group}
							</div>
						{:else}
							{@const item = row.item}
							{@const meta = built.meta.get(item.id)}
							{@const isActive = index === activeRow}
							<!-- Keyboard nav is handled at the listbox level via the search input
							     (arrows + enter); rows are mouse targets only, not tab stops. -->
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
							<div
								id="palette-row-{index}"
								role="option"
								tabindex={-1}
								aria-selected={isActive}
								onclick={() => { activeRow = index; meta?.run(); }}
								onmousemove={() => (activeRow = index)}
								class="absolute left-0 right-0 flex cursor-pointer items-center gap-2 px-3 text-sm {isActive ? 'bg-accent text-accent-foreground' : ''}"
								style="top: {offsets[index]}px; height: {ITEM_H}px;"
							>
								{#if meta?.container}
									{@const c = meta.container}
									<ContainerIcon image={c.image} name={c.name} envId={c.envId} class="h-4 w-4 shrink-0" />
									<div class="flex min-w-0 flex-col">
										<span class="truncate" title={c.name}>{item.label}</span>
										<span class="flex items-center gap-1 truncate text-xs text-muted-foreground">
											<EnvironmentIcon icon={c.envIcon} envId={c.envId} class="h-3 w-3 shrink-0" />
											{c.envName} - {c.image}
										</span>
									</div>
									{#if isActive}
										<div class="ml-auto flex items-center gap-1">
											{#if c.state === 'running'}
												<button class="rounded p-1 hover:bg-muted" title="View logs" onclick={(e) => { e.stopPropagation(); containerAction(c, 'logs'); }}><FileText class="h-3 w-3" /></button>
												<button class="rounded p-1 hover:bg-muted" title="Open terminal" onclick={(e) => { e.stopPropagation(); containerAction(c, 'terminal'); }}><Terminal class="h-3 w-3" /></button>
												<button class="rounded p-1 hover:bg-muted" title="Restart" onclick={(e) => { e.stopPropagation(); containerAction(c, 'restart'); }}><RotateCcw class="h-3 w-3" /></button>
												<button class="rounded p-1 text-destructive hover:bg-muted" title="Stop" onclick={(e) => { e.stopPropagation(); containerAction(c, 'stop'); }}><Square class="h-3 w-3" /></button>
											{:else}
												<button class="rounded p-1 text-green-500 hover:bg-muted" title="Start" onclick={(e) => { e.stopPropagation(); containerAction(c, 'start'); }}><Play class="h-3 w-3" /></button>
											{/if}
										</div>
									{/if}
								{:else if meta?.stack}
									{@const s = meta.stack}
									<StackIcon icon={s.icon} stackName={s.name} envId={s.envId} class="h-4 w-4 shrink-0" />
									<div class="flex min-w-0 flex-col">
										<span class="truncate">{item.label}</span>
										<span class="flex items-center gap-1 truncate text-xs text-muted-foreground">
											<EnvironmentIcon icon={s.envIcon} envId={s.envId} class="h-3 w-3 shrink-0" />
											{s.envName}
										</span>
									</div>
								{:else if meta?.env}
									<EnvironmentIcon icon={meta.env.icon || 'globe'} envId={meta.env.id} class="h-4 w-4 shrink-0" />
									<span class="truncate">{item.label}</span>
									{#if item.active}
										<Check class="ml-auto h-4 w-4 shrink-0 text-green-500" />
									{/if}
								{:else}
									{@const Icon = meta?.icon ?? Box}
									<Icon class="h-4 w-4 shrink-0 text-muted-foreground" />
									{#if meta?.preview}
										<span class="h-3 w-3 shrink-0 rounded-full border" style="background-color: {meta.preview}"></span>
									{/if}
									<span class="truncate">{item.label}</span>
									{#if item.active}
										<Check class="ml-auto h-4 w-4 shrink-0 text-green-500" />
									{/if}
								{/if}
							</div>
						{/if}
					{/each}
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
