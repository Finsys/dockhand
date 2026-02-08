// Shared types that can be used in both client and server code

/**
 * System container type - containers that cannot be updated from within Dockhand.
 */
export type SystemContainerType = 'dockhand' | 'hawser';

export interface ContainerInfo {
	id: string;
	name: string;
	image: string;
	state: string;
	status: string;
	health?: string;
	created: number;
	ports: Array<{
		IP?: string;
		PrivatePort: number;
		PublicPort?: number;
		Type: string;
	}>;
	labels: Record<string, string>;
	mounts: Array<{
		type: string;
		source: string;
		destination: string;
		mode: string;
		rw: boolean;
	}>;
	networkMode: string;
	networks: string[];
	/**
	 * Identifies system containers (Dockhand, Hawser) that cannot be updated from within Dockhand.
	 * - 'dockhand': The Dockhand container itself
	 * - 'hawser': A Hawser remote agent container
	 * - null/undefined: Regular container
	 */
	systemContainer?: SystemContainerType | null;
}

export interface ImageInfo {
	id: string;
	repoTags: string[];
	tags: string[]; // Alias for repoTags, populated by API
	repoDigests: string[]; // Repository digests (e.g., "nginx@sha256:abc123") - used for untagged images
	created: number;
	size: number;
	virtualSize: number;
	labels: Record<string, string>;
	containers: number; // Number of containers using this image
}

export interface VolumeUsage {
	containerId: string;
	containerName: string;
}

export interface VolumeInfo {
	name: string;
	driver: string;
	mountpoint: string;
	scope: string;
	labels: Record<string, string>;
	createdAt?: string;
	created: string; // Alias for createdAt, populated by API
	usedBy?: VolumeUsage[]; // Containers using this volume
}

export interface NetworkInfo {
	id: string;
	name: string;
	driver: string;
	scope: string;
	internal?: boolean;
	ipam: {
		driver: string;
		config: Array<{
			subnet?: string;
			gateway?: string;
		}>;
	};
	containers: Record<string, {
		name: string;
		ipv4Address: string;
	}>;
	labels: Record<string, string>;
}

export interface StackInfo {
	name: string;
	services: string[];
	status: 'running' | 'partial' | 'stopped';
	containers: Array<{
		id: string;
		name: string;
		service: string;
		state: string;
		status: string;
	}>;
	path?: string;
}

export interface ContainerStats {
	id: string;
	name: string;
	cpuPercent: number;
	memoryUsage: number;      // Actual usage (total - cache), same as docker stats
	memoryRaw: number;        // Raw total usage before cache subtraction
	memoryCache: number;      // File cache (inactive_file)
	memoryLimit: number;
	memoryPercent: number;
	networkRx: number;
	networkTx: number;
	blockRead: number;
	blockWrite: number;
}

export interface StackContainer {
	id: string;
	name: string;
	service: string;
	state: string;
	status: string;
	health?: string;
	image: string;
	ports: Array<{ publicPort: number; privatePort: number; type: string; display: string }>;
	networks: Array<{ name: string; ipAddress: string }>;
	volumeCount: number;
	restartCount: number;
	created: number;
}

export interface ComposeStackInfo {
	name: string;
	containers: string[];
	containerDetails: StackContainer[];
	status: string;
	sourceType?: 'external' | 'internal' | 'git';
	repository?: {
		id: number;
		name: string;
		url?: string;
		branch?: string;
	};
}

export interface GitRepository {
	id: number;
	name: string;
	url: string;
	branch: string;
	composePath: string;
	credentialId: number | null;
	environmentId: number | null;
	autoUpdate: boolean;
	webhookEnabled: boolean;
	webhookSecret: string | null;
	lastSync: string | null;
	lastCommit: string | null;
	syncStatus: 'pending' | 'syncing' | 'synced' | 'error';
	syncError: string | null;
	createdAt: string;
	updatedAt: string;
}

// Grid column configuration types
export type GridId = 'containers' | 'images' | 'imageTags' | 'networks' | 'stacks' | 'volumes' | 'activity' | 'schedules' | 'audit';

export interface ColumnConfig {
	id: string;
	label: string;
	width?: number;
	minWidth?: number;
	resizable?: boolean;
	sortable?: boolean;
	sortField?: string;
	fixed?: 'start' | 'end';
	align?: 'left' | 'center' | 'right';
	grow?: boolean; // If true, column expands to fill remaining space
	noTruncate?: boolean; // If true, content won't be truncated with ellipsis
}

export interface ColumnPreference {
	id: string;
	visible: boolean;
	width?: number;
}

export interface GridColumnPreferences {
	columns: ColumnPreference[];
}

export type AllGridPreferences = Partial<Record<GridId, GridColumnPreferences>>;
