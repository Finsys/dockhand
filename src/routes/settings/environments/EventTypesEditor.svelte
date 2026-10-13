<script lang="ts">
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import {
		Box,
		RefreshCw,
		GitBranch,
		Layers,
		Shield,
		HardDrive,
		Archive,
		ChevronDown,
		ChevronRight
	} from 'lucide-svelte';
	import { page } from '$app/stores'; // BETA GATE: backups feature flag
	import { m } from '$lib/paraglide/messages.js';

	interface EventType {
		id: string;
		// Functions so the texts are read in the active language at render time
		label: () => string;
		description: () => string;
	}

	interface EventGroup {
		id: string;
		label: () => string;
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
			label: m.settings_envs_event_group_container,
			icon: Box,
			events: [
				{ id: 'container_started', label: m.settings_envs_event_container_started, description: m.settings_envs_event_container_started_desc },
				{ id: 'container_stopped', label: m.settings_envs_event_container_stopped, description: m.settings_envs_event_container_stopped_desc },
				{ id: 'container_restarted', label: m.settings_envs_event_container_restarted, description: m.settings_envs_event_container_restarted_desc },
				{ id: 'container_exited', label: m.settings_envs_event_container_exited, description: m.settings_envs_event_container_exited_desc },
				{ id: 'container_unhealthy', label: m.settings_envs_event_container_unhealthy, description: m.settings_envs_event_container_unhealthy_desc },
				{ id: 'container_healthy', label: m.settings_envs_event_container_healthy, description: m.settings_envs_event_container_healthy_desc },
				{ id: 'container_oom', label: m.settings_envs_event_container_oom, description: m.settings_envs_event_container_oom_desc },
				{ id: 'container_updated', label: m.settings_envs_event_container_updated, description: m.settings_envs_event_container_updated_desc }
			]
		},
		{
			id: 'auto_update',
			label: m.settings_envs_event_group_auto_update,
			icon: RefreshCw,
			events: [
				{ id: 'auto_update_success', label: m.settings_envs_event_auto_update_success, description: m.settings_envs_event_auto_update_success_desc },
				{ id: 'auto_update_failed', label: m.settings_envs_event_auto_update_failed, description: m.settings_envs_event_auto_update_failed_desc },
				{ id: 'auto_update_blocked', label: m.settings_envs_event_auto_update_blocked, description: m.settings_envs_event_auto_update_blocked_desc },
				{ id: 'updates_detected', label: m.settings_envs_event_updates_detected, description: m.settings_envs_event_updates_detected_desc },
				{ id: 'newer_version_available', label: m.settings_envs_event_newer_version_available, description: m.settings_envs_event_newer_version_available_desc },
				{ id: 'batch_update_success', label: m.settings_envs_event_batch_update_success, description: m.settings_envs_event_batch_update_success_desc }
			]
		},
		{
			id: 'git_stack',
			label: m.settings_envs_event_group_git_stack,
			icon: GitBranch,
			events: [
				{ id: 'git_sync_success', label: m.settings_envs_event_git_sync_success, description: m.settings_envs_event_git_sync_success_desc },
				{ id: 'git_sync_failed', label: m.settings_envs_event_git_sync_failed, description: m.settings_envs_event_git_sync_failed_desc },
				{ id: 'git_sync_skipped', label: m.settings_envs_event_git_sync_skipped, description: m.settings_envs_event_git_sync_skipped_desc }
			]
		},
		{
			id: 'stack',
			label: m.settings_envs_event_group_stack,
			icon: Layers,
			events: [
				{ id: 'stack_started', label: m.settings_envs_event_stack_started, description: m.settings_envs_event_stack_started_desc },
				{ id: 'stack_stopped', label: m.settings_envs_event_stack_stopped, description: m.settings_envs_event_stack_stopped_desc },
				{ id: 'stack_deployed', label: m.settings_envs_event_stack_deployed, description: m.settings_envs_event_stack_deployed_desc },
				{ id: 'stack_deploy_failed', label: m.settings_envs_event_stack_deploy_failed, description: m.settings_envs_event_stack_deploy_failed_desc }
			]
		},
		{
			id: 'security',
			label: m.settings_envs_event_group_security,
			icon: Shield,
			events: [
				{ id: 'vulnerability_critical', label: m.settings_envs_event_vulnerability_critical, description: m.settings_envs_event_vulnerability_critical_desc },
				{ id: 'vulnerability_high', label: m.settings_envs_event_vulnerability_high, description: m.settings_envs_event_vulnerability_high_desc },
				{ id: 'vulnerability_any', label: m.settings_envs_event_vulnerability_any, description: m.settings_envs_event_vulnerability_any_desc }
			]
		},
		{
			id: 'backup',
			label: m.settings_envs_event_group_backup,
			icon: Archive,
			events: [
				{ id: 'backup_success', label: m.settings_envs_event_backup_success, description: m.settings_envs_event_backup_success_desc },
				{ id: 'backup_failed', label: m.settings_envs_event_backup_failed, description: m.settings_envs_event_backup_failed_desc },
				{ id: 'restore_success', label: m.settings_envs_event_restore_success, description: m.settings_envs_event_restore_success_desc },
				{ id: 'restore_failed', label: m.settings_envs_event_restore_failed, description: m.settings_envs_event_restore_failed_desc }
			]
		},
		{
			id: 'system',
			label: m.settings_envs_event_group_system,
			icon: HardDrive,
			events: [
				{ id: 'image_pulled', label: m.settings_envs_event_image_pulled, description: m.settings_envs_event_image_pulled_desc },
				{ id: 'image_prune_success', label: m.settings_envs_event_image_prune_success, description: m.settings_envs_event_image_prune_success_desc },
				{ id: 'image_prune_failed', label: m.settings_envs_event_image_prune_failed, description: m.settings_envs_event_image_prune_failed_desc },
				{ id: 'environment_offline', label: m.settings_envs_event_environment_offline, description: m.settings_envs_event_environment_offline_desc },
				{ id: 'environment_online', label: m.settings_envs_event_environment_online, description: m.settings_envs_event_environment_online_desc },
				{ id: 'disk_space_warning', label: m.settings_envs_event_disk_space_warning, description: m.settings_envs_event_disk_space_warning_desc }
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
	<!-- BETA GATE: drop the Backup events group unless FEAT_BACKUPS_ENABLED (see features.ts) -->
	{#each NOTIFICATION_EVENT_GROUPS.filter((g) => g.id !== 'backup' || $page.data.backupsEnabled) as group (group.id)}
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
					<span class="text-sm font-medium">{group.label()}</span>
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
					{allSelected ? m.settings_envs_event_select_all() : someSelected ? m.settings_envs_event_select_some() : m.settings_envs_event_select_none()}
				</button>
			</div>

			<!-- Group Events -->
			{#if !isCollapsed}
				<div class="ml-4 mb-2 border-l-2 border-muted bg-muted/20 rounded-bl">
					{#each group.events as event (event.id)}
						{@const isSelected = selectedEventTypes.includes(event.id)}
						<div class="flex items-center justify-between pl-3 pr-1 py-1.5 hover:bg-muted/40 transition-colors border-b border-border/30 last:border-b-0">
							<div class="flex-1 min-w-0 pr-2">
								<div class="text-xs font-medium">{event.label()}</div>
								<div class="text-2xs text-muted-foreground truncate">{event.description()}</div>
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
