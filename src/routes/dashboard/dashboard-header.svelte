<script lang="ts">
	import {
		ShieldCheck,
		Activity,
		Cpu,
		Wifi,
		WifiOff,
		Settings,
		Route,
		UndoDot,
		Unplug,
		Icon,
		CircleArrowUp,
		CircleFadingArrowUp,
		Loader2
	} from 'lucide-svelte';
	import { whale } from '@lucide/lab';
	import { getIconComponent } from '$lib/utils/icons';
	import { goto } from '$app/navigation';
	import { canAccess } from '$lib/stores/auth';
	import type { Component } from 'svelte';

	type ConnectionType = 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';

	interface Props {
		name: string;
		host?: string;
		port?: number | null;
		icon: string;
		socketPath?: string;
		online?: boolean; // undefined = connecting, false = offline, true = online
		scannerEnabled: boolean;
		collectActivity: boolean;
		collectMetrics: boolean;
		updateCheckEnabled?: boolean;
		updateCheckAutoUpdate?: boolean;
		connectionType?: ConnectionType;
		environmentId: number;
		width?: number;
		height?: number;
		compact?: boolean;
	}

	// Derived states for connecting/offline
	const showConnecting = $derived(online === undefined);
	const showOffline = $derived(online === false);

	let {
		name,
		host,
		port = null,
		icon,
		socketPath,
		online,
		scannerEnabled,
		collectActivity,
		collectMetrics,
		updateCheckEnabled = false,
		updateCheckAutoUpdate = false,
		connectionType = 'socket',
		environmentId,
		width = 1,
		height = 1,
		compact = false
	}: Props = $props();

	// Format host with port for display
	const hostDisplay = $derived(
		connectionType === 'socket' ? (socketPath || '/var/run/docker.sock') :
		connectionType === 'hawser-edge' ? 'Edge connection' :
		(port ? `${host}:${port}` : host || 'Unknown host')
	);

	const EnvIcon = $derived(getIconComponent(icon)) as Component;
	const canEdit = $derived($canAccess('environments', 'edit'));

	function openSettings(e: MouseEvent) {
		e.stopPropagation();
		goto(`/settings?tab=environments&edit=${environmentId}`);
	}

	function stopPointerPropagation(e: PointerEvent) {
		e.stopPropagation();
	}
</script>

{#if compact}
	<!-- Compact header for mini tiles -->
	<div class="flex items-center gap-2 min-w-0 flex-1">
		<div class="p-1.5 rounded-lg {online ? 'bg-primary/10' : 'bg-muted'}">
			<EnvIcon class="w-4 h-4 {online ? 'text-primary' : 'text-muted-foreground'}" />
		</div>
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-1.5">
				<span class="font-medium text-sm truncate">{name}</span>
				{#if showConnecting}
					<Loader2 class="w-3 h-3 text-muted-foreground animate-spin shrink-0" />
				{:else if showOffline}
					<WifiOff class="w-3 h-3 text-red-500 shrink-0" />
				{:else}
					<Wifi class="w-3 h-3 text-green-500 shrink-0" />
				{/if}
			</div>
			<span class="text-xs text-muted-foreground truncate block">{hostDisplay}</span>
		</div>
	</div>
{:else}
	<!-- Full header for standard tiles -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-2 min-w-0 flex-1">
			<div class="p-1.5 rounded-lg {online ? 'bg-primary/10' : 'bg-muted'}">
				<EnvIcon class="w-4 h-4 {online ? 'text-primary' : 'text-muted-foreground'}" />
			</div>
			{#if connectionType === 'socket' || !connectionType}
				<span title="Unix socket connection">
					<Unplug class="w-4 h-4 text-cyan-500 glow-cyan" />
				</span>
			{:else if connectionType === 'direct'}
				<span title="Direct Docker connection">
					<Icon iconNode={whale} class="w-4 h-4 text-blue-500 glow-blue" />
				</span>
			{:else if connectionType === 'hawser-standard'}
				<span title="Hawser agent (standard mode)">
					<Route class="w-4 h-4 text-purple-500 glow-purple" />
				</span>
			{:else if connectionType === 'hawser-edge'}
				<span title="Hawser agent (edge mode)">
					<UndoDot class="w-4 h-4 text-green-500 glow-green" />
				</span>
			{/if}
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1.5">
					<span class="font-medium text-sm truncate">{name}</span>
					{#if showConnecting}
						<Loader2 class="w-3 h-3 text-muted-foreground animate-spin shrink-0" />
					{:else if showOffline}
						<WifiOff class="w-3 h-3 text-red-500 shrink-0" />
					{:else}
						<Wifi class="w-3 h-3 text-green-500 shrink-0" />
					{/if}
				</div>
				<span class="text-xs text-muted-foreground truncate block">{hostDisplay}</span>
			</div>
		</div>

		<div class="flex items-center gap-1.5">
			{#if updateCheckEnabled}
				<span title={updateCheckAutoUpdate ? "Auto-update enabled" : "Update check enabled (notify only)"}>
					{#if updateCheckAutoUpdate}
						<CircleArrowUp class="w-4 h-4 text-green-500 glow-green" />
					{:else}
						<CircleFadingArrowUp class="w-4 h-4 text-green-500 glow-green" />
					{/if}
				</span>
			{/if}
			{#if scannerEnabled}
				<span title="Vulnerability scanning enabled">
					<ShieldCheck class="w-4 h-4 text-green-500 glow-green" />
				</span>
			{/if}
			{#if collectActivity}
				<span title="Activity collection enabled">
					<Activity class="w-4 h-4 text-amber-500 glow-amber" />
				</span>
			{/if}
			{#if collectMetrics}
				<span title="Metrics collection enabled">
					<Cpu class="w-4 h-4 text-sky-400 glow-sky" />
				</span>
			{/if}
			{#if canEdit}
				<button
					onpointerdown={stopPointerPropagation}
					onclick={openSettings}
					class="p-0.5 rounded hover:bg-muted transition-colors"
					title="Edit environment settings"
				>
					<Settings class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
				</button>
			{/if}
		</div>
	</div>
{/if}
