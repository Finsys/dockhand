<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import * as Command from '$lib/components/ui/command';
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
		CircleDot,
		Sun,
		Moon,
		Type,
		Check
	} from 'lucide-svelte';
	import { licenseStore } from '$lib/stores/license';
	import { authStore, canAccess } from '$lib/stores/auth';
	import { currentEnvironment } from '$lib/stores/environment';
	import { themeStore, onDarkModeChange } from '$lib/stores/theme';
	import { lightThemes, darkThemes, fonts } from '$lib/themes';

	interface Props {
		open?: boolean;
	}

	let { open = $bindable(false) }: Props = $props();

	interface CommandItem {
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
		state: string;
		image: string;
		envId: number;
		envName: string;
	}

	let environments = $state<Environment[]>([]);
	let containers = $state<Container[]>([]);
	let loading = $state(false);

	const navigationItems: CommandItem[] = [
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

	// Filter items based on permissions
	const filteredItems = $derived(
		navigationItems.filter(item => {
			if (item.href === '/terminal' && !$canAccess('containers', 'exec')) return false;
			if (item.href === '/audit' && (!$licenseStore.isEnterprise || !$authStore.authEnabled)) return false;
			return true;
		})
	);

	// Load environments and containers when palette opens
	async function loadData() {
		if (loading) return;
		loading = true;
		try {
			const [envsRes, containersRes] = await Promise.all([
				fetch('/api/environments'),
				fetch('/api/containers?all=true')
			]);

			if (envsRes.ok) {
				environments = await envsRes.json();
			}

			if (containersRes.ok) {
				const data = await containersRes.json();
				containers = data.map((c: any) => ({
					id: c.Id,
					name: c.Names?.[0]?.replace(/^\//, '') || c.Id.substring(0, 12),
					state: c.State,
					image: c.Image,
					envId: c.environmentId || 0,
					envName: c.environmentName || 'Local'
				}));
			}
		} catch (e) {
			console.error('Failed to load command palette data:', e);
		} finally {
			loading = false;
		}
	}

	function handleSelect(href: string) {
		open = false;
		goto(href);
	}

	function handleEnvSelect(env: Environment) {
		open = false;
		currentEnvironment.set({ id: env.id, name: env.name });
	}

	function handleLightThemeSelect(themeId: string) {
		const userId = $authStore.authEnabled && $authStore.user ? $authStore.user.id : undefined;
		themeStore.setPreference('lightTheme', themeId, userId);
		// Switch to light mode
		document.documentElement.classList.remove('dark');
		localStorage.setItem('theme', 'light');
		onDarkModeChange();
	}

	function handleDarkThemeSelect(themeId: string) {
		const userId = $authStore.authEnabled && $authStore.user ? $authStore.user.id : undefined;
		themeStore.setPreference('darkTheme', themeId, userId);
		// Switch to dark mode
		document.documentElement.classList.add('dark');
		localStorage.setItem('theme', 'dark');
		onDarkModeChange();
	}

	function handleFontSelect(fontId: string) {
		const userId = $authStore.authEnabled && $authStore.user ? $authStore.user.id : undefined;
		themeStore.setPreference('font', fontId, userId);
	}

	async function handleContainerAction(containerId: string, action: 'logs' | 'terminal' | 'start' | 'stop' | 'restart') {
		open = false;
		const container = containers.find(c => c.id === containerId);
		const envParam = container?.envId ? `?env=${container.envId}` : '';

		if (action === 'logs') {
			goto(`/logs?container=${containerId}${envParam ? '&env=' + container?.envId : ''}`);
		} else if (action === 'terminal') {
			goto(`/terminal?container=${containerId}${envParam ? '&env=' + container?.envId : ''}`);
		} else {
			try {
				await fetch(`/api/containers/${containerId}/${action}${envParam}`, { method: 'POST' });
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

	// Load data when dialog opens
	$effect(() => {
		if (open) {
			untrack(() => loadData());
		}
	});

	onMount(() => {
		document.addEventListener('keydown', handleKeydown);
		return () => document.removeEventListener('keydown', handleKeydown);
	});
</script>

<Command.Dialog bind:open title="Command Palette" description="Search for pages and actions">
	<Command.Input placeholder="Search..." />
	<Command.List>
		<Command.Empty>No results found.</Command.Empty>
		<Command.Group heading="Navigation">
			{#each filteredItems as item (item.href)}
				<Command.Item
					value={item.name + ' ' + (item.keywords?.join(' ') || '')}
					onSelect={() => handleSelect(item.href)}
				>
					<item.icon class="mr-2 h-4 w-4" />
					<span>{item.name}</span>
				</Command.Item>
			{/each}
		</Command.Group>
		{#if $licenseStore.isEnterprise && $authStore.authEnabled}
			<Command.Separator />
			<Command.Group heading="Enterprise">
				<Command.Item
					value="Audit log compliance"
					onSelect={() => handleSelect('/audit')}
				>
					<ClipboardList class="mr-2 h-4 w-4" />
					<span>Audit log</span>
				</Command.Item>
			</Command.Group>
		{/if}
		<Command.Separator />
		<Command.Group heading="Light theme">
			{#each lightThemes as theme (theme.id)}
				<Command.Item
					value={`light theme ${theme.name}`}
					onSelect={() => handleLightThemeSelect(theme.id)}
				>
					<Sun class="mr-2 h-4 w-4" />
					<div class="flex items-center gap-2">
						<div
							class="w-3 h-3 rounded-full border"
							style="background-color: {theme.preview}"
						></div>
						<span>{theme.name}</span>
					</div>
					{#if $themeStore.lightTheme === theme.id}
						<Check class="ml-auto h-4 w-4 text-green-500" />
					{/if}
				</Command.Item>
			{/each}
		</Command.Group>
		<Command.Separator />
		<Command.Group heading="Dark theme">
			{#each darkThemes as theme (theme.id)}
				<Command.Item
					value={`dark theme ${theme.name}`}
					onSelect={() => handleDarkThemeSelect(theme.id)}
				>
					<Moon class="mr-2 h-4 w-4" />
					<div class="flex items-center gap-2">
						<div
							class="w-3 h-3 rounded-full border"
							style="background-color: {theme.preview}"
						></div>
						<span>{theme.name}</span>
					</div>
					{#if $themeStore.darkTheme === theme.id}
						<Check class="ml-auto h-4 w-4 text-green-500" />
					{/if}
				</Command.Item>
			{/each}
		</Command.Group>
		<Command.Separator />
		<Command.Group heading="Font">
			{#each fonts as font (font.id)}
				<Command.Item
					value={`font ${font.name}`}
					onSelect={() => handleFontSelect(font.id)}
				>
					<Type class="mr-2 h-4 w-4" />
					<span>{font.name}</span>
					{#if $themeStore.font === font.id}
						<Check class="ml-auto h-4 w-4 text-green-500" />
					{/if}
				</Command.Item>
			{/each}
		</Command.Group>
		{#if environments.length > 0}
			<Command.Separator />
			<Command.Group heading="Switch environment">
				{#each environments as env (env.id)}
					<Command.Item
						value={`environment ${env.name}`}
						onSelect={() => handleEnvSelect(env)}
					>
						<Server class="mr-2 h-4 w-4" />
						<span>{env.name}</span>
						{#if $currentEnvironment?.id === env.id}
							<CircleDot class="ml-auto h-4 w-4 text-green-500" />
						{/if}
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
		{#if containers.length > 0}
			<Command.Separator />
			<Command.Group heading="Containers">
				{#each containers as container (container.id)}
					<Command.Item
						value={`container ${container.name} ${container.image} ${container.envName}`}
						onSelect={() => handleContainerAction(container.id, 'logs')}
					>
						<Box class="mr-2 h-4 w-4" />
						<div class="flex flex-col">
							<span>{container.name}</span>
							<span class="text-xs text-muted-foreground">{container.envName} • {container.image}</span>
						</div>
						<div class="ml-auto flex items-center gap-1">
							{#if container.state === 'running'}
								<button
									class="p-1 hover:bg-muted rounded"
									onclick={(e) => { e.stopPropagation(); handleContainerAction(container.id, 'logs'); }}
									title="View logs"
								>
									<FileText class="h-3 w-3" />
								</button>
								<button
									class="p-1 hover:bg-muted rounded"
									onclick={(e) => { e.stopPropagation(); handleContainerAction(container.id, 'terminal'); }}
									title="Open terminal"
								>
									<Terminal class="h-3 w-3" />
								</button>
								<button
									class="p-1 hover:bg-muted rounded"
									onclick={(e) => { e.stopPropagation(); handleContainerAction(container.id, 'restart'); }}
									title="Restart"
								>
									<RotateCcw class="h-3 w-3" />
								</button>
								<button
									class="p-1 hover:bg-muted rounded text-destructive"
									onclick={(e) => { e.stopPropagation(); handleContainerAction(container.id, 'stop'); }}
									title="Stop"
								>
									<Square class="h-3 w-3" />
								</button>
							{:else}
								<button
									class="p-1 hover:bg-muted rounded text-green-500"
									onclick={(e) => { e.stopPropagation(); handleContainerAction(container.id, 'start'); }}
									title="Start"
								>
									<Play class="h-3 w-3" />
								</button>
							{/if}
						</div>
					</Command.Item>
				{/each}
			</Command.Group>
		{/if}
	</Command.List>
</Command.Dialog>
