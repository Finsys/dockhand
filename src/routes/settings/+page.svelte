<svelte:head>
	<title>Settings - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		Settings,
		Globe,
		Download,
		Layers,
		Bell,
		Crown,
		Users,
		Info,
		GitBranch
	} from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	// Import tab components
	import GeneralTab from './general/GeneralTab.svelte';
	import EnvironmentsTab from './environments/EnvironmentsTab.svelte';
	import RegistriesTab from './registries/RegistriesTab.svelte';
	import GitTab from './git/GitTab.svelte';
	import ConfigSetsTab from './config-sets/ConfigSetsTab.svelte';
	import NotificationsTab from './notifications/NotificationsTab.svelte';
	import AuthTab from './auth/AuthTab.svelte';
	import LicenseTab from './license/LicenseTab.svelte';
	import AboutTab from './about/AboutTab.svelte';

	// Tab state from URL
	let activeTab = $derived($page.url.searchParams.get('tab') || 'general');
	let editEnvId = $derived($page.url.searchParams.get('edit'));
	let newEnv = $derived($page.url.searchParams.get('new') === 'true');

	function handleTabChange(tab: string) {
		goto(`/settings?tab=${tab}`, { replaceState: true, noScroll: true });
	}
</script>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<PageHeader icon={Settings} title="Settings" showConnection={false} />
	</div>

	<Tabs.Root value={activeTab} onValueChange={handleTabChange} class="w-full flex-1 min-h-0 flex flex-col">
		<Tabs.List class="w-full flex flex-wrap h-auto gap-1 p-1">
			<Tabs.Trigger value="general" class="flex-1 flex items-center justify-center gap-1.5">
				<Settings class="w-4 h-4" />
				General
			</Tabs.Trigger>
			<Tabs.Trigger value="environments" class="flex-1 flex items-center justify-center gap-1.5">
				<Globe class="w-4 h-4" />
				Environments
			</Tabs.Trigger>
			<Tabs.Trigger value="registries" class="flex-1 flex items-center justify-center gap-1.5">
				<Download class="w-4 h-4" />
				Registries
			</Tabs.Trigger>
			<Tabs.Trigger value="git" class="flex-1 flex items-center justify-center gap-1.5">
				<GitBranch class="w-4 h-4" />
				Git
			</Tabs.Trigger>
			<Tabs.Trigger value="config-sets" class="flex-1 flex items-center justify-center gap-1.5">
				<Layers class="w-4 h-4" />
				Config sets
			</Tabs.Trigger>
			<Tabs.Trigger value="notifications" class="flex-1 flex items-center justify-center gap-1.5">
				<Bell class="w-4 h-4" />
				Notifications
			</Tabs.Trigger>
			<Tabs.Trigger value="auth" class="flex-1 flex items-center justify-center gap-1.5">
				<Users class="w-4 h-4" />
				Authentication
			</Tabs.Trigger>
			<Tabs.Trigger value="license" class="flex-1 flex items-center justify-center gap-1.5">
				<Crown class="w-4 h-4" />
				License
			</Tabs.Trigger>
			<Tabs.Trigger value="about" class="flex-1 flex items-center justify-center gap-1.5">
				<Info class="w-4 h-4" />
				About
			</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="general" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'general'}<GeneralTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="environments" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'environments'}<EnvironmentsTab {editEnvId} {newEnv} />{/if}
		</Tabs.Content>

		<Tabs.Content value="registries" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'registries'}<RegistriesTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="git" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'git'}<GitTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="config-sets" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'config-sets'}<ConfigSetsTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="notifications" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'notifications'}<NotificationsTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="auth" class="flex-1 min-h-0 flex flex-col">
			{#if activeTab === 'auth'}<AuthTab onTabChange={handleTabChange} />{/if}
		</Tabs.Content>

		<Tabs.Content value="license" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'license'}<LicenseTab />{/if}
		</Tabs.Content>

		<Tabs.Content value="about" class="flex-1 min-h-0 overflow-y-auto">
			{#if activeTab === 'about'}<AboutTab />{/if}
		</Tabs.Content>
	</Tabs.Root>
</div>
