<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Wifi, WifiOff, ShieldCheck, Activity, Cpu, Settings, Unplug, Icon, Route, UndoDot, CircleArrowUp, CircleFadingArrowUp } from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import { getIconComponent } from '$lib/utils/icons';
	import { goto } from '$app/navigation';
	import { canAccess } from '$lib/stores/auth';
	import type { EnvironmentStats } from '../api/dashboard/stats/+server';
	import {
		DashboardHeader,
		DashboardLabels,
		DashboardContainerStats,
		DashboardHealthBanner,
		DashboardCpuMemoryBars,
		DashboardResourceStats,
		DashboardEventsSummary,
		DashboardRecentEvents,
		DashboardTopContainers,
		DashboardDiskUsage,
		DashboardCpuMemoryCharts,
		DashboardOfflineState
	} from '.';

	interface Props {
		stats: EnvironmentStats;
		width?: number;
		height?: number;
		oneventsclick?: () => void;
		showStacksBreakdown?: boolean;
	}

	let { stats, width = 1, height = 1, oneventsclick, showStacksBreakdown = true }: Props = $props();

	const EnvIcon = $derived(getIconComponent(stats.icon));

	// Specific tile size conditionals for easy customization
	const is1x1 = $derived(width === 1 && height === 1);
	const is1x2 = $derived(width === 1 && height === 2);
	const is1x3 = $derived(width === 1 && height === 3);
	const is1x4 = $derived(width === 1 && height >= 4);
	const is2x1 = $derived(width >= 2 && height === 1);
	const is2x2 = $derived(width >= 2 && height === 2);
	const is2x3 = $derived(width >= 2 && height === 3);
	const is2x4 = $derived(width >= 2 && height >= 4);

	// Helper flags
	const isMini = $derived(is1x1 || is2x1);
	const isWide = $derived(width >= 2);
	// Show offline when online is explicitly false
	// Only delay showing offline if online is undefined (truly unknown state during initial load)
	const isStillLoading = $derived(stats.loading && Object.values(stats.loading).some(v => v === true));
	const showOffline = $derived(stats.online === false || (!stats.online && !isStillLoading));
</script>

<Card.Root
	class="hover:shadow-[inset_0_0_0_2px_hsl(var(--primary)/0.2)] transition-all duration-200 h-full overflow-hidden {showOffline ? 'opacity-60' : ''}"
>
	<!-- ==================== 1x1 TILE ==================== -->
	{#if is1x1}
		<Card.Header class="pb-2 overflow-hidden">
			<!-- Unified header row -->
			<div class="flex items-center justify-between gap-2 w-full overflow-hidden">
				<!-- Left: Icons + Name/Host -->
				<div class="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
					<div class="p-1.5 rounded-lg shrink-0 {stats.online ? 'bg-primary/10' : 'bg-muted'}">
						<EnvIcon class="w-4 h-4 {stats.online ? 'text-primary' : 'text-muted-foreground'}" />
					</div>
					{#if stats.connectionType === 'socket' || !stats.connectionType}
						<span title="Unix socket connection" class="shrink-0">
							<Unplug class="w-4 h-4 text-cyan-500 glow-cyan" />
						</span>
					{:else if stats.connectionType === 'direct'}
						<span title="Direct Docker connection" class="shrink-0">
							<Icon iconNode={whale} class="w-4 h-4 text-blue-500 glow-blue" />
						</span>
					{:else if stats.connectionType === 'hawser-standard'}
						<span title="Hawser agent (standard mode)" class="shrink-0">
							<Route class="w-4 h-4 text-purple-500 glow-purple" />
						</span>
					{:else if stats.connectionType === 'hawser-edge'}
						<span title="Hawser agent (edge mode)" class="shrink-0">
							<UndoDot class="w-4 h-4 text-green-500 glow-green" />
						</span>
					{/if}
					<div class="min-w-0 overflow-hidden">
						<div class="flex items-center gap-1.5">
							<span class="font-medium text-sm truncate">{stats.name}</span>
							{#if !showOffline}
								<Wifi class="w-3 h-3 text-green-500 shrink-0" />
							{:else}
								<WifiOff class="w-3 h-3 text-red-500 shrink-0" />
							{/if}
						</div>
						<span class="text-xs text-muted-foreground truncate block" title={stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') : stats.connectionType === 'hawser-edge' ? 'Edge connection' : (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}>
							{stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') :
							 stats.connectionType === 'hawser-edge' ? 'Edge connection' :
							 (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}
						</span>
					</div>
				</div>
				<!-- Right: Status icons + Settings -->
				<div class="flex items-center gap-2 shrink-0">
					{#if stats.updateCheckEnabled}
						<span title={stats.updateCheckAutoUpdate ? "Auto-update enabled" : "Update check enabled (notify only)"}>
							{#if stats.updateCheckAutoUpdate}
								<CircleArrowUp class="w-4 h-4 text-green-500 glow-green" />
							{:else}
								<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green" />
							{/if}
						</span>
					{/if}
					{#if stats.scannerEnabled}
						<span title="Vulnerability scanning enabled">
							<ShieldCheck class="w-4 h-4 text-green-500 glow-green" />
						</span>
					{/if}
					{#if stats.collectActivity}
						<span title="Activity collection enabled">
							<Activity class="w-4 h-4 text-amber-500 glow-amber" />
						</span>
					{/if}
					{#if stats.collectMetrics}
						<span title="Metrics collection enabled">
							<Cpu class="w-4 h-4 text-sky-400 glow-sky" />
						</span>
					{/if}
					{#if $canAccess('environments', 'edit')}
						<button
							onpointerdown={(e) => e.stopPropagation()}
							onclick={(e) => { e.stopPropagation(); goto(`/settings?tab=environments&edit=${stats.id}`); }}
							class="p-0.5 rounded hover:bg-muted transition-colors"
							title="Edit environment settings"
						>
							<Settings class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
						</button>
					{/if}
				</div>
			</div>
		</Card.Header>
		<DashboardLabels labels={stats.labels} />
		<Card.Content class="overflow-hidden">
			{#if !showOffline}
				<div class="space-y-2">
					<DashboardContainerStats containers={stats.containers} loading={stats.loading?.containers} />
					<DashboardHealthBanner unhealthy={stats.containers.unhealthy} restarting={stats.containers.restarting} />
				</div>
			{:else}
				<DashboardOfflineState error={stats.error} compact={isMini} />
			{/if}
		</Card.Content>

	<!-- ==================== 2x1 TILE ==================== -->
	{:else if is2x1}
		<Card.Header class="pb-2 overflow-hidden">
			<!-- Unified header row -->
			<div class="flex items-center justify-between gap-2 w-full overflow-hidden">
				<!-- Left: Icons + Name/Host -->
				<div class="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
					<div class="p-1.5 rounded-lg shrink-0 {stats.online ? 'bg-primary/10' : 'bg-muted'}">
						<EnvIcon class="w-4 h-4 {stats.online ? 'text-primary' : 'text-muted-foreground'}" />
					</div>
					{#if stats.connectionType === 'socket' || !stats.connectionType}
						<span title="Unix socket connection" class="shrink-0">
							<Unplug class="w-4 h-4 text-cyan-500 glow-cyan" />
						</span>
					{:else if stats.connectionType === 'direct'}
						<span title="Direct Docker connection" class="shrink-0">
							<Icon iconNode={whale} class="w-4 h-4 text-blue-500 glow-blue" />
						</span>
					{:else if stats.connectionType === 'hawser-standard'}
						<span title="Hawser agent (standard mode)" class="shrink-0">
							<Route class="w-4 h-4 text-purple-500 glow-purple" />
						</span>
					{:else if stats.connectionType === 'hawser-edge'}
						<span title="Hawser agent (edge mode)" class="shrink-0">
							<UndoDot class="w-4 h-4 text-green-500 glow-green" />
						</span>
					{/if}
					<div class="min-w-0 overflow-hidden">
						<div class="flex items-center gap-1.5">
							<span class="font-medium text-sm truncate">{stats.name}</span>
							{#if !showOffline}
								<Wifi class="w-3 h-3 text-green-500 shrink-0" />
							{:else}
								<WifiOff class="w-3 h-3 text-red-500 shrink-0" />
							{/if}
						</div>
						<span class="text-xs text-muted-foreground truncate block" title={stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') : stats.connectionType === 'hawser-edge' ? 'Edge connection' : (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}>
							{stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') :
							 stats.connectionType === 'hawser-edge' ? 'Edge connection' :
							 (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}
						</span>
					</div>
				</div>
				<!-- Right: Status icons + Settings -->
				<div class="flex items-center gap-2 shrink-0">
					{#if stats.updateCheckEnabled}
						<span title={stats.updateCheckAutoUpdate ? "Auto-update enabled" : "Update check enabled (notify only)"}>
							{#if stats.updateCheckAutoUpdate}
								<CircleArrowUp class="w-4 h-4 text-green-500 glow-green" />
							{:else}
								<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green" />
							{/if}
						</span>
					{/if}
					{#if stats.scannerEnabled}
						<span title="Vulnerability scanning enabled">
							<ShieldCheck class="w-4 h-4 text-green-500 glow-green" />
						</span>
					{/if}
					{#if stats.collectActivity}
						<span title="Activity collection enabled">
							<Activity class="w-4 h-4 text-amber-500 glow-amber" />
						</span>
					{/if}
					{#if stats.collectMetrics}
						<span title="Metrics collection enabled">
							<Cpu class="w-4 h-4 text-sky-400 glow-sky" />
						</span>
					{/if}
					{#if $canAccess('environments', 'edit')}
						<button
							onpointerdown={(e) => e.stopPropagation()}
							onclick={(e) => { e.stopPropagation(); goto(`/settings?tab=environments&edit=${stats.id}`); }}
							class="p-0.5 rounded hover:bg-muted transition-colors"
							title="Edit environment settings"
						>
							<Settings class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
						</button>
					{/if}
				</div>
			</div>
		</Card.Header>
		<DashboardLabels labels={stats.labels} />
		<Card.Content class="overflow-hidden">
			{#if !showOffline}
				<div class="flex gap-4">
					<div class="space-y-2">
						<DashboardContainerStats containers={stats.containers} loading={stats.loading?.containers} />
						<DashboardHealthBanner unhealthy={stats.containers.unhealthy} restarting={stats.containers.restarting} />
					</div>
					{#if stats.recentEvents}
						<div class="border-l border-border/50 pl-4 flex-1">
							<DashboardRecentEvents events={stats.recentEvents} limit={2} onclick={oneventsclick} />
						</div>
					{/if}
				</div>
			{:else}
				<DashboardOfflineState error={stats.error} compact={isMini} />
			{/if}
		</Card.Content>

	<!-- ==================== 1x2 TILE ==================== -->
	{:else if is1x2}
		<Card.Header class="pb-2 overflow-hidden">
			<!-- Unified header row -->
			<div class="flex items-center justify-between gap-2 w-full overflow-hidden">
			<!-- Left: Icons + Name/Host -->
			<div class="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
				<div class="p-1.5 rounded-lg shrink-0 {stats.online ? 'bg-primary/10' : 'bg-muted'}">
					<EnvIcon class="w-4 h-4 {stats.online ? 'text-primary' : 'text-muted-foreground'}" />
				</div>
				{#if stats.connectionType === 'socket' || !stats.connectionType}
					<span title="Unix socket connection" class="shrink-0">
						<Unplug class="w-4 h-4 text-cyan-500 glow-cyan" />
					</span>
				{:else if stats.connectionType === 'direct'}
					<span title="Direct Docker connection" class="shrink-0">
						<Icon iconNode={whale} class="w-4 h-4 text-blue-500 glow-blue" />
					</span>
				{:else if stats.connectionType === 'hawser-standard'}
					<span title="Hawser agent (standard mode)" class="shrink-0">
						<Route class="w-4 h-4 text-purple-500 glow-purple" />
					</span>
				{:else if stats.connectionType === 'hawser-edge'}
					<span title="Hawser agent (edge mode)" class="shrink-0">
						<UndoDot class="w-4 h-4 text-green-500 glow-green" />
					</span>
				{/if}
				<div class="min-w-0 overflow-hidden">
					<div class="flex items-center gap-1.5">
						<span class="font-medium text-sm truncate">{stats.name}</span>
						{#if !showOffline}
							<Wifi class="w-3 h-3 text-green-500 shrink-0" />
						{:else}
							<WifiOff class="w-3 h-3 text-red-500 shrink-0" />
						{/if}
					</div>
					<span class="text-xs text-muted-foreground truncate block" title={stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') : stats.connectionType === 'hawser-edge' ? 'Edge connection' : (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}>
						{stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') :
						 stats.connectionType === 'hawser-edge' ? 'Edge connection' :
						 (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}
					</span>
				</div>
			</div>
			<!-- Right: Status icons + Settings -->
			<div class="flex items-center gap-2 shrink-0">
				{#if stats.updateCheckEnabled}
					<span title={stats.updateCheckAutoUpdate ? "Auto-update enabled" : "Update check enabled (notify only)"}>
						{#if stats.updateCheckAutoUpdate}
							<CircleArrowUp class="w-4 h-4 text-green-500 glow-green" />
						{:else}
							<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green" />
						{/if}
					</span>
				{/if}
				{#if stats.scannerEnabled}
					<span title="Vulnerability scanning enabled">
						<ShieldCheck class="w-4 h-4 text-green-500 glow-green" />
					</span>
				{/if}
				{#if stats.collectActivity}
					<span title="Activity collection enabled">
						<Activity class="w-4 h-4 text-amber-500 glow-amber" />
					</span>
				{/if}
				{#if stats.collectMetrics}
					<span title="Metrics collection enabled">
						<Cpu class="w-4 h-4 text-sky-400 glow-sky" />
					</span>
				{/if}
				{#if $canAccess('environments', 'edit')}
					<button
						onpointerdown={(e) => e.stopPropagation()}
						onclick={(e) => { e.stopPropagation(); goto(`/settings?tab=environments&edit=${stats.id}`); }}
						class="p-0.5 rounded hover:bg-muted transition-colors"
						title="Edit environment settings"
					>
						<Settings class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
					</button>
				{/if}
			</div>
			</div>
		</Card.Header>
		<DashboardLabels labels={stats.labels} />
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			{#if !showOffline}
				<div class="space-y-3">
					<DashboardContainerStats containers={stats.containers} loading={stats.loading?.containers} />
					<DashboardHealthBanner unhealthy={stats.containers.unhealthy} restarting={stats.containers.restarting} />
					{#if stats.collectMetrics && stats.metrics}
						<DashboardCpuMemoryBars metrics={stats.metrics} collectMetrics={stats.collectMetrics} />
					{/if}
					<DashboardResourceStats images={stats.images} volumes={stats.volumes} networks={stats.networks} stacks={stats.stacks} loading={stats.loading} showStacksBreakdown={showStacksBreakdown} />
					<DashboardEventsSummary today={stats.events.today} total={stats.events.total} />
				</div>
			{:else}
				<DashboardOfflineState error={stats.error} compact={isMini} />
			{/if}
		</Card.Content>

	<!-- ==================== 1x3 TILE ==================== -->
	{:else if is1x3}
		<Card.Header class="pb-2 overflow-hidden">
			<!-- Unified header row -->
			<div class="flex items-center justify-between gap-2 w-full overflow-hidden">
			<!-- Left: Icons + Name/Host -->
			<div class="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
				<div class="p-1.5 rounded-lg shrink-0 {stats.online ? 'bg-primary/10' : 'bg-muted'}">
					<EnvIcon class="w-4 h-4 {stats.online ? 'text-primary' : 'text-muted-foreground'}" />
				</div>
				{#if stats.connectionType === 'socket' || !stats.connectionType}
					<span title="Unix socket connection" class="shrink-0">
						<Unplug class="w-4 h-4 text-cyan-500 glow-cyan" />
					</span>
				{:else if stats.connectionType === 'direct'}
					<span title="Direct Docker connection" class="shrink-0">
						<Icon iconNode={whale} class="w-4 h-4 text-blue-500 glow-blue" />
					</span>
				{:else if stats.connectionType === 'hawser-standard'}
					<span title="Hawser agent (standard mode)" class="shrink-0">
						<Route class="w-4 h-4 text-purple-500 glow-purple" />
					</span>
				{:else if stats.connectionType === 'hawser-edge'}
					<span title="Hawser agent (edge mode)" class="shrink-0">
						<UndoDot class="w-4 h-4 text-green-500 glow-green" />
					</span>
				{/if}
				<div class="min-w-0 overflow-hidden">
					<div class="flex items-center gap-1.5">
						<span class="font-medium text-sm truncate">{stats.name}</span>
						{#if !showOffline}
							<Wifi class="w-3 h-3 text-green-500 shrink-0" />
						{:else}
							<WifiOff class="w-3 h-3 text-red-500 shrink-0" />
						{/if}
					</div>
					<span class="text-xs text-muted-foreground truncate block" title={stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') : stats.connectionType === 'hawser-edge' ? 'Edge connection' : (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}>
						{stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') :
						 stats.connectionType === 'hawser-edge' ? 'Edge connection' :
						 (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}
					</span>
				</div>
			</div>
			<!-- Right: Status icons + Settings -->
			<div class="flex items-center gap-2 shrink-0">
				{#if stats.updateCheckEnabled}
					<span title={stats.updateCheckAutoUpdate ? "Auto-update enabled" : "Update check enabled (notify only)"}>
						{#if stats.updateCheckAutoUpdate}
							<CircleArrowUp class="w-4 h-4 text-green-500 glow-green" />
						{:else}
							<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green" />
						{/if}
					</span>
				{/if}
				{#if stats.scannerEnabled}
					<span title="Vulnerability scanning enabled">
						<ShieldCheck class="w-4 h-4 text-green-500 glow-green" />
					</span>
				{/if}
				{#if stats.collectActivity}
					<span title="Activity collection enabled">
						<Activity class="w-4 h-4 text-amber-500 glow-amber" />
					</span>
				{/if}
				{#if stats.collectMetrics}
					<span title="Metrics collection enabled">
						<Cpu class="w-4 h-4 text-sky-400 glow-sky" />
					</span>
				{/if}
				{#if $canAccess('environments', 'edit')}
					<button
						onpointerdown={(e) => e.stopPropagation()}
						onclick={(e) => { e.stopPropagation(); goto(`/settings?tab=environments&edit=${stats.id}`); }}
						class="p-0.5 rounded hover:bg-muted transition-colors"
						title="Edit environment settings"
					>
						<Settings class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
					</button>
				{/if}
			</div>
			</div>
		</Card.Header>
		<DashboardLabels labels={stats.labels} />
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			{#if !showOffline}
				<div class="space-y-3">
					<DashboardContainerStats containers={stats.containers} loading={stats.loading?.containers} />
					<DashboardHealthBanner unhealthy={stats.containers.unhealthy} restarting={stats.containers.restarting} />
					{#if stats.collectMetrics && stats.metrics}
						<DashboardCpuMemoryBars metrics={stats.metrics} collectMetrics={stats.collectMetrics} />
					{/if}
					<DashboardResourceStats images={stats.images} volumes={stats.volumes} networks={stats.networks} stacks={stats.stacks} loading={stats.loading} showStacksBreakdown={showStacksBreakdown} />
					<DashboardEventsSummary today={stats.events.today} total={stats.events.total} />
					{#if stats.recentEvents}
						<DashboardRecentEvents events={stats.recentEvents} limit={8} onclick={oneventsclick} />
					{/if}
				</div>
			{:else}
				<DashboardOfflineState error={stats.error} compact={isMini} />
			{/if}
		</Card.Content>

	<!-- ==================== 1x4 TILE ==================== -->
	{:else if is1x4}
		<Card.Header class="pb-2 overflow-hidden">
			<!-- Unified header row -->
			<div class="flex items-center justify-between gap-2 w-full overflow-hidden">
			<!-- Left: Icons + Name/Host -->
			<div class="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
				<div class="p-1.5 rounded-lg shrink-0 {stats.online ? 'bg-primary/10' : 'bg-muted'}">
					<EnvIcon class="w-4 h-4 {stats.online ? 'text-primary' : 'text-muted-foreground'}" />
				</div>
				{#if stats.connectionType === 'socket' || !stats.connectionType}
					<span title="Unix socket connection" class="shrink-0">
						<Unplug class="w-4 h-4 text-cyan-500 glow-cyan" />
					</span>
				{:else if stats.connectionType === 'direct'}
					<span title="Direct Docker connection" class="shrink-0">
						<Icon iconNode={whale} class="w-4 h-4 text-blue-500 glow-blue" />
					</span>
				{:else if stats.connectionType === 'hawser-standard'}
					<span title="Hawser agent (standard mode)" class="shrink-0">
						<Route class="w-4 h-4 text-purple-500 glow-purple" />
					</span>
				{:else if stats.connectionType === 'hawser-edge'}
					<span title="Hawser agent (edge mode)" class="shrink-0">
						<UndoDot class="w-4 h-4 text-green-500 glow-green" />
					</span>
				{/if}
				<div class="min-w-0 overflow-hidden">
					<div class="flex items-center gap-1.5">
						<span class="font-medium text-sm truncate">{stats.name}</span>
						{#if !showOffline}
							<Wifi class="w-3 h-3 text-green-500 shrink-0" />
						{:else}
							<WifiOff class="w-3 h-3 text-red-500 shrink-0" />
						{/if}
					</div>
					<span class="text-xs text-muted-foreground truncate block" title={stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') : stats.connectionType === 'hawser-edge' ? 'Edge connection' : (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}>
						{stats.connectionType === 'socket' ? (stats.socketPath || '/var/run/docker.sock') :
						 stats.connectionType === 'hawser-edge' ? 'Edge connection' :
						 (stats.port ? `${stats.host}:${stats.port}` : stats.host || 'Unknown host')}
					</span>
				</div>
			</div>
			<!-- Right: Status icons + Settings -->
			<div class="flex items-center gap-2 shrink-0">
				{#if stats.updateCheckEnabled}
					<span title={stats.updateCheckAutoUpdate ? "Auto-update enabled" : "Update check enabled (notify only)"}>
						{#if stats.updateCheckAutoUpdate}
							<CircleArrowUp class="w-4 h-4 text-green-500 glow-green" />
						{:else}
							<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green" />
						{/if}
					</span>
				{/if}
				{#if stats.scannerEnabled}
					<span title="Vulnerability scanning enabled">
						<ShieldCheck class="w-4 h-4 text-green-500 glow-green" />
					</span>
				{/if}
				{#if stats.collectActivity}
					<span title="Activity collection enabled">
						<Activity class="w-4 h-4 text-amber-500 glow-amber" />
					</span>
				{/if}
				{#if stats.collectMetrics}
					<span title="Metrics collection enabled">
						<Cpu class="w-4 h-4 text-sky-400 glow-sky" />
					</span>
				{/if}
				{#if $canAccess('environments', 'edit')}
					<button
						onpointerdown={(e) => e.stopPropagation()}
						onclick={(e) => { e.stopPropagation(); goto(`/settings?tab=environments&edit=${stats.id}`); }}
						class="p-0.5 rounded hover:bg-muted transition-colors"
						title="Edit environment settings"
					>
						<Settings class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
					</button>
				{/if}
			</div>
			</div>
		</Card.Header>
		<DashboardLabels labels={stats.labels} />
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			{#if !showOffline}
				<div class="space-y-3">
					<DashboardContainerStats containers={stats.containers} loading={stats.loading?.containers} />
					<DashboardHealthBanner unhealthy={stats.containers.unhealthy} restarting={stats.containers.restarting} />
					{#if stats.collectMetrics && stats.metrics}
						<DashboardCpuMemoryBars metrics={stats.metrics} collectMetrics={stats.collectMetrics} />
					{/if}
					<DashboardResourceStats images={stats.images} volumes={stats.volumes} networks={stats.networks} stacks={stats.stacks} loading={stats.loading} showStacksBreakdown={showStacksBreakdown} />
					<DashboardEventsSummary today={stats.events.today} total={stats.events.total} />
					{#if stats.recentEvents}
						<DashboardRecentEvents events={stats.recentEvents} limit={8} onclick={oneventsclick} />
					{/if}
					<DashboardTopContainers containers={stats.topContainers} limit={8} loading={stats.loading?.topContainers} />
				</div>
			{:else}
				<DashboardOfflineState error={stats.error} compact={isMini} />
			{/if}
		</Card.Content>

	<!-- ==================== 2x2 TILE ==================== -->
	{:else if is2x2}
		<Card.Header class="pb-2">
			<DashboardHeader
				name={stats.name}
				host={stats.host}
				port={stats.port}
				icon={stats.icon}
				socketPath={stats.socketPath}

				online={stats.online}
				scannerEnabled={stats.scannerEnabled}
				collectActivity={stats.collectActivity}
				collectMetrics={stats.collectMetrics}
				updateCheckEnabled={stats.updateCheckEnabled}
				updateCheckAutoUpdate={stats.updateCheckAutoUpdate}
				connectionType={stats.connectionType}
				environmentId={stats.id}
				{width}
				{height}
			/>
		</Card.Header>
		<DashboardLabels labels={stats.labels} />
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			{#if !showOffline}
				<div class="grid grid-cols-2 gap-4">
					<!-- Left column -->
					<div class="space-y-3">
						<DashboardContainerStats containers={stats.containers} loading={stats.loading?.containers} />
						<DashboardHealthBanner unhealthy={stats.containers.unhealthy} restarting={stats.containers.restarting} />
						{#if stats.metrics}
							<DashboardCpuMemoryBars metrics={stats.metrics} collectMetrics={stats.collectMetrics} />
						{/if}
						<DashboardResourceStats images={stats.images} volumes={stats.volumes} networks={stats.networks} stacks={stats.stacks} loading={stats.loading} showStacksBreakdown={showStacksBreakdown} />
						<DashboardEventsSummary today={stats.events.today} total={stats.events.total} />
					</div>
					<!-- Right column -->
					<div class="space-y-3 border-l border-border/50 pl-4">
						<DashboardTopContainers containers={stats.topContainers} limit={8} loading={stats.loading?.topContainers} />
					</div>
				</div>
			{:else}
				<DashboardOfflineState error={stats.error} compact={isMini} />
			{/if}
		</Card.Content>

	<!-- ==================== 2x3 TILE ==================== -->
	{:else if is2x3}
		<Card.Header class="pb-2">
			<DashboardHeader
				name={stats.name}
				host={stats.host}
				port={stats.port}
				icon={stats.icon}
				socketPath={stats.socketPath}

				online={stats.online}
				scannerEnabled={stats.scannerEnabled}
				collectActivity={stats.collectActivity}
				collectMetrics={stats.collectMetrics}
				updateCheckEnabled={stats.updateCheckEnabled}
				updateCheckAutoUpdate={stats.updateCheckAutoUpdate}
				connectionType={stats.connectionType}
				environmentId={stats.id}
				{width}
				{height}
			/>
		</Card.Header>
		<DashboardLabels labels={stats.labels} />
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			{#if !showOffline}
				<div class="grid grid-cols-2 gap-4">
					<!-- Left column -->
					<div class="space-y-3">
						<DashboardContainerStats containers={stats.containers} loading={stats.loading?.containers} />
						<DashboardHealthBanner unhealthy={stats.containers.unhealthy} restarting={stats.containers.restarting} />
						{#if stats.metrics}
							<DashboardCpuMemoryBars metrics={stats.metrics} collectMetrics={stats.collectMetrics} />
						{/if}
						<DashboardResourceStats images={stats.images} volumes={stats.volumes} networks={stats.networks} stacks={stats.stacks} loading={stats.loading} showStacksBreakdown={showStacksBreakdown} />
						<DashboardEventsSummary today={stats.events.today} total={stats.events.total} />
						{#if stats.recentEvents}
							<DashboardRecentEvents events={stats.recentEvents} limit={5} onclick={oneventsclick} />
						{/if}
					</div>
					<!-- Right column -->
					<div class="space-y-3 border-l border-border/50 pl-4">
						<DashboardTopContainers containers={stats.topContainers} limit={10} loading={stats.loading?.topContainers} />
						{#if stats.collectMetrics && stats.metrics && stats.metricsHistory}
							<DashboardCpuMemoryCharts metricsHistory={stats.metricsHistory} metrics={stats.metrics} />
						{/if}
					</div>
				</div>
			{:else}
				<DashboardOfflineState error={stats.error} compact={isMini} />
			{/if}
		</Card.Content>

	<!-- ==================== 2x4 TILE ==================== -->
	{:else if is2x4}
		<Card.Header class="pb-2">
			<DashboardHeader
				name={stats.name}
				host={stats.host}
				port={stats.port}
				icon={stats.icon}
				socketPath={stats.socketPath}

				online={stats.online}
				scannerEnabled={stats.scannerEnabled}
				collectActivity={stats.collectActivity}
				collectMetrics={stats.collectMetrics}
				updateCheckEnabled={stats.updateCheckEnabled}
				updateCheckAutoUpdate={stats.updateCheckAutoUpdate}
				connectionType={stats.connectionType}
				environmentId={stats.id}
				{width}
				{height}
			/>
		</Card.Header>
		<DashboardLabels labels={stats.labels} />
		<Card.Content class="overflow-auto" style="max-height: calc(100% - 60px);">
			{#if !showOffline}
				<div class="grid grid-cols-2 gap-4">
					<!-- Left column -->
					<div class="space-y-3">
						<DashboardContainerStats containers={stats.containers} loading={stats.loading?.containers} />
						<DashboardHealthBanner unhealthy={stats.containers.unhealthy} restarting={stats.containers.restarting} />
						{#if stats.metrics}
							<DashboardCpuMemoryBars metrics={stats.metrics} collectMetrics={stats.collectMetrics} />
						{/if}
						<DashboardResourceStats images={stats.images} volumes={stats.volumes} networks={stats.networks} stacks={stats.stacks} loading={stats.loading} showStacksBreakdown={showStacksBreakdown} />
						<DashboardEventsSummary today={stats.events.today} total={stats.events.total} />
						{#if stats.recentEvents}
							<DashboardRecentEvents events={stats.recentEvents} limit={10} onclick={oneventsclick} />
						{/if}
						<DashboardTopContainers containers={stats.topContainers} limit={10} loading={stats.loading?.topContainers} />
					</div>
					<!-- Right column -->
					<div class="space-y-3 border-l border-border/50 pl-4">
						{#if stats.collectMetrics && stats.metrics && stats.metricsHistory}
							<DashboardCpuMemoryCharts metricsHistory={stats.metricsHistory} metrics={stats.metrics} />
						{/if}
						<DashboardDiskUsage imagesSize={stats.images.totalSize} volumesSize={stats.volumes.totalSize} containersSize={stats.containersSize} buildCacheSize={stats.buildCacheSize} showPieChart={true} loading={stats.loading?.diskUsage} />
					</div>
				</div>
			{:else}
				<DashboardOfflineState error={stats.error} compact={isMini} />
			{/if}
		</Card.Content>
	{/if}
</Card.Root>
