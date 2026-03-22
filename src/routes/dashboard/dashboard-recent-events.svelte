<script lang="ts">
	import {
		Activity,
		Play,
		Square,
		Skull,
		Zap,
		RotateCcw,
		Pause,
		CirclePlay,
		Trash2,
		Plus,
		Pencil,
		AlertTriangle,
		Heart
	} from 'lucide-svelte';
	import type { Component } from 'svelte';
	import { formatDateTime } from '$lib/stores/settings';

	interface Event {
		container_name: string;
		action: string;
		timestamp: string;
	}

	interface Props {
		events: Event[];
		limit?: number;
		onclick?: () => void;
	}

	let { events, limit = 8, onclick }: Props = $props();

	function getActionIcon(action: string): Component {
		switch (action) {
			case 'create': return Plus;
			case 'start': return Play;
			case 'stop': return Square;
			case 'die': return Skull;
			case 'kill': return Zap;
			case 'restart': return RotateCcw;
			case 'pause': return Pause;
			case 'unpause': return CirclePlay;
			case 'destroy': return Trash2;
			case 'rename': return Pencil;
			case 'update': return Pencil;
			case 'oom': return AlertTriangle;
			case 'health_status': return Heart;
			default: return Activity;
		}
	}

	function getActionColor(action: string): string {
		switch (action) {
			case 'create':
			case 'start':
			case 'unpause':
				return 'text-emerald-600 dark:text-emerald-400';
			case 'stop':
			case 'die':
			case 'kill':
			case 'destroy':
			case 'oom':
				return 'text-rose-600 dark:text-rose-400';
			case 'restart':
			case 'pause':
			case 'update':
			case 'rename':
				return 'text-amber-600 dark:text-amber-400';
			case 'health_status':
				return 'text-sky-600 dark:text-sky-400';
			default:
				return 'text-slate-600 dark:text-slate-400';
		}
	}

	function formatTime(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);

		if (diffMins < 1) return 'now';
		if (diffMins < 60) return `${diffMins}m`;

		const diffHours = Math.floor(diffMins / 60);
		if (diffHours < 24) return `${diffHours}h`;

		const diffDays = Math.floor(diffHours / 24);
		return `${diffDays}d`;
	}
</script>

{#if events && events.length > 0}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="pt-2 border-t border-border/50 {onclick ? 'cursor-pointer hover:bg-muted/50 -mx-2 px-2 rounded transition-colors' : ''}"
		onclick={(e) => {
			if (onclick) {
				e.stopPropagation();
				onclick();
			}
		}}
		onpointerdown={(e) => {
			if (onclick) {
				e.stopPropagation();
			}
		}}
	>
		<div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
			<Activity class="w-3 h-3" />
			<span class="font-medium">Recent events</span>
		</div>
		<!-- Grid layout with fixed columns: timestamp, action icon, container name -->
		<div class="grid grid-cols-[auto_auto_1fr] gap-x-2 gap-y-1 text-xs">
			{#each events.slice(0, limit) as event}
				<!-- Timestamp -->
				<span class="text-muted-foreground text-2xs" title={formatDateTime(event.timestamp)}>
					{formatTime(event.timestamp)}
				</span>
				{@const ActionIcon = getActionIcon(event.action)}
				<!-- Action icon -->
				<div class="flex items-center justify-center {getActionColor(event.action)}" title={event.action}>
					<ActionIcon class="w-3 h-3" />
				</div>
				<!-- Container name -->
				<span class="truncate text-foreground" title={event.container_name}>
					{event.container_name}
				</span>
			{/each}
		</div>
	</div>
{/if}
