<script lang="ts">
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import {
		Box,
		RefreshCw,
		GitBranch,
		Layers,
		Shield,
		HardDrive,
		ChevronDown,
		ChevronRight
	} from 'lucide-svelte';

	interface EventType {
		id: string;
		label: string;
		description: string;
	}

	interface EventGroup {
		id: string;
		label: string;
		icon: typeof Box;
		events: EventType[];
	}

	interface Props {
		selectedEventTypes: string[];
		onchange: (eventTypes: string[]) => void;
		disabled?: boolean;
	}

	let { selectedEventTypes, onchange, disabled = false }: Props = $props();

	// Track collapsed state for groups
	let collapsedGroups = $state<Set<string>>(new Set());

	function toggleGroup(groupId: string) {
		if (collapsedGroups.has(groupId)) {
			collapsedGroups = new Set([...collapsedGroups].filter(id => id !== groupId));
		} else {
			collapsedGroups = new Set([...collapsedGroups, groupId]);
		}
	}

	// Notification event types - grouped by category with icons
	const NOTIFICATION_EVENT_GROUPS: EventGroup[] = [
		{
			id: 'container',
			label: 'Container events',
			icon: Box,
			events: [
				{ id: 'container_started', label: 'Container started', description: 'When a container starts running' },
				{ id: 'container_stopped', label: 'Container stopped', description: 'When a container is stopped' },
				{ id: 'container_restarted', label: 'Container restarted', description: 'When a container restarts' },
				{ id: 'container_exited', label: 'Container exited', description: 'When a container exits unexpectedly' },
				{ id: 'container_unhealthy', label: 'Container unhealthy', description: 'When a container health check fails' },
				{ id: 'container_healthy', label: 'Container healthy', description: 'When a container health check recovers' },
				{ id: 'container_oom', label: 'Container OOM killed', description: 'When a container is killed due to out of memory' },
				{ id: 'container_updated', label: 'Container updated', description: 'When a container image is updated' }
			]
		},
		{
			id: 'auto_update',
			label: 'Auto-update events',
			icon: RefreshCw,
			events: [
				{ id: 'auto_update_success', label: 'Update succeeded', description: 'Container successfully updated to new image' },
				{ id: 'auto_update_failed', label: 'Update failed', description: 'Container auto-update failed' },
				{ id: 'auto_update_blocked', label: 'Update blocked', description: 'Update blocked due to vulnerability criteria' },
				{ id: 'updates_detected', label: 'Updates detected', description: 'Container image updates are available' },
				{ id: 'batch_update_success', label: 'Batch update completed', description: 'Scheduled container updates completed' }
			]
		},
		{
			id: 'git_stack',
			label: 'Git stack events',
			icon: GitBranch,
			events: [
				{ id: 'git_sync_success', label: 'Git sync succeeded', description: 'Git stack synced and deployed successfully' },
				{ id: 'git_sync_failed', label: 'Git sync failed', description: 'Git stack sync or deploy failed' },
				{ id: 'git_sync_skipped', label: 'Git sync skipped', description: 'Git stack sync skipped (no changes)' }
			]
		},
		{
			id: 'stack',
			label: 'Stack events',
			icon: Layers,
			events: [
				{ id: 'stack_started', label: 'Stack started', description: 'When a compose stack starts' },
				{ id: 'stack_stopped', label: 'Stack stopped', description: 'When a compose stack stops' },
				{ id: 'stack_deployed', label: 'Stack deployed', description: 'Stack deployed (new or update)' },
				{ id: 'stack_deploy_failed', label: 'Stack deploy failed', description: 'Stack deployment failed' }
			]
		},
		{
			id: 'security',
			label: 'Security events',
			icon: Shield,
			events: [
				{ id: 'vulnerability_critical', label: 'Critical vulns found', description: 'Critical vulnerabilities found in image scan' },
				{ id: 'vulnerability_high', label: 'High vulns found', description: 'High severity vulnerabilities found' },
				{ id: 'vulnerability_any', label: 'Any vulns found', description: 'Any vulnerabilities found (medium/low)' }
			]
		},
		{
			id: 'system',
			label: 'System events',
			icon: HardDrive,
			events: [
				{ id: 'image_pulled', label: 'Image pulled', description: 'When a new image is pulled' },
				{ id: 'image_prune_success', label: 'Image prune completed', description: 'Scheduled image prune completed successfully' },
				{ id: 'image_prune_failed', label: 'Image prune failed', description: 'Scheduled image prune failed' },
				{ id: 'environment_offline', label: 'Environment offline', description: 'Environment became unreachable' },
				{ id: 'environment_online', label: 'Environment online', description: 'Environment came back online' },
				{ id: 'disk_space_warning', label: 'Disk space warning', description: 'Docker disk usage exceeds threshold' }
			]
		}
	];

	function toggleEvent(eventId: string) {
		if (disabled) return;

		const newTypes = selectedEventTypes.includes(eventId)
			? selectedEventTypes.filter(t => t !== eventId)
			: [...selectedEventTypes, eventId];
		onchange(newTypes);
	}

	function toggleGroupAll(group: EventGroup) {
		if (disabled) return;

		const groupEventIds = group.events.map(e => e.id);
		const allSelected = groupEventIds.every(id => selectedEventTypes.includes(id));

		let newTypes: string[];
		if (allSelected) {
			// Deselect all from this group
			newTypes = selectedEventTypes.filter(id => !groupEventIds.includes(id));
		} else {
			// Select all from this group
			const toAdd = groupEventIds.filter(id => !selectedEventTypes.includes(id));
			newTypes = [...selectedEventTypes, ...toAdd];
		}
		onchange(newTypes);
	}

	function getGroupSelectedCount(group: EventGroup): number {
		return group.events.filter(e => selectedEventTypes.includes(e.id)).length;
	}
</script>

<div class="space-y-2 max-h-[300px] overflow-y-auto pr-1">
	{#each NOTIFICATION_EVENT_GROUPS as group (group.id)}
		{@const isCollapsed = collapsedGroups.has(group.id)}
		{@const selectedCount = getGroupSelectedCount(group)}
		{@const allSelected = selectedCount === group.events.length}
		{@const someSelected = selectedCount > 0 && selectedCount < group.events.length}
		{@const GroupIcon = group.icon}

		<div class="rounded-lg border bg-card">
			<!-- Group Header -->
			<div
				class="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors rounded-t-lg cursor-pointer"
				role="button"
				tabindex="0"
				onclick={() => toggleGroup(group.id)}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(group.id); } }}
			>
				<div class="flex items-center gap-2">
					{#if isCollapsed}
						<ChevronRight class="w-4 h-4 text-muted-foreground" />
					{:else}
						<ChevronDown class="w-4 h-4 text-muted-foreground" />
					{/if}
					<GroupIcon class="w-4 h-4 text-muted-foreground" />
					<span class="text-sm font-medium">{group.label}</span>
					<span class="text-xs text-muted-foreground">
						({selectedCount}/{group.events.length})
					</span>
				</div>
				<button
					type="button"
					class="text-xs px-2 py-0.5 rounded border transition-colors {allSelected ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'}"
					onclick={(e) => { e.stopPropagation(); toggleGroupAll(group); }}
					{disabled}
				>
					{allSelected ? 'All' : someSelected ? 'Some' : 'None'}
				</button>
			</div>

			<!-- Group Events -->
			{#if !isCollapsed}
				<div class="ml-4 mb-2 border-l-2 border-muted bg-muted/20 rounded-bl">
					{#each group.events as event (event.id)}
						{@const isSelected = selectedEventTypes.includes(event.id)}
						<div class="flex items-center justify-between pl-3 pr-1 py-1.5 hover:bg-muted/40 transition-colors border-b border-border/30 last:border-b-0">
							<div class="flex-1 min-w-0 pr-2">
								<div class="text-xs font-medium">{event.label}</div>
								<div class="text-2xs text-muted-foreground truncate">{event.description}</div>
							</div>
							<TogglePill
								checked={isSelected}
								onchange={() => toggleEvent(event.id)}
								{disabled}
							/>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/each}
</div>
