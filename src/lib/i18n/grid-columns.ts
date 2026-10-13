/**
 * Grid column headers in the UI language.
 *
 * The column definitions in $lib/config/grid-columns.ts stay English because unit
 * tests pin their labels, and their ids keep driving sorting, resizing and the saved
 * column preferences. These helpers only change the text that is shown. A column
 * missing here keeps its English label, so a new column shows up untranslated
 * rather than with a wrong text.
 */
import { m } from '$lib/paraglide/messages.js';
import type { ColumnConfig, GridId } from '$lib/types';

type Text = () => string;

// Header label per grid and column id. Columns without a label (select, expand,
// actions, the status dot of the environment list) are not listed and stay empty.
const LABELS: Record<GridId, Record<string, Text>> = {
	containers: {
		name: () => m.gridcol_name(),
		image: () => m.gridcol_image(),
		state: () => m.gridcol_state(),
		health: () => m.gridcol_health(),
		uptime: () => m.gridcol_uptime(),
		restartCount: () => m.gridcol_restarts(),
		cpu: () => m.gridcol_cpu(),
		memory: () => m.gridcol_memory(),
		networkIO: () => m.gridcol_net_io(),
		diskIO: () => m.gridcol_disk_io(),
		ip: () => m.gridcol_ip(),
		ports: () => m.gridcol_ports(),
		autoUpdate: () => m.gridcol_auto_update(),
		stack: () => m.gridcol_stack()
	},
	images: {
		image: () => m.gridcol_image(),
		tags: () => m.gridcol_tags(),
		size: () => m.gridcol_size(),
		updated: () => m.gridcol_updated()
	},
	imageTags: {
		tag: () => m.gridcol_tag(),
		id: () => m.gridcol_id(),
		size: () => m.gridcol_size(),
		created: () => m.gridcol_created(),
		used: () => m.gridcol_used_by()
	},
	networks: {
		name: () => m.gridcol_name(),
		driver: () => m.gridcol_driver(),
		scope: () => m.gridcol_scope(),
		subnet: () => m.gridcol_subnet(),
		gateway: () => m.gridcol_gateway(),
		containers: () => m.gridcol_containers()
	},
	stacks: {
		name: () => m.gridcol_name(),
		status: () => m.gridcol_status(),
		source: () => m.gridcol_source(),
		webhook: () => m.gridcol_webhook(),
		location: () => m.gridcol_location(),
		containers: () => m.gridcol_containers(),
		cpu: () => m.gridcol_cpu(),
		memory: () => m.gridcol_memory(),
		networkIO: () => m.gridcol_net_io(),
		diskIO: () => m.gridcol_disk_io(),
		networks: () => m.gridcol_networks(),
		volumes: () => m.gridcol_volumes()
	},
	volumes: {
		name: () => m.gridcol_name(),
		driver: () => m.gridcol_driver(),
		type: () => m.gridcol_type(),
		scope: () => m.gridcol_scope(),
		stack: () => m.gridcol_stack(),
		usedBy: () => m.gridcol_used_by(),
		created: () => m.gridcol_created()
	},
	activity: {
		timestamp: () => m.gridcol_timestamp(),
		environment: () => m.gridcol_environment(),
		action: () => m.gridcol_action(),
		container: () => m.gridcol_container(),
		image: () => m.gridcol_image(),
		exitCode: () => m.gridcol_exit()
	},
	audit: {
		timestamp: () => m.gridcol_timestamp(),
		environment: () => m.gridcol_environment(),
		user: () => m.gridcol_user(),
		action: () => m.gridcol_action(),
		entity: () => m.gridcol_entity(),
		name: () => m.gridcol_name(),
		ip: () => m.gridcol_ip_address()
	},
	schedules: {
		schedule: () => m.gridcol_schedule(),
		environment: () => m.gridcol_environment(),
		cron: () => m.gridcol_schedule(),
		lastRun: () => m.gridcol_last_run(),
		nextRun: () => m.gridcol_next_run(),
		status: () => m.gridcol_status()
	},
	environments: {
		name: () => m.gridcol_environment(),
		connection: () => m.gridcol_connection(),
		host: () => m.gridcol_host(),
		containers: () => m.gridcol_containers(),
		updates: () => m.gridcol_updates(),
		cpu: () => m.gridcol_cpu(),
		memory: () => m.gridcol_memory(),
		images: () => m.gridcol_images(),
		volumes: () => m.gridcol_volumes(),
		stacks: () => m.gridcol_stacks(),
		events: () => m.gridcol_events(),
		labels: () => m.gridcol_labels()
	},
	backups: {
		name: () => m.gridcol_name(),
		type: () => m.gridcol_type(),
		environment: () => m.gridcol_environment(),
		repository: () => m.gridcol_repository(),
		snapshots: () => m.gridcol_snapshots(),
		lastBackup: () => m.gridcol_last_backup(),
		retention: () => m.gridcol_retention(),
		schedule: () => m.gridcol_schedule(),
		status: () => m.gridcol_status()
	},
	repoSnapshots: {
		name: () => m.gridcol_name(),
		type: () => m.gridcol_type(),
		environment: () => m.gridcol_environment(),
		latest: () => m.gridcol_latest(),
		snapshots: () => m.gridcol_snapshots()
	},
	backupDestinations: {
		type: () => m.gridcol_type(),
		name: () => m.gridcol_name(),
		repository: () => m.gridcol_repository(),
		usage: () => m.gridcol_usage(),
		stats: () => m.gridcol_stats(),
		status: () => m.gridcol_status()
	},
	vulnerabilities: {
		cve: () => m.gridcol_cve(),
		package: () => m.gridcol_package(),
		severity: () => m.gridcol_severity(),
		installed: () => m.gridcol_installed_version(),
		fixed: () => m.gridcol_fixed_version(),
		image: () => m.gridcol_image(),
		container: () => m.gridcol_container(),
		stack: () => m.gridcol_stack(),
		scannedAt: () => m.gridcol_scanned()
	},
	deploys: {
		status: () => m.gridcol_status(),
		when: () => m.gridcol_when(),
		duration: () => m.gridcol_duration(),
		trigger: () => m.gridcol_trigger(),
		summary: () => m.gridcol_summary()
	}
};

// Header tooltip per grid and column id, for the columns that have one
const HINTS: Partial<Record<GridId, Record<string, Text>>> = {
	stacks: {
		webhook: () => m.gridcol_hint_stack_webhook()
	},
	backups: {
		type: () => m.gridcol_hint_backup_type(),
		repository: () => m.gridcol_hint_backup_repository(),
		status: () => m.gridcol_hint_last_backup_status()
	},
	repoSnapshots: {
		type: () => m.gridcol_hint_backup_type()
	}
};

/** Header label of a column in the UI language (English for a column not listed above). */
export function columnLabel(gridId: GridId, column: ColumnConfig): string {
	const text = column.label ? LABELS[gridId][column.id] : undefined;
	return text ? text() : column.label;
}

/** Header tooltip of a column in the UI language, undefined if the column has none. */
export function columnHint(gridId: GridId, column: ColumnConfig): string | undefined {
	const text = column.hint ? HINTS[gridId]?.[column.id] : undefined;
	return text ? text() : column.hint;
}

/** Copy of a column with label and hint in the UI language; id and everything else unchanged. */
export function localizeColumn(gridId: GridId, column: ColumnConfig): ColumnConfig {
	return { ...column, label: columnLabel(gridId, column), hint: columnHint(gridId, column) };
}
