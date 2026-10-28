<script lang="ts">
	import { DEFAULT_GRYPE_IMAGE, DEFAULT_TRIVY_IMAGE, imageRepo } from '$lib/utils/scanner-images';
	import { toast } from 'svelte-sonner';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import { validateEnvName } from '$lib/utils/env-name';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import VulnerabilityCriteriaSelector, { type VulnerabilityCriteria } from '$lib/components/VulnerabilityCriteriaSelector.svelte';
	import {
		Plus,
		Trash2,
		Pencil,
		Globe,
		RefreshCw,
		CircleArrowUp,
		CircleFadingArrowUp,
		Check,
		ShieldCheck,
		Activity,
		Bell,
		FileText,
		Download,
		Play,
		Square,
		RotateCcw,
		Skull,
		Heart,
		AlertTriangle,
		Layers,
		Loader2,
		Info,
		CheckCircle2,
		Lock,
		LockOpen,
		Mail,
		Send,
		AlertCircle,
		GitBranch,
		ShieldX,
		ShieldAlert,
		Shield,
		Wifi,
		WifiOff,
		Unplug,
		Key,
		Image,
		Cpu,
		Route,
		UndoDot,
		HelpCircle,
		ExternalLink,
		Copy,
		Clock,
		Icon,
		Pipette,
		X,
		Tags,
		ChevronDown,
		ChevronRight,
		XCircle,
		ImageUp,
		Archive,
		Upload,
		ArrowRight
	} from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as Alert from '$lib/components/ui/alert';
	import IconPicker from '$lib/components/icon-picker.svelte';
	import AvatarCropper from '$lib/components/AvatarCropper.svelte';
	import { isCustomIcon } from '$lib/utils/icons';
	import EnvironmentIcon from '$lib/components/EnvironmentIcon.svelte';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import TimezoneSelector from '$lib/components/TimezoneSelector.svelte';
	import { whale } from '@lucide/lab';
	import ImagePullProgressPopover from '../../images/ImagePullProgressPopover.svelte';
	import EnvironmentBackupsTab from './EnvironmentBackupsTab.svelte';
	import { page } from '$app/stores'; // BETA GATE: backups feature flag
	import { TogglePill, ToggleGroup } from '$lib/components/ui/toggle-pill';
	import { ShieldOff } from 'lucide-svelte';
	import { focusFirstInput } from '$lib/utils';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { authStore, canAccess } from '$lib/stores/auth';
	import { licenseStore } from '$lib/stores/license';
	import { formatDateTime, formatDate } from '$lib/stores/settings';
	import { getLabelColor, getLabelBgColor, parseLabels, MAX_LABELS } from '$lib/utils/label-colors';
	import { MEMORY_SUPPORT_DOC_URL } from '$lib/utils/memory-support';
	import { labelColorOverrides } from '$lib/stores/label-colors';
	import EventTypesEditor from './EventTypesEditor.svelte';
	import UpdatesTab from './tabs/UpdatesTab.svelte';
	import ActivityTab from './tabs/ActivityTab.svelte';
	import ReportsTab from './tabs/ReportsTab.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { splitAtName } from '$lib/i18n/split';

	// Scanner options for ToggleGroup
	const scannerOptions = [
		{ value: 'grype', label: 'Grype' },
		{ value: 'trivy', label: 'Trivy' },
		{ value: 'both', label: m.envmodal_scanner_both(), icon: ShieldCheck }
	];

	// Types
	type ConnectionType = 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';

	interface Environment {
		id: number;
		name: string;
		host?: string;
		port: number;
		protocol: string;
		tlsCa?: string;
		tlsCert?: string;
		// tlsKey / hawserToken are never returned by the API (write-only secrets); the
		// has* flags say whether one is stored.
		hasTlsKey?: boolean;
		hasHawserToken?: boolean;
		tlsSkipVerify?: boolean;
		icon?: string;
		socketPath?: string;
		collectActivity: boolean;
		collectMetrics: boolean;
		highlightChanges: boolean;
		connectionType?: ConnectionType;
		hawserLastSeen?: string;
		hawserAgentId?: string;
		hawserAgentName?: string;
		hawserVersion?: string;
		hawserCapabilities?: string;
		labels?: string;
		publicIp?: string;
		createdAt: string;
		updatedAt: string;
	}

	interface HawserToken {
		id: number;
		tokenPrefix: string;
		name: string;
		environmentId: number;
		isActive: boolean;
		lastUsed?: string;
		createdAt: string;
		expiresAt?: string;
	}

	interface EnvNotification {
		id: number;
		environmentId: number;
		notificationId: number;
		enabled: boolean;
		eventTypes: string[];
		channelName?: string;
		channelType?: 'smtp' | 'apprise';
		channelEnabled?: boolean;
	}

	interface NotificationSetting {
		id: number;
		type: 'smtp' | 'apprise';
		name: string;
		enabled: boolean;
		config: any;
		eventTypes: string[];
		createdAt: string;
		updatedAt: string;
	}

	type ScannerType = 'none' | 'grype' | 'trivy' | 'both';

	// Notification event types - grouped by category
	const NOTIFICATION_EVENT_GROUPS = [
		{
			id: 'container',
			label: 'Container events',
			events: [
				{ id: 'container_started', label: 'Container started', description: 'When a container starts running' },
				{ id: 'container_stopped', label: 'Container stopped', description: 'When a container is stopped' },
				{ id: 'container_restarted', label: 'Container restarted', description: 'When a container restarts' },
				{ id: 'container_exited', label: 'Container exited', description: 'When a container exits unexpectedly' },
				{ id: 'container_unhealthy', label: 'Container unhealthy', description: 'When a container health check fails' },
				{ id: 'container_oom', label: 'Container OOM killed', description: 'When a container is killed due to out of memory' },
				{ id: 'container_updated', label: 'Container updated', description: 'When a container image is updated' },
				{ id: 'container_scheduled_start', label: 'Scheduled start', description: 'When a container is started by its schedule' },
				{ id: 'container_scheduled_stop', label: 'Scheduled stop', description: 'When a container is stopped by its schedule' },
				{ id: 'container_scheduled_failed', label: 'Scheduled action failed', description: 'When a scheduled start or stop of a container fails' }
			]
		},
		{
			id: 'auto_update',
			label: 'Auto-update events',
			events: [
				{ id: 'auto_update_success', label: 'Update succeeded', description: 'Container successfully updated to new image' },
				{ id: 'auto_update_failed', label: 'Update failed', description: 'Container auto-update failed' },
				{ id: 'auto_update_blocked', label: 'Update blocked by vulns', description: 'Update blocked due to vulnerability criteria' },
				{ id: 'updates_detected', label: 'Updates detected', description: 'Container image updates are available (scheduled check)' },
				{ id: 'newer_version_available', label: 'Newer version tag', description: 'A newer version tag is published for a pinned image (semver, advisory)' },
				{ id: 'batch_update_success', label: 'Batch update completed', description: 'Scheduled container updates completed successfully' }
			]
		},
		{
			id: 'git_stack',
			label: 'Git stack events',
			events: [
				{ id: 'git_sync_success', label: 'Git sync succeeded', description: 'Git stack synced and deployed successfully' },
				{ id: 'git_sync_failed', label: 'Git sync failed', description: 'Git stack sync or deploy failed' },
				{ id: 'git_sync_skipped', label: 'Git sync skipped', description: 'Git stack sync skipped (no changes)' }
			]
		},
		{
			id: 'stack',
			label: 'Stack events',
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
			events: [
				{ id: 'vulnerability_critical', label: 'Critical vulns found', description: 'Critical vulnerabilities found in image scan' },
				{ id: 'vulnerability_high', label: 'High vulns found', description: 'High severity vulnerabilities found' },
				{ id: 'vulnerability_any', label: 'Any vulns found', description: 'Any vulnerabilities found (medium/low)' }
			]
		},
		{
			id: 'backup',
			label: 'Backup events',
			events: [
				{ id: 'backup_success', label: 'Backup succeeded', description: 'Backup completed successfully' },
				{ id: 'backup_failed', label: 'Backup failed', description: 'Backup failed' },
				{ id: 'restore_success', label: 'Restore succeeded', description: 'Restore completed successfully' },
				{ id: 'restore_failed', label: 'Restore failed', description: 'Restore failed' }
			]
		},
		{
			id: 'system',
			label: 'System events',
			events: [
				{ id: 'image_pulled', label: 'Image pulled', description: 'When a new image is pulled' },
				{ id: 'environment_offline', label: 'Environment offline', description: 'Environment became unreachable' },
				{ id: 'environment_online', label: 'Environment online', description: 'Environment came back online' },
				{ id: 'disk_space_warning', label: 'Disk space warning', description: 'Docker disk usage exceeds threshold' }
				// Note: license_expiring is a global event configured at the notification channel level
			]
		}
	];

	// Flat list of all event types (for backwards compatibility)
	const NOTIFICATION_EVENT_TYPES = NOTIFICATION_EVENT_GROUPS.flatMap(g => g.events);

	// Props
	interface Props {
		open: boolean;
		environment?: Environment | null;
		notifications: NotificationSetting[];
		existingLabels?: string[];
		onClose: () => void;
		onSaved: () => void;
		onScannerStatusChange?: (envId: number, enabled: boolean) => void;
	}

	let { open = $bindable(), environment = null, notifications, existingLabels = [], onClose, onSaved, onScannerStatusChange }: Props = $props();

	// Derived
	const isEditing = $derived(environment !== null);

	// Filtered label suggestions (not already selected, matching input)
	const filteredLabelSuggestions = $derived.by(() => {
		const input = newLabelInput.trim().toLowerCase();
		return existingLabels
			.filter(label => !formLabels.includes(label))
			.filter(label => !input || label.toLowerCase().includes(input));
	});

	// Modal tab state
	let modalTab = $state<string>('general');

	// Form state
	let formName = $state('');
	let formHost = $state('');
	let formPort = $state(2375); // Default for direct Docker connection
	let formProtocol = $state('http');
	// direct-only: where Dockhand stages compose + relative-bind files on the remote host,
	// so `./config`/`./data` binds resolve. Empty = current behavior (relative binds unsupported).
	let formRemoteStacksDir = $state('');
	let formTlsCa = $state('');
	let formTlsCert = $state('');
	let formTlsKey = $state('');
	// Whether the environment already has a stored tlsKey (the value itself is never
	// returned by the API). Drives the "leave blank to keep" hint on the field.
	let hasStoredTlsKey = $state(false);
	let formTlsSkipVerify = $state(false);
	let formIcon = $state('globe');
	let pendingIconData = $state<string | null>(null);
	let iconCropperImageUrl = $state('');
	let showIconCropper = $state(false);
	let iconFileInput: HTMLInputElement;
	let iconCacheBust = $state(Date.now());
	let formSocketPath = $state('/var/run/docker.sock');
	let formCollectActivity = $state(true);
	let formCollectMetrics = $state(true);
	let formHighlightChanges = $state(true);
	let formDiskWarningEnabled = $state(true);
	let formDiskWarningMode = $state<'percentage' | 'absolute'>('percentage');
	/** Whether this host reports a total for percentage warnings; null = not asked yet. */
	let formPercentageSupported = $state<boolean | null>(null);
	let formStorageDriver = $state<string | null>(null);
	/** The mode the server has, kept apart from the form so edits cannot lock it out. */
	let storedDiskWarningMode = $state<'percentage' | 'absolute' | null>(null);
	let formDiskWarningThreshold = $state(80);
	let formDiskWarningThresholdGb = $state(50);
	let formConnectionType = $state<ConnectionType>('socket');
	// Envs that keep stack files on a REMOTE host, so backup needs a declared stack path.
	// For hawser it is backup-only (the agent owns its STACKS_DIR). For direct it also drives
	// deploy: Dockhand copies the folder there and rewrites relative binds to that host path.
	const usesStackPath = (ct: ConnectionType) => ct === 'direct' || ct === 'hawser-standard' || ct === 'hawser-edge';
	const isHawserConn = (ct: ConnectionType) => ct === 'hawser-standard' || ct === 'hawser-edge';
	let formHawserToken = $state('');
	// Whether a hawser token is already stored (value never returned by the API).
	let hasStoredHawserToken = $state(false);
	let formLabels = $state<string[]>([]);
	let newLabelInput = $state('');
	let showLabelDropdown = $state(false);
	let formPublicIp = $state('');
	let formTimezone = $state('UTC');
	let formError = $state('');
	// Env-rename confirmation dialog state.
	let showRenameConfirm = $state(false);
	let renameConfirmFrom = $state('');
	let renameConfirmTo = $state('');
	let renameStackCount = $state(0);
	let renameGitStackCount = $state(0);
	// Set when we couldn't reliably enumerate stacks (network/permission
	// failure). The dialog falls back to generic text instead of a count, so
	// we never silent-rename on a transient error.
	let renameCountsUnknown = $state(false);
	// Whether running containers will be affected by the rename. True for
	// socket/direct (they deploy from the staging dir). False for Hawser
	// (the agent's deployed dir doesn't include env name).
	let renameAffectsContainers = $state(false);
	let formErrors = $state<{ name?: string; host?: string }>({});
	let formSaving = $state(false);

	/**
	 * Clean a PEM certificate - remove leading/trailing whitespace from each line
	 * This handles copy/paste from formatted output with line numbers
	 */
	function handleIconFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			iconCropperImageUrl = reader.result as string;
			showIconCropper = true;
		};
		reader.readAsDataURL(file);
		input.value = '';
	}

	async function handleIconCropSave(dataUrl: string) {
		showIconCropper = false;
		if (environment) {
			// Edit mode: upload immediately
			const res = await fetch(`/api/environments/${environment.id}/icon`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: dataUrl })
			});
			if (res.ok) {
				const result = await res.json();
				formIcon = result.icon;
				iconCacheBust = Date.now();
				pendingIconData = null;
			} else {
				toast.error(m.envmodal_toast_icon_upload_failed());
			}
		} else {
			// Create mode: store for later upload after environment is created
			pendingIconData = dataUrl;
			formIcon = 'custom:pending';
		}
	}

	async function uploadPendingIcon(envId: number) {
		if (!pendingIconData) return;
		await fetch(`/api/environments/${envId}/icon`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image: pendingIconData })
		});
		pendingIconData = null;
	}

	async function removeCustomIcon() {
		if (environment) {
			const res = await fetch(`/api/environments/${environment.id}/icon`, { method: 'DELETE' });
			if (res.ok) {
				formIcon = 'globe';
				iconCacheBust = Date.now();
			}
		} else {
			pendingIconData = null;
			formIcon = 'globe';
		}
	}

	function cleanCertificate(cert: string | undefined): string | undefined {
		if (!cert) return undefined;
		const cleaned = cert
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.join('\n');
		return cleaned || undefined;
	}

	/**
	 * Read a PEM file picked via <input type="file"> into the bound textarea state.
	 * Pasting still works; this is purely additive (#125).
	 */
	async function loadPemFromFile(
		event: Event,
		assign: (text: string) => void,
		label: string
	) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			if (!text.includes('-----BEGIN')) {
				toast.error(m.envmodal_toast_pem_invalid({ file: file.name }));
				return;
			}
			assign(text);
			toast.success(m.envmodal_toast_pem_loaded({ label, file: file.name }));
		} catch (err: any) {
			toast.error(m.envmodal_toast_pem_read_failed({ file: file.name, error: err?.message ?? err }));
		} finally {
			input.value = ''; // allow re-uploading the same file
		}
	}

	/**
	 * Extract hostname/IP from a URL string
	 * Handles tcp://, http://, https:// protocols and plain hostnames
	 */
	function extractHostFromUrl(url: string): string | null {
		if (!url) return null;
		// Handle tcp://, http://, https:// protocols
		const match = url.match(/^(?:\w+:\/\/)?([^:\/]+)/);
		return match ? match[1] : null;
	}

	/**
	 * Strip protocol and port from a host/IP string
	 */
	function stripHostProtocol(value: string): string {
		// Strip protocol prefix (e.g., tcp://, https://)
		const stripped = value.replace(/^(?:\w+:\/\/)/, '');

		// Handle bracketed IPv6 with optional port: [::1]:port → ::1
		if (stripped.startsWith('[')) {
			return stripped.replace(/^\[([^\]]+)\].*$/, '$1');
		}

		// Handle plain IPv6 (2+ colons = IPv6, not IPv4:port or hostname:port)
		if ((stripped.match(/:/g) || []).length > 1) {
			return stripped;
		}

		// IPv4 or hostname: strip :port and path
		return stripped.replace(/[:/].*$/, '');
	}

	/**
	 * Auto-copy host to publicIp when user enters host value
	 * @param force - If true, always update publicIp (used on blur)
	 */
	function handleHostInput(force = false) {
		if ((force || !formPublicIp) && formHost) {
			const extracted = extractHostFromUrl(formHost.trim());
			if (extracted && extracted !== 'localhost' && extracted !== '127.0.0.1') {
				formPublicIp = extracted;
			}
		}
	}

	// Hawser state (simplified - one token per environment)
	let hawserToken = $state<HawserToken | null>(null);
	let hawserTokenLoading = $state(false);
	let generatingToken = $state(false);
	let generatedToken = $state<string | null>(null); // Full token shown once after generation
	let copySuccess = $state<'ok' | 'error' | null>(null);
	let copyCmdSuccess = $state<'ok' | 'error' | null>(null);
	// For add mode - auto-generated token stored until save
	let pendingToken = $state<string | null>(null);

	// Test connection state
	let testingConnection = $state(false);
	let testResult = $state<{ success: boolean; info?: any; error?: string; isEdgeMode?: boolean } | null>(null);
	// Shown when a successful Test connection reveals the daemon's kernel has cgroup
	// memory accounting disabled (per-container memory shows 0 - common on Raspberry Pi).
	let memWarnOpen = $state(false);

	// Socket detection state
	let detectingSockets = $state(false);
	let detectedSockets = $state<{ path: string; name: string }[]>([]);
	let showSocketDropdown = $state(false);

	// Add mode specific form state
	let formEnableScanner = $state(false);
	let formScannerType = $state<ScannerType>('both');
	let formSelectedNotifications = $state<{ id: number; eventTypes: string[] }[]>([]);

	// Scanner settings state (for edit mode)
	let scannerEnabled = $state(false);
	let selectedScanner = $state<ScannerType>('both');
	let scannerAvailability = $state<{ grype: boolean; trivy: boolean }>({ grype: false, trivy: false });
	let scannerVersions = $state<{ grype: string | null; trivy: string | null }>({ grype: null, trivy: null });
	// A newer upstream RELEASE, when the Check found one. Distinct from a rebuild of
	// the pinned tag: moving to it changes the configured image, so it is offered,
	// never applied on its own.
	let grypeNewerVersion = $state<string | null>(null);
	let trivyNewerVersion = $state<string | null>(null);
	let scannerLoading = $state(true);
	let scannerGrypeImage = $state(DEFAULT_GRYPE_IMAGE);
	let scannerTrivyImage = $state(DEFAULT_TRIVY_IMAGE);
	let loadingScannerVersions = $state(false);
	let removingGrype = $state(false);
	let removingTrivy = $state(false);
	let checkingGrypeUpdate = $state(false);
	let checkingTrivyUpdate = $state(false);
	let grypeUpdateStatus = $state<'idle' | 'up-to-date' | 'update-available'>('idle');
	let trivyUpdateStatus = $state<'idle' | 'up-to-date' | 'update-available'>('idle');
	let pullingGrype = $state(false);
	let pullingTrivy = $state(false);

	// Environment notifications state (for edit mode)
	let envNotifications = $state<EnvNotification[]>([]);
	let envNotifLoading = $state(false);
	let collapsedChannels = $state<Set<number>>(new Set());

	function toggleChannelCollapse(channelId: number) {
		if (collapsedChannels.has(channelId)) {
			collapsedChannels = new Set([...collapsedChannels].filter(id => id !== channelId));
		} else {
			collapsedChannels = new Set([...collapsedChannels, channelId]);
		}
	}

	// Update check settings state
	// Only an administrator configures the scheduled report: the mail leaves the
	// installation unattended, carrying the full inventory and its vulnerabilities.
	const isAdmin = $derived($authStore.user?.isAdmin === true || $authStore.authEnabled === false);

	// Scheduled state report (admin only; the mail leaves the installation unattended)
	let reportLoading = $state(false);
	let reportEnabled = $state(false);
	let reportCron = $state('0 6 1 * *'); // Default: 06:00 on the 1st
	let reportFormat = $state<'pdf' | 'csv'>('pdf');
	let reportNotificationId = $state<number | null>(null);
	let smtpChannels = $state<Array<{ id: number; name: string }>>([]);

	let updateCheckEnabled = $state(false);
	let updateCheckCron = $state('0 4 * * *'); // Default: 4 AM daily
	let updateCheckAutoUpdate = $state(false);
	let minimumReleaseAgeHours = $state(0);
	let minimumReleaseAgeOverridden = $state(false);
	let minimumReleaseAgeOverride = $state(false);
	let updateCheckVulnerabilityCriteria = $state<VulnerabilityCriteria>('never');
	let updateCheckLoading = $state(false);

	// Image prune settings state
	let imagePruneEnabled = $state(false);
	let imagePruneCron = $state('0 3 * * 0'); // Default: 3 AM Sunday
	let imagePruneMode = $state<'dangling' | 'all'>('dangling');
	let imagePruneLastPruned = $state<string | undefined>(undefined);
	let imagePruneLastResult = $state<{ spaceReclaimed?: number; imagesRemoved: number } | undefined>(undefined);
	let imagePruneLoading = $state(false);

	// === Validation Functions ===
	function isValidHost(host: string): boolean {
		if (!host) return false;

		// IPv4 pattern
		const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
		if (ipv4Pattern.test(host)) {
			// Validate each octet is 0-255
			const octets = host.split('.');
			return octets.every(o => {
				const num = parseInt(o, 10);
				return num >= 0 && num <= 255;
			});
		}

		// IPv6 pattern (simplified - allows :: shorthand)
		const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
		if (ipv6Pattern.test(host) || host === '::1') {
			return true;
		}

		// Hostname pattern (allows letters, numbers, hyphens, dots)
		// Must start with letter/number, can contain dots for subdomains
		const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?)*$/;
		return hostnamePattern.test(host);
	}

	// === Form Functions ===
	function resetForm() {
		if (environment) {
			formName = environment.name;
			formHost = environment.host || '';
			formPort = environment.port;
			formProtocol = environment.protocol;
			formTlsCa = environment.tlsCa || '';
			formTlsCert = environment.tlsCert || '';
			// The API never returns the tlsKey / hawserToken secrets (they're stripped
			// server-side). Start blank and remember whether one is stored so the field
			// can say "leave blank to keep"; a blank submit keeps the existing secret.
			formTlsKey = '';
			hasStoredTlsKey = !!environment.hasTlsKey;
			formTlsSkipVerify = environment.tlsSkipVerify ?? false;
			formIcon = environment.icon || 'globe';
			formSocketPath = environment.socketPath || '/var/run/docker.sock';
			formCollectActivity = environment.collectActivity ?? true;
			formCollectMetrics = environment.collectMetrics ?? true;
			formHighlightChanges = environment.highlightChanges ?? true;
			formConnectionType = (environment.connectionType as ConnectionType) || 'socket';
			formHawserToken = '';
			hasStoredHawserToken = !!environment.hasHawserToken;
			formLabels = parseLabels(environment.labels);
			newLabelInput = '';
			formPublicIp = environment.publicIp || '';
			// Unknown until this environment's own host answers: the previous one's
			// verdict must not be shown against a different host.
			formPercentageSupported = null;
			formStorageDriver = null;
			storedDiskWarningMode = null;
			modalTab = 'general';
			// Reset icon state
			pendingIconData = null;
			iconCacheBust = Date.now();
			// Reset token state for this environment (important when switching between envs)
			hawserToken = null;
			generatedToken = null;
			generatedStandardToken = null;
			pendingToken = null;
			// Load scanner settings, notifications, update check settings, image prune settings, and timezone
			loadScannerSettings(environment.id);
			loadEnvNotifications(environment.id);
			loadUpdateCheckSettings(environment.id);
			if (isAdmin) loadReportSettings(environment.id);
			loadImagePruneSettings(environment.id);
			loadTimezone(environment.id);
			loadDiskWarningSettings(environment.id);
			if (usesStackPath(formConnectionType)) loadRemoteStacksDir(environment.id);
			// Load Hawser token if edge mode
			if (formConnectionType === 'hawser-edge') {
				loadHawserToken(environment.id);
			}
		} else {
			formName = '';
			formHost = '';
			formPort = 2375;
			formProtocol = 'http';
			formRemoteStacksDir = '';
			formTlsCa = '';
			formTlsCert = '';
			formTlsKey = '';
			hasStoredTlsKey = false;
			formTlsSkipVerify = false;
			formIcon = 'globe';
			pendingIconData = null;
			formSocketPath = '/var/run/docker.sock';
			formCollectActivity = true;
			formCollectMetrics = true;
			formHighlightChanges = true;
			formDiskWarningEnabled = true;
			formDiskWarningMode = 'percentage';
			formPercentageSupported = null;
			formStorageDriver = null;
			storedDiskWarningMode = null;
			formDiskWarningThreshold = 80;
			formDiskWarningThresholdGb = 50;
			formConnectionType = 'socket';
			formHawserToken = '';
			hasStoredHawserToken = false;
			formLabels = [];
			newLabelInput = '';
			formPublicIp = '';
			formEnableScanner = false;
			formScannerType = 'both';
			formSelectedNotifications = [];
			modalTab = 'general';
			scannerEnabled = false;
			envNotifications = [];
			envNotifLoading = false;
			hawserToken = null;
			generatedToken = null;
			generatedStandardToken = null;
			pendingToken = null;
			// Reset update check settings
			updateCheckEnabled = false;
			updateCheckCron = '0 4 * * *';
			updateCheckAutoUpdate = false;
			minimumReleaseAgeHours = 0;
			minimumReleaseAgeOverridden = false;
			minimumReleaseAgeOverride = false;
			// Reset image prune settings
			imagePruneEnabled = false;
			imagePruneCron = '0 3 * * 0';
			imagePruneMode = 'dangling';
			imagePruneLastPruned = undefined;
			imagePruneLastResult = undefined;
			// Reset the scheduled report; the tab is live while adding, so it needs its
			// channels even though there is no environment id yet.
			resetReportSettings();
			if (isAdmin) loadSmtpChannels();
			// Load default timezone from global settings
			loadDefaultTimezone();
		}
		formError = '';
		formErrors = {};
		formSaving = false;
		testingConnection = false;
		testResult = null;
		detectingSockets = false;
		detectedSockets = [];
		showSocketDropdown = false;
	}

	// Track which environment was initialized to avoid repeated resets
	let lastInitializedEnvId = $state<number | null | undefined>(undefined);

	$effect(() => { labelColorOverrides.load(); });

	// Reset form when modal opens OR when environment prop changes (for edit mode)
	$effect(() => {
		if (open) {
			const currentEnvId = environment?.id ?? null;
			if (lastInitializedEnvId !== currentEnvId) {
				lastInitializedEnvId = currentEnvId;
				resetForm();
			}
		} else {
			lastInitializedEnvId = undefined;
		}
	});

	// === Client-side token generation for add mode ===
	function generatePendingToken() {
		// Generate a secure token client-side (32 bytes = 256 bits, base64url encoded)
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		// Convert to base64url (same format the server uses)
		const base64 = btoa(String.fromCharCode(...array));
		pendingToken = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	}

	let generatedStandardToken = $state<string | null>(null);

	function generateStandardToken() {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		const base64 = btoa(String.fromCharCode(...array));
		formHawserToken = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
		generatedStandardToken = formHawserToken;
	}

	// === Test Connection ===
	async function testConnection() {
		testingConnection = true;
		testResult = null;

		try {
			const response = await fetch('/api/environments/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					connectionType: formConnectionType,
					socketPath: formSocketPath,
					host: formHost,
					port: formPort,
					protocol: formProtocol,
					tlsCa: cleanCertificate(formTlsCa),
					tlsCert: cleanCertificate(formTlsCert),
					tlsKey: cleanCertificate(formTlsKey),
					tlsSkipVerify: formTlsSkipVerify,
					hawserToken: formHawserToken || pendingToken,
					// When editing, let the server fall back to the stored token/key for any
					// secret the form left blank (secrets are never sent back to the client) (#1483).
					environmentId: isEditing && environment ? environment.id : undefined
				})
			});

			const result = await response.json();
			testResult = result;

			if (result.success) {
				if (result.isEdgeMode) {
					toast.info(m.envmodal_toast_edge_test_deferred());
				} else {
					toast.success(m.envmodal_toast_connected({ version: result.info.serverVersion, containers: result.info.containers }));
					// Docker reports the kernel's cgroup memory controller is off -> container
					// memory will show 0. Surface it now so the user isn't left guessing.
					if (result.info.showMemoryWarning) memWarnOpen = true;
				}
			} else {
				toast.error(result.error || m.environments_test_connection_failed());
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : m.envmodal_connection_test_failed();
			testResult = { success: false, error: message };
			toast.error(message);
		} finally {
			testingConnection = false;
		}
	}

	// === Socket Detection ===
	async function detectDockerSockets() {
		detectingSockets = true;
		try {
			const response = await fetch('/api/environments/detect-socket');
			const result = await response.json();
			detectedSockets = result.sockets || [];

			if (detectedSockets.length === 0) {
				toast.error(m.envmodal_toast_no_sockets_found());
			} else if (detectedSockets.length === 1) {
				// Auto-select if only one found
				formSocketPath = detectedSockets[0].path;
				toast.success(m.envmodal_toast_socket_found({ name: detectedSockets[0].name }));
			} else {
				// Show dropdown to select
				showSocketDropdown = true;
				toast.success(m.envmodal_toast_sockets_found({ count: detectedSockets.length }));
			}
		} catch (error) {
			toast.error(m.envmodal_toast_detect_sockets_failed());
		} finally {
			detectingSockets = false;
		}
	}

	function selectSocket(path: string) {
		formSocketPath = path;
		showSocketDropdown = false;
	}

	// === Environment CRUD ===
	async function createEnvironment() {
		if (minimumReleaseAgeOverride && (!Number.isInteger(minimumReleaseAgeHours) || minimumReleaseAgeHours < 0 || minimumReleaseAgeHours > 720)) {
			formError = m.envmodal_error_min_release_age();
			return;
		}
		// Validation based on connection type
		formErrors = {};
		let hasErrors = false;

		if (!formName.trim()) {
			formErrors.name = m.containers_files_name_required();
			hasErrors = true;
		} else {
			const nameCheck = validateEnvName(formName.trim());
			if (!nameCheck.ok) {
				formErrors.name = nameCheck.reason!;
				hasErrors = true;
			}
		}
		// Host is only required for direct and hawser-standard connection types
		if (formConnectionType === 'direct' || formConnectionType === 'hawser-standard') {
			if (!formHost.trim()) {
				formErrors.host = m.envmodal_error_host_required();
				hasErrors = true;
			} else {
				formHost = stripHostProtocol(formHost.trim());
				if (!isValidHost(formHost)) {
					formErrors.host = m.envmodal_error_host_invalid();
					hasErrors = true;
				}
			}
		}

		if (hasErrors) return;

		formSaving = true;
		formError = '';

		try {
			const response = await fetch('/api/environments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: formName.trim(),
					host: formConnectionType === 'hawser-edge' ? 'edge-agent' : (formConnectionType === 'socket' ? undefined : formHost.trim()),
					port: formConnectionType === 'socket' ? undefined : formPort,
					protocol: formConnectionType === 'socket' ? undefined : formProtocol,
					tlsCa: cleanCertificate(formTlsCa),
					tlsCert: cleanCertificate(formTlsCert),
					tlsKey: cleanCertificate(formTlsKey),
					tlsSkipVerify: formTlsSkipVerify,
					icon: pendingIconData ? 'globe' : formIcon,
					socketPath: formConnectionType === 'socket' ? formSocketPath : undefined,
					collectActivity: formCollectActivity,
					collectMetrics: formCollectMetrics,
					highlightChanges: formHighlightChanges,
					labels: formLabels,
					connectionType: formConnectionType,
					hawserToken: formHawserToken || undefined,
					publicIp: stripHostProtocol(formPublicIp.trim()) || undefined
				})
			});

			if (response.ok) {
				const newEnv = await response.json();
				// Upload pending custom icon if set
				if (pendingIconData && newEnv?.id) {
					await uploadPendingIcon(newEnv.id);
				}
				// If scanner was enabled, save scanner settings for the new environment
				if (formEnableScanner && newEnv?.id) {
					scannerEnabled = true;
					selectedScanner = formScannerType;
					await saveScannerSettings(newEnv.id);
				}
				// If notification channels were selected, save them for the new environment
				if (formSelectedNotifications.length > 0 && newEnv?.id) {
					for (const notif of formSelectedNotifications) {
						await fetch(`/api/environments/${newEnv.id}/notifications`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								notificationId: notif.id,
								enabled: true,
								eventTypes: notif.eventTypes
							})
						});
					}
				}
				// If edge mode with pending token, save the token
				if (formConnectionType === 'hawser-edge' && pendingToken && newEnv?.id) {
					await fetch('/api/hawser/tokens', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							name: formName.trim() || 'default',
							environmentId: newEnv.id,
							rawToken: pendingToken // Send the pre-generated token
						})
					});
				}
				// Save update check settings and the optional release-age override
				if (newEnv?.id) {
					await saveUpdateCheckSettings(newEnv.id);
				}
				// The Reports tab is live while adding, so its schedule has to be saved here
				// too. The environment itself is created either way, so a rejected schedule
				// is reported rather than aborting; saveReportSettings has already shown the
				// reason, and this says what it cost.
				if (newEnv?.id && isAdmin) {
					const reportSaved = await saveReportSettings(newEnv.id);
					if (!reportSaved) {
						toast.warning(
							m.envmodal_toast_report_not_saved({ name: formName })
						);
					}
				}
				// Save image prune settings if enabled
				if (imagePruneEnabled && newEnv?.id) {
					await saveImagePruneSettings(newEnv.id);
				}
				// Save timezone if not default
				if (newEnv?.id) {
					await saveTimezone(newEnv.id);
					await saveDiskWarningSettings(newEnv.id);
					if (usesStackPath(formConnectionType)) await saveRemoteStacksDir(newEnv.id);
				}
				onSaved();
				onClose();
			} else {
				const data = await response.json();
				formError = data.error || m.environments_error_create_failed();
			}
		} catch (error) {
			formError = error instanceof Error ? error.message : m.environments_error_create_failed();
		} finally {
			formSaving = false;
		}
	}

	async function updateEnvironment() {
		if (!environment) return;
		if (minimumReleaseAgeOverride && (!Number.isInteger(minimumReleaseAgeHours) || minimumReleaseAgeHours < 0 || minimumReleaseAgeHours > 720)) {
			formError = m.envmodal_error_min_release_age();
			return;
		}

		formErrors = {};
		let hasErrors = false;

		if (!formName.trim()) {
			formErrors.name = m.containers_files_name_required();
			hasErrors = true;
		} else if (formName.trim() !== environment.name) {
			// Only validate name format on rename — existing names with legacy characters are allowed
			const nameCheck = validateEnvName(formName.trim());
			if (!nameCheck.ok) {
				formErrors.name = nameCheck.reason!;
				hasErrors = true;
			}
		}
		// Host is only required for direct and hawser-standard connection types
		if (formConnectionType === 'direct' || formConnectionType === 'hawser-standard') {
			if (!formHost.trim()) {
				formErrors.host = m.envmodal_error_host_required();
				hasErrors = true;
			} else {
				formHost = stripHostProtocol(formHost.trim());
				if (!isValidHost(formHost)) {
					formErrors.host = m.envmodal_error_host_invalid();
					hasErrors = true;
				}
			}
		}

		if (hasErrors) return;

		// Every env type stores something locally under the env name:
		// - socket/direct: the deploy staging dir AND the in-app editor source
		//   (containers' compose project labels point here, so redeploy is
		//   required after rename or next restart fails)
		// - hawser-standard/edge: the in-app editor source for ALL stacks
		//   PLUS the git-repos clones for git stacks (the agent's deployed
		//   dir lives on the remote host and is not affected)
		// → fire the warning whenever the name changes.
		const newName = formName.trim();
		const willRenameOnDisk = newName !== environment.name;
		// "Affects containers" = redeploy required. Only true for envs where
		// Dockhand deploys directly (socket/direct), not Hawser.
		renameAffectsContainers =
			environment.connectionType === 'socket' || environment.connectionType === 'direct';
		if (willRenameOnDisk) {
			// Count actual stacks on this env. Fail closed: if either request
			// fails (network, 403, parse error) we treat the counts as
			// unknown and still show the warning — better to spook the user
			// than silent-rename when stacks might exist.
			const [stacksRes, gitRes] = await Promise.all([
				fetch(`/api/stacks?env=${environment.id}`).catch(() => null),
				fetch(`/api/git/stacks?env=${environment.id}`).catch(() => null)
			]);

			let unknown = false;
			let stacks: unknown[] = [];
			let gitStacks: unknown[] = [];
			if (stacksRes?.ok) {
				try { stacks = await stacksRes.json(); } catch { unknown = true; }
			} else {
				unknown = true;
			}
			if (gitRes?.ok) {
				try { gitStacks = await gitRes.json(); } catch { unknown = true; }
			} else {
				unknown = true;
			}
			renameStackCount = Array.isArray(stacks) ? stacks.length : 0;
			renameGitStackCount = Array.isArray(gitStacks) ? gitStacks.length : 0;
			renameCountsUnknown = unknown;

			renameConfirmFrom = environment.name;
			renameConfirmTo = newName;
			showRenameConfirm = true;
			return;
		}

		await commitEnvironmentUpdate();
	}

	// Extracted from updateEnvironment() so the rename-confirm dialog can call
	// it after the user clicks "Rename and continue".
	async function commitEnvironmentUpdate() {
		if (!environment) return;

		formSaving = true;
		formError = '';

		try {
			const response = await fetch(`/api/environments/${environment.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: formName.trim(),
					host: formConnectionType === 'hawser-edge' ? 'edge-agent' : (formConnectionType === 'socket' ? undefined : formHost.trim()),
					port: formConnectionType === 'socket' ? undefined : formPort,
					protocol: formConnectionType === 'socket' ? undefined : formProtocol,
					tlsCa: cleanCertificate(formTlsCa),
					tlsCert: cleanCertificate(formTlsCert),
					tlsKey: cleanCertificate(formTlsKey),
					tlsSkipVerify: formTlsSkipVerify,
					icon: formIcon,
					socketPath: formConnectionType === 'socket' ? formSocketPath : undefined,
					collectActivity: formCollectActivity,
					collectMetrics: formCollectMetrics,
					highlightChanges: formHighlightChanges,
					labels: formLabels,
					connectionType: formConnectionType,
					hawserToken: formHawserToken || undefined,
					publicIp: stripHostProtocol(formPublicIp.trim()) || null
				})
			});

			if (response.ok) {
				await saveScannerSettings(environment.id);
				await saveUpdateCheckSettings(environment.id);
				const reportSaved = isAdmin ? await saveReportSettings(environment.id) : true;
				await saveImagePruneSettings(environment.id);
				await saveTimezone(environment.id);
				await saveDiskWarningSettings(environment.id);
				if (usesStackPath(formConnectionType)) await saveRemoteStacksDir(environment.id);
				// The environment itself saved; only claim so when the report schedule did too,
				// otherwise the rejection toast is contradicted by a success beside it.
				if (reportSaved) toast.success(m.envmodal_toast_updated({ name: formName }));
				onSaved();
				onClose();
			} else {
				const data = await response.json();
				formError = data.error || m.environments_error_update_failed();
			}
		} catch (error) {
			formError = error instanceof Error ? error.message : m.environments_error_update_failed();
		} finally {
			formSaving = false;
		}
	}

	// === Disk Warning Functions ===
	async function loadDiskWarningSettings(envId: number) {
		try {
			const response = await fetch(`/api/environments/${envId}/disk-warning`);
			if (response.ok) {
				const data = await response.json();
				formDiskWarningEnabled = data.enabled ?? true;
				formDiskWarningMode = data.mode ?? 'percentage';
				storedDiskWarningMode = formDiskWarningMode;
				formDiskWarningThreshold = data.threshold ?? 80;
				formDiskWarningThresholdGb = data.thresholdGb ?? 50;
				formPercentageSupported = data.percentageSupported ?? null;
				formStorageDriver = data.storageDriver ?? null;
			}
		} catch (error) {
			console.error('Failed to load disk warning settings:', error);
		}
	}

	async function loadRemoteStacksDir(envId: number) {
		try {
			const response = await fetch(`/api/environments/${envId}/remote-stacks-dir`);
			if (response.ok) {
				const data = await response.json();
				formRemoteStacksDir = data.remoteStacksDir ?? '';
			}
		} catch (error) {
			console.error('Failed to load remote stacks dir:', error);
		}
	}

	async function saveRemoteStacksDir(envId: number) {
		try {
			await fetch(`/api/environments/${envId}/remote-stacks-dir`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ remoteStacksDir: formRemoteStacksDir.trim() || null })
			});
		} catch (error) {
			console.error('Failed to save remote stacks dir:', error);
		}
	}

	async function saveDiskWarningSettings(envId: number) {
		try {
			await fetch(`/api/environments/${envId}/disk-warning`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					enabled: formDiskWarningEnabled,
					mode: formDiskWarningMode,
					threshold: formDiskWarningThreshold,
					thresholdGb: formDiskWarningThresholdGb
				})
			});
		} catch (error) {
			console.error('Failed to save disk warning settings:', error);
		}
	}

	// === Timezone Functions ===
	async function loadTimezone(envId: number) {
		try {
			const response = await fetch(`/api/environments/${envId}/timezone`);
			if (response.ok) {
				const data = await response.json();
				formTimezone = data.timezone || 'UTC';
			}
		} catch (error) {
			console.error('Failed to load timezone:', error);
			formTimezone = 'UTC';
		}
	}

	async function loadDefaultTimezone() {
		try {
			const response = await fetch('/api/settings/general');
			if (response.ok) {
				const data = await response.json();
				formTimezone = data.defaultTimezone || 'UTC';
			}
		} catch (error) {
			console.error('Failed to load default timezone:', error);
			formTimezone = 'UTC';
		}
	}

	async function saveTimezone(envId: number) {
		try {
			const response = await fetch(`/api/environments/${envId}/timezone`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ timezone: formTimezone })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				console.error('Failed to save timezone:', data.error || response.status);
			}
		} catch (error) {
			console.error('Failed to save timezone:', error);
		}
	}

	// === Scanner Settings Functions ===
	async function loadScannerSettings(envId?: number) {
		scannerLoading = true;
		scannerVersions = { grype: null, trivy: null };
		try {
			const envParam = envId !== undefined ? `&env=${envId}` : '';
			const settingsResponse = await fetch(`/api/settings/scanner?settingsOnly=true${envParam}`);
			const settingsData = await settingsResponse.json();
			if (settingsData.settings) {
				const savedScanner = settingsData.settings.scanner || 'none';
				scannerEnabled = savedScanner !== 'none';
				selectedScanner = savedScanner === 'none' ? 'both' : savedScanner;
				if (settingsData.settings.grypeImage) scannerGrypeImage = settingsData.settings.grypeImage;
				if (settingsData.settings.trivyImage) scannerTrivyImage = settingsData.settings.trivyImage;
			}
			scannerLoading = false;
			loadScannerVersionsAsync(envId);
		} catch (error) {
			console.error('Failed to load scanner settings:', error);
			scannerLoading = false;
		}
	}

	async function loadScannerVersionsAsync(envId?: number) {
		loadingScannerVersions = true;
		try {
			const envParam = envId !== undefined ? `env=${envId}` : '';
			const fullResponse = await fetch(`/api/settings/scanner?${envParam}`);
			const fullData = await fullResponse.json();
			if (fullData.availability) {
				scannerAvailability = fullData.availability;
			}
			if (fullData.versions) {
				scannerVersions = fullData.versions;
			}
		} catch (error) {
			console.error('Failed to load scanner versions:', error);
		} finally {
			loadingScannerVersions = false;
		}
	}

	// Reload only availability/versions without overwriting user's unsaved settings changes
	async function reloadScannerAvailability(envId?: number) {
		await loadScannerVersionsAsync(envId);
	}

	async function saveScannerSettings(envId?: number) {
		try {
			const response = await fetch('/api/settings/scanner', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					scanner: scannerEnabled ? selectedScanner : 'none',
					envId
				})
			});
			const data = await response.json();
			if (data.success && envId !== undefined) {
				onScannerStatusChange?.(envId, scannerEnabled);
			}
		} catch (error) {
			console.error('Failed to save scanner settings:', error);
		}
	}

	// === Scheduled report (admin only) ===
	/** The channels the report can be sent to. Needed while adding too, where there is no envId yet. */
	async function loadSmtpChannels() {
		smtpChannels = [];
		try {
			const response = await fetch('/api/notifications');
			if (!response.ok) return;
			const all = await response.json();
			const rows = Array.isArray(all) ? all : (all.settings ?? all.notifications ?? []);
			// Only SMTP: no other channel type can carry the attachment.
			smtpChannels = rows
				.filter((c: { type?: string; enabled?: boolean }) => c.type === 'smtp' && c.enabled !== false)
				.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }));
		} catch (error) {
			console.error('Failed to load notification channels:', error);
		}
	}

	/** The schedule's defaults, also what a failed load falls back to. */
	function resetReportSettings() {
		reportEnabled = false;
		reportCron = '0 6 1 * *';
		reportFormat = 'pdf';
		reportNotificationId = null;
	}

	async function loadReportSettings(envId: number) {
		reportLoading = true;
		// Reset first: the modal is reused across environments, so a failed load must not
		// leave the previous environment's schedule on screen, where saving would apply it
		// to this one.
		resetReportSettings();
		try {
			const [settingsRes] = await Promise.all([
				fetch(`/api/environments/${envId}/report`),
				loadSmtpChannels()
			]);
			if (settingsRes.ok) {
				const data = await settingsRes.json();
				reportEnabled = data.settings?.enabled ?? false;
				reportCron = data.settings?.cron || '0 6 1 * *';
				reportFormat = data.settings?.format === 'csv' ? 'csv' : 'pdf';
				reportNotificationId = data.settings?.notificationId ?? null;
				// A channel that has since been disabled, deleted or switched away from SMTP
				// is no longer offered, and the server refuses a save that still names it.
				// Clear it so the form shows the choice that has to be made.
				if (
					reportNotificationId !== null &&
					!smtpChannels.some((c) => c.id === reportNotificationId)
				) {
					reportNotificationId = null;
				}
			}
		} catch (error) {
			console.error('Failed to load report settings:', error);
		} finally {
			reportLoading = false;
		}
	}

	/** Returns false when the schedule was rejected, so the caller does not claim success. */
	async function saveReportSettings(envId: number): Promise<boolean> {
		try {
			const response = await fetch(`/api/environments/${envId}/report`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					enabled: reportEnabled,
					cron: reportCron,
					format: reportFormat,
					notificationId: reportNotificationId
				})
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				toast.error(body?.error || m.envmodal_toast_report_save_failed());
				return false;
			}
			return true;
		} catch (error) {
			console.error('Failed to save report settings:', error);
			toast.error(m.envmodal_toast_report_save_failed());
			return false;
		}
	}

	// === Update Check Settings Functions ===
	async function loadUpdateCheckSettings(envId: number) {
		updateCheckLoading = true;
		try {
			const response = await fetch(`/api/environments/${envId}/update-check`);
			if (response.ok) {
				const data = await response.json();
				if (data.settings) {
					updateCheckEnabled = data.settings.enabled ?? false;
					updateCheckCron = data.settings.cron || '0 4 * * *';
					updateCheckAutoUpdate = data.settings.autoUpdate ?? false;
					updateCheckVulnerabilityCriteria = data.settings.vulnerabilityCriteria || 'never';
					minimumReleaseAgeHours = data.settings.minimumReleaseAgeHours ?? 0;
					minimumReleaseAgeOverridden = data.settings.minimumReleaseAgeOverridden ?? false;
					minimumReleaseAgeOverride = data.settings.minimumReleaseAgeOverride ?? false;
				} else {
					// No settings found - use defaults
					updateCheckEnabled = false;
					updateCheckCron = '0 4 * * *';
					updateCheckAutoUpdate = false;
					updateCheckVulnerabilityCriteria = 'never';
					minimumReleaseAgeHours = 0;
					minimumReleaseAgeOverridden = false;
					minimumReleaseAgeOverride = false;
				}
			}
		} catch (error) {
			console.error('Failed to load update check settings:', error);
		} finally {
			updateCheckLoading = false;
		}
	}

	async function saveUpdateCheckSettings(envId: number) {
		const response = await fetch(`/api/environments/${envId}/update-check`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				enabled: updateCheckEnabled,
				cron: updateCheckCron,
				autoUpdate: updateCheckAutoUpdate,
				vulnerabilityCriteria: updateCheckVulnerabilityCriteria,
				minimumReleaseAgeHours,
				minimumReleaseAgeOverride
			})
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || m.envmodal_error_update_check_save_failed());
		}
	}

	// === Image Prune Settings Functions ===
	async function loadImagePruneSettings(envId: number) {
		imagePruneLoading = true;
		try {
			const response = await fetch(`/api/environments/${envId}/image-prune`);
			if (response.ok) {
				const data = await response.json();
				if (data.settings) {
					imagePruneEnabled = data.settings.enabled ?? false;
					imagePruneCron = data.settings.cronExpression || '0 3 * * 0';
					imagePruneMode = data.settings.pruneMode || 'dangling';
					imagePruneLastPruned = data.settings.lastPruned;
					imagePruneLastResult = data.settings.lastResult;
				} else {
					// No settings found - use defaults
					imagePruneEnabled = false;
					imagePruneCron = '0 3 * * 0';
					imagePruneMode = 'dangling';
					imagePruneLastPruned = undefined;
					imagePruneLastResult = undefined;
				}
			}
		} catch (error) {
			console.error('Failed to load image prune settings:', error);
		} finally {
			imagePruneLoading = false;
		}
	}

	async function saveImagePruneSettings(envId: number) {
		try {
			await fetch(`/api/environments/${envId}/image-prune`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					enabled: imagePruneEnabled,
					cronExpression: imagePruneCron,
					pruneMode: imagePruneMode
				})
			});
		} catch (error) {
			console.error('Failed to save image prune settings:', error);
		}
	}

	async function removeGrype(envId?: number) {
		removingGrype = true;
		try {
			const envParam = envId !== undefined ? `&env=${envId}` : '';
			const response = await fetch(`/api/settings/scanner?removeImages=true&scanner=grype${envParam}`, {
				method: 'DELETE'
			});
			const data = await response.json();
			if (data.success) {
				scannerAvailability = { ...scannerAvailability, grype: false };
				scannerVersions = { ...scannerVersions, grype: null };
			}
		} catch (error) {
			console.error('Failed to remove Grype:', error);
		} finally {
			removingGrype = false;
		}
	}

	async function removeTrivy(envId?: number) {
		removingTrivy = true;
		try {
			const envParam = envId !== undefined ? `&env=${envId}` : '';
			const response = await fetch(`/api/settings/scanner?removeImages=true&scanner=trivy${envParam}`, {
				method: 'DELETE'
			});
			const data = await response.json();
			if (data.success) {
				scannerAvailability = { ...scannerAvailability, trivy: false };
				scannerVersions = { ...scannerVersions, trivy: null };
			}
		} catch (error) {
			console.error('Failed to remove Trivy:', error);
		} finally {
			removingTrivy = false;
		}
	}

	async function checkGrypeUpdate() {
		checkingGrypeUpdate = true;
		grypeUpdateStatus = 'idle';
		try {
			const envParam = environment?.id ? `&env=${environment.id}` : '';
			// Ask for BOTH: a rebuild of the pinned tag, and a newer release. A pinned
			// tag is permanently "up to date" on its own digest, so the release check
			// is the one that answers "is there a newer scanner".
			const response = await fetch(`/api/settings/scanner?checkUpdates=true&checkNewerVersions=true${envParam}`);
			const data = await response.json();
			grypeNewerVersion = data.newerVersions?.grype?.latest ?? null;
			if (data.updates) {
				const rebuilt = data.updates.grype?.hasUpdate === true;
				grypeUpdateStatus = rebuilt || grypeNewerVersion ? 'update-available' : 'up-to-date';
				if (!grypeNewerVersion) setTimeout(() => { grypeUpdateStatus = 'idle'; }, 3000);
			}
		} catch (error) {
			console.error('Failed to check Grype update:', error);
		} finally {
			checkingGrypeUpdate = false;
		}
	}

	async function checkTrivyUpdate() {
		checkingTrivyUpdate = true;
		trivyUpdateStatus = 'idle';
		try {
			const envParam = environment?.id ? `&env=${environment.id}` : '';
			// Ask for BOTH: a rebuild of the pinned tag, and a newer release. A pinned
			// tag is permanently "up to date" on its own digest, so the release check
			// is the one that answers "is there a newer scanner".
			const response = await fetch(`/api/settings/scanner?checkUpdates=true&checkNewerVersions=true${envParam}`);
			const data = await response.json();
			trivyNewerVersion = data.newerVersions?.trivy?.latest ?? null;
			if (data.updates) {
				const rebuilt = data.updates.trivy?.hasUpdate === true;
				trivyUpdateStatus = rebuilt || trivyNewerVersion ? 'update-available' : 'up-to-date';
				if (!trivyNewerVersion) setTimeout(() => { trivyUpdateStatus = 'idle'; }, 3000);
			}
		} catch (error) {
			console.error('Failed to check Trivy update:', error);
		} finally {
			checkingTrivyUpdate = false;
		}
	}

	async function pullGrypeImage() {
		if (pullingGrype) return;
		pullingGrype = true;
		grypeUpdateStatus = 'idle';
		try {
			// A newer release means a different TAG, so the configured image has to move
			// first - pulling the old tag again would just re-fetch the same version.
			let image = scannerGrypeImage;
			if (grypeNewerVersion) {
				image = `${imageRepo(image)}:${grypeNewerVersion}`;
				const saved = await fetch('/api/settings/scanner', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ grypeImage: image })
				});
				if (!saved.ok) {
					const err = await saved.json().catch(() => ({}));
					throw new Error(err.error || m.envmodal_error_scanner_image_change_failed());
				}
				scannerGrypeImage = image;
			}
			const pullUrl = environment?.id ? `/api/images/pull?env=${environment.id}` : '/api/images/pull';
			const response = await fetch(pullUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image })
			});

			if (!response.ok) {
				throw new Error(m.envmodal_error_scanner_pull_failed({ scanner: 'Grype' }));
			}

			const result = await readJobResponse(response);
			if (result.success === false) {
				throw new Error(result.error as string || m.envmodal_error_pull_failed());
			}

			// Refresh scanner status after pull
			await loadScannerVersionsAsync(environment?.id);
			grypeNewerVersion = null;
			grypeUpdateStatus = 'up-to-date';
			setTimeout(() => { grypeUpdateStatus = 'idle'; }, 3000);
		} catch (error) {
			// Surface it: a refused image change (admin only) or a failed pull leaves
			// the button looking like it did nothing at all.
			console.error('Failed to pull Grype image:', error);
			toast.error(error instanceof Error ? error.message : m.envmodal_toast_scanner_update_failed({ scanner: 'Grype' }));
		} finally {
			pullingGrype = false;
		}
	}

	async function pullTrivyImage() {
		if (pullingTrivy) return;
		pullingTrivy = true;
		trivyUpdateStatus = 'idle';
		try {
			// A newer release means a different TAG, so the configured image has to move
			// first - pulling the old tag again would just re-fetch the same version.
			let image = scannerTrivyImage;
			if (trivyNewerVersion) {
				image = `${imageRepo(image)}:${trivyNewerVersion}`;
				const saved = await fetch('/api/settings/scanner', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ trivyImage: image })
				});
				if (!saved.ok) {
					const err = await saved.json().catch(() => ({}));
					throw new Error(err.error || m.envmodal_error_scanner_image_change_failed());
				}
				scannerTrivyImage = image;
			}
			const pullUrl = environment?.id ? `/api/images/pull?env=${environment.id}` : '/api/images/pull';
			const response = await fetch(pullUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image })
			});

			if (!response.ok) {
				throw new Error(m.envmodal_error_scanner_pull_failed({ scanner: 'Trivy' }));
			}

			const result = await readJobResponse(response);
			if (result.success === false) {
				throw new Error(result.error as string || m.envmodal_error_pull_failed());
			}

			// Refresh scanner status after pull
			await loadScannerVersionsAsync(environment?.id);
			trivyNewerVersion = null;
			trivyUpdateStatus = 'up-to-date';
			setTimeout(() => { trivyUpdateStatus = 'idle'; }, 3000);
		} catch (error) {
			// Surface it: a refused image change (admin only) or a failed pull leaves
			// the button looking like it did nothing at all.
			console.error('Failed to pull Trivy image:', error);
			toast.error(error instanceof Error ? error.message : m.envmodal_toast_scanner_update_failed({ scanner: 'Trivy' }));
		} finally {
			pullingTrivy = false;
		}
	}

	// === Notification Functions ===
	async function loadEnvNotifications(envId: number) {
		envNotifLoading = true;
		try {
			const response = await fetch(`/api/environments/${envId}/notifications`);
			if (response.ok) {
				envNotifications = await response.json();
			}
		} catch (error) {
			console.error('Failed to load environment notifications:', error);
		} finally {
			envNotifLoading = false;
		}
	}

	async function addEnvNotification(envId: number, notificationId: number) {
		try {
			if (environment && !environment.collectActivity) {
				await fetch(`/api/environments/${envId}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ collectActivity: true })
				});
				environment.collectActivity = true;
				formCollectActivity = true;
			}

			const response = await fetch(`/api/environments/${envId}/notifications`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ notificationId })
			});
			if (response.ok) {
				await loadEnvNotifications(envId);
				toast.success(m.envmodal_toast_channel_added());
			} else {
				const data = await response.json();
				toast.error(data.error || m.envmodal_toast_channel_add_failed());
			}
		} catch (error) {
			console.error('Failed to add environment notification:', error);
			toast.error(m.envmodal_toast_channel_add_failed());
		}
	}

	async function updateEnvNotification(envId: number, notificationId: number, data: { enabled?: boolean; eventTypes?: string[] }) {
		const idx = envNotifications.findIndex(n => n.notificationId === notificationId);
		if (idx !== -1) {
			if (data.enabled !== undefined) envNotifications[idx].enabled = data.enabled;
			if (data.eventTypes !== undefined) envNotifications[idx].eventTypes = data.eventTypes;
		}

		try {
			await fetch(`/api/environments/${envId}/notifications/${notificationId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(data)
			});
		} catch (error) {
			console.error('Failed to update environment notification:', error);
			await loadEnvNotifications(envId);
		}
	}

	async function deleteEnvNotification(envId: number, notificationId: number) {
		try {
			const response = await fetch(`/api/environments/${envId}/notifications/${notificationId}`, {
				method: 'DELETE'
			});
			if (response.ok) {
				await loadEnvNotifications(envId);
			}
		} catch (error) {
			console.error('Failed to delete environment notification:', error);
		}
	}

	// === Hawser Token Functions (simplified - one token per environment) ===
	async function loadHawserToken(envId: number) {
		hawserTokenLoading = true;
		try {
			const response = await fetch('/api/hawser/tokens');
			if (response.ok) {
				const allTokens = await response.json();
				const tokens = allTokens.filter((t: HawserToken) => t.environmentId === envId);
				hawserToken = tokens.length > 0 ? tokens[0] : null;
			}
		} catch (error) {
			console.error('Failed to load Hawser token:', error);
		} finally {
			hawserTokenLoading = false;
		}
	}

	async function generateHawserToken(envId: number) {
		generatingToken = true;
		try {
			const response = await fetch('/api/hawser/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: formName.trim() || 'default',
					environmentId: envId
				})
			});
			if (response.ok) {
				const data = await response.json();
				generatedToken = data.token;
				await loadHawserToken(envId);
				toast.success(m.envmodal_toast_token_generated());
			} else {
				const data = await response.json();
				toast.error(data.error || m.envmodal_toast_token_generate_failed());
			}
		} catch (error) {
			console.error('Failed to generate Hawser token:', error);
			toast.error(m.envmodal_toast_token_generate_failed());
		} finally {
			generatingToken = false;
		}
	}

	async function regenerateHawserToken(envId: number) {
		// Delete existing token first, then generate new one
		if (hawserToken) {
			try {
				await fetch(`/api/hawser/tokens?id=${hawserToken.id}`, { method: 'DELETE' });
			} catch (error) {
				console.error('Failed to revoke old token:', error);
			}
		}
		await generateHawserToken(envId);
	}

	async function copyToken(token: string) {
		const ok = await copyToClipboard(token);
		copySuccess = ok ? 'ok' : 'error';
		setTimeout(() => { copySuccess = null; }, 2000);
	}

	async function copyCommand(token: string) {
		const cmd = `DOCKHAND_SERVER_URL=${getConnectionUrl()} TOKEN=${token} hawser`;
		const ok = await copyToClipboard(cmd);
		copyCmdSuccess = ok ? 'ok' : 'error';
		setTimeout(() => { copyCmdSuccess = null; }, 2000);
	}

	function getConnectionUrl() {
		const protocol = typeof window !== 'undefined' ? window.location.protocol : 'https:';
		const host = typeof window !== 'undefined' ? window.location.host : 'your-dockhand-server';
		return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api/hawser/connect`;
	}

</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) focusFirstInput(); else onClose(); }}>
	<Dialog.Content class="max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
		<Dialog.Header class="flex-shrink-0 border-b pb-4">
			<Dialog.Title class="flex items-center gap-2">
				{#if !isEditing}
					{m.dashboard_add_environment()}
				{:else}
					{m.environments_edit_title()}
				{/if}
				{#if environment}
					<Badge variant="secondary" class="text-xs">{environment.name}</Badge>
				{/if}
			</Dialog.Title>
		</Dialog.Header>

		{#if formError}
			<div class="text-sm text-red-600 dark:text-red-400 px-1 pt-4">{formError}</div>
		{/if}

		<Tabs.Root bind:value={modalTab} class="flex-1 flex flex-col overflow-hidden mt-4">
			<Tabs.List class="flex-shrink-0 mb-0 w-full flex flex-wrap h-auto gap-1 p-1">
				<Tabs.Trigger value="general" class="flex-1 flex items-center justify-center gap-1.5">
					<Globe class="w-3.5 h-3.5" />
					{m.envmodal_tab_general()}
				</Tabs.Trigger>
				<Tabs.Trigger value="updates" class="flex-1 flex items-center justify-center gap-1.5">
					<CircleFadingArrowUp class="w-3.5 h-3.5" />
					{m.envmodal_tab_updates()}
				</Tabs.Trigger>
				<Tabs.Trigger value="activity" class="flex-1 flex items-center justify-center gap-1.5">
					<Activity class="w-3.5 h-3.5" />
					{m.nav_activity()}
				</Tabs.Trigger>
				<Tabs.Trigger value="security" class="flex-1 flex items-center justify-center gap-1.5">
					<ShieldCheck class="w-3.5 h-3.5" />
					{m.containers_settings_security()}
				</Tabs.Trigger>
				<!-- BETA GATE: Backups tab hidden unless FEAT_BACKUPS_ENABLED (see features.ts) -->
				{#if $page.data.backupsEnabled}
					<Tabs.Trigger value="backup" class="flex-1 flex items-center justify-center gap-1.5">
						<Archive class="w-3.5 h-3.5" />
						{m.nav_backups()}
					</Tabs.Trigger>
				{/if}
				<Tabs.Trigger value="notifications" class="flex-1 flex items-center justify-center gap-1.5">
					<Bell class="w-3.5 h-3.5" />
					{m.envmodal_tab_notifications()}
				</Tabs.Trigger>
				{#if isAdmin}
					<Tabs.Trigger value="reports" class="flex-1 flex items-center justify-center gap-1.5">
						<FileText class="w-3.5 h-3.5" />
						{m.envmodal_tab_reports()}
					</Tabs.Trigger>
				{/if}
			</Tabs.List>

			<div class="overflow-y-auto py-4 h-[520px] [scrollbar-gutter:stable] pr-5">
				<!-- General Tab (Connection Settings) -->
					<Tabs.Content value="general" class="space-y-4 mt-0 h-full">
						<!-- Name field -->
						<div class="space-y-2">
							<Label for="edit-env-name">{m.environments_name_label()}</Label>
							<div class="flex gap-2">
								{#if isCustomIcon(formIcon) || pendingIconData}
									<Button variant="outline" size="sm" class="h-9 w-9 p-0 relative group" type="button" onclick={() => iconFileInput?.click()}>
										{#if pendingIconData}
											<img src={pendingIconData} alt="" class="w-5 h-5 rounded object-cover" />
										{:else if environment}
											<EnvironmentIcon icon={formIcon} envId={environment.id} class="w-5 h-5" cacheBust={iconCacheBust} />
										{/if}
									</Button>
									<Button variant="ghost" size="sm" class="h-9 w-9 p-0" type="button" title={m.envmodal_remove_custom_icon()} onclick={removeCustomIcon}>
										<X class="w-3.5 h-3.5 text-muted-foreground" />
									</Button>
								{:else}
									<IconPicker value={formIcon} onchange={(icon) => formIcon = icon} />
									<Button variant="ghost" size="sm" class="h-9 w-9 p-0" type="button" title={m.envmodal_upload_custom_icon()} onclick={() => iconFileInput?.click()}>
										<ImageUp class="w-4 h-4 text-muted-foreground" />
									</Button>
								{/if}
								<Input
									id="edit-env-name"
									bind:value={formName}
									placeholder={m.envmodal_name_placeholder()}
									class="flex-1 {formErrors.name ? 'border-destructive focus-visible:ring-destructive' : ''}"
									oninput={() => formErrors.name = undefined}
								/>
							</div>
							{#if formErrors.name}
								<p class="text-xs text-destructive">{formErrors.name}</p>
							{/if}
						</div>
						<input
							type="file"
							accept="image/*"
							class="hidden"
							bind:this={iconFileInput}
							onchange={handleIconFileSelect}
						/>

						<!-- Labels section -->
						<div class="space-y-2">
							<div class="flex items-center gap-1.5">
								<Label>{m.containers_settings_labels()}</Label>
								<span class="text-xs text-muted-foreground">({formLabels.length}/{MAX_LABELS})</span>
							</div>
							{#if formLabels.length > 0}
								<div class="flex flex-wrap gap-1.5">
									{#each formLabels as label}
										<Badge
											variant="secondary"
											class="gap-1 pr-1 rounded-md"
											style="background-color: {getLabelBgColor(label, $labelColorOverrides)}; border-color: {getLabelColor(label, $labelColorOverrides)}; color: {getLabelColor(label, $labelColorOverrides)};"
										>
											{label}
											<button
												type="button"
												onclick={() => formLabels = formLabels.filter(l => l !== label)}
												class="ml-0.5 rounded-full hover:bg-black/10 p-0.5"
											>
												<X class="w-3 h-3" />
											</button>
										</Badge>
									{/each}
								</div>
							{/if}
							{#if formLabels.length < MAX_LABELS}
								<div class="flex gap-2">
									<div class="relative flex-1">
										<Input
											bind:value={newLabelInput}
											placeholder={m.envmodal_add_label_placeholder()}
											onfocus={() => showLabelDropdown = true}
											onblur={() => setTimeout(() => showLabelDropdown = false, 150)}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													const trimmed = newLabelInput.trim().toLowerCase();
													if (trimmed && !formLabels.includes(trimmed)) {
														formLabels = [...formLabels, trimmed];
														newLabelInput = '';
													}
												} else if (e.key === 'Escape') {
													showLabelDropdown = false;
												}
											}}
										/>
										{#if showLabelDropdown && filteredLabelSuggestions.length > 0}
											<div class="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-md max-h-48 overflow-y-auto">
												{#each filteredLabelSuggestions as suggestion}
													{@const colors = { color: getLabelColor(suggestion, $labelColorOverrides), bgColor: getLabelBgColor(suggestion, $labelColorOverrides) }}
													<button
														type="button"
														class="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2"
														onmousedown={(e) => {
															e.preventDefault();
															formLabels = [...formLabels, suggestion];
															newLabelInput = '';
														}}
													>
														<span
															class="px-1.5 py-0.5 text-2xs rounded-md font-medium"
															style="background-color: {colors.bgColor}; color: {colors.color}"
														>
															{suggestion}
														</span>
													</button>
												{/each}
											</div>
										{/if}
									</div>
									<Button
										variant="outline"
										size="sm"
										onclick={() => {
											const trimmed = newLabelInput.trim().toLowerCase();
											if (trimmed && !formLabels.includes(trimmed)) {
												formLabels = [...formLabels, trimmed];
												newLabelInput = '';
											}
										}}
										disabled={!newLabelInput.trim() || formLabels.includes(newLabelInput.trim().toLowerCase())}
									>
										<Plus class="w-4 h-4" />
									</Button>
								</div>
							{:else}
								<p class="text-xs text-muted-foreground">{m.envmodal_max_labels_reached()}</p>
							{/if}
						</div>

						<!-- Connection type selector -->
						<div class="space-y-2">
							<div class="flex items-center gap-1.5">
								<Label for="edit-env-connection-type">{m.envmodal_connection_type_label()}</Label>
								<Tooltip.Root>
									<Tooltip.Trigger type="button" class="text-muted-foreground hover:text-foreground">
										<HelpCircle class="w-3.5 h-3.5" />
									</Tooltip.Trigger>
									<Tooltip.Content class="w-80 text-sm z-[200]" side="right">
										<div class="space-y-3">
											<div class="flex items-start gap-2">
												<Unplug class="w-4 h-4 mt-0.5 text-cyan-500 shrink-0" />
												<div>
													<p class="font-medium">{m.envmodal_conn_socket()}</p>
													<p class="text-xs text-muted-foreground">{m.envmodal_conn_socket_help()}</p>
												</div>
											</div>
											<div class="flex items-start gap-2">
												<Icon iconNode={whale} class="w-4 h-4 mt-0.5 text-blue-500 shrink-0" />
												<div>
													<p class="font-medium">{m.envmodal_conn_direct()}</p>
													<p class="text-xs text-muted-foreground">{m.envmodal_conn_direct_help()}</p>
												</div>
											</div>
											<div class="flex items-start gap-2">
												<Route class="w-4 h-4 mt-0.5 text-purple-500 shrink-0" />
												<div>
													<p class="font-medium">{m.envmodal_conn_hawser_standard()}</p>
													<p class="text-xs text-muted-foreground">{m.envmodal_conn_hawser_standard_help()}</p>
												</div>
											</div>
											<div class="flex items-start gap-2">
												<UndoDot class="w-4 h-4 mt-0.5 text-green-500 shrink-0" />
												<div>
													<p class="font-medium">{m.envmodal_conn_hawser_edge()}</p>
													<p class="text-xs text-muted-foreground">{m.envmodal_conn_hawser_edge_help()}</p>
												</div>
											</div>
											<a href="https://github.com/Finsys/hawser" target="_blank" class="flex items-center gap-1 text-xs text-blue-500 hover:underline">
												<ExternalLink class="w-3 h-3" />
												{m.envmodal_learn_more_hawser()}
											</a>
										</div>
									</Tooltip.Content>
								</Tooltip.Root>
							</div>
							<Select.Root type="single" value={formConnectionType} onValueChange={(v) => {
								formConnectionType = v as ConnectionType;
								// Set default port based on connection type
								if (v === 'direct') {
									formPort = 2375;
								} else if (v === 'hawser-standard') {
									formPort = 2376;
								}
							}}>
								<Select.Trigger class="w-full">
									<span class="flex items-center gap-2">
										{#if formConnectionType === 'socket'}
											<Unplug class="w-4 h-4 text-cyan-500" />
											{m.envmodal_conn_socket()}
										{:else if formConnectionType === 'direct'}
											<Icon iconNode={whale} class="w-4 h-4 text-blue-500" />
											{m.envmodal_conn_direct()}
										{:else if formConnectionType === 'hawser-standard'}
											<Route class="w-4 h-4 text-purple-500" />
											{m.envmodal_conn_hawser_standard_agent()}
										{:else}
											<UndoDot class="w-4 h-4 text-green-500" />
											{m.envmodal_conn_hawser_edge_agent()}
										{/if}
									</span>
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="socket">
										<span class="flex items-center gap-2">
											<Unplug class="w-4 h-4 text-cyan-500" />
											{m.envmodal_conn_socket()}
										</span>
									</Select.Item>
									<Select.Item value="direct">
										<span class="flex items-center gap-2">
											<Icon iconNode={whale} class="w-4 h-4 text-blue-500" />
											{m.envmodal_conn_direct()}
										</span>
									</Select.Item>
									<Select.Item value="hawser-standard">
										<span class="flex items-center gap-2">
											<Route class="w-4 h-4 text-purple-500" />
											{m.envmodal_conn_hawser_standard_agent()}
										</span>
									</Select.Item>
									<Select.Item value="hawser-edge">
										<span class="flex items-center gap-2">
											<UndoDot class="w-4 h-4 text-green-500" />
											{m.envmodal_conn_hawser_edge_agent()}
										</span>
									</Select.Item>
								</Select.Content>
							</Select.Root>
							<!-- Short description with link -->
							<p class="text-xs text-muted-foreground">
								{#if formConnectionType === 'socket'}
									{m.envmodal_conn_socket_short()}
								{:else if formConnectionType === 'direct'}
									{m.envmodal_conn_direct_short()}
								{:else if formConnectionType === 'hawser-standard'}
									{splitAtName(m.envmodal_conn_hawser_standard_short)[0]}<a href="https://github.com/Finsys/hawser" target="_blank" class="text-blue-500 hover:underline">Hawser</a>{splitAtName(m.envmodal_conn_hawser_standard_short)[1]}
								{:else}
									{splitAtName(m.envmodal_conn_hawser_edge_short)[0]}<a href="https://github.com/Finsys/hawser" target="_blank" class="text-blue-500 hover:underline">Hawser</a>{splitAtName(m.envmodal_conn_hawser_edge_short)[1]}
								{/if}
							</p>
						</div>

						<!-- Socket connection settings -->
						{#if formConnectionType === 'socket'}
							<div class="space-y-2">
								<Label for="edit-env-socket-path">{m.envmodal_socket_path_label()}</Label>
								<div class="relative">
									<div class="flex gap-2">
										<Input
											id="edit-env-socket-path"
											bind:value={formSocketPath}
											placeholder="/var/run/docker.sock"
											class="flex-1"
										/>
										<Button
											variant="outline"
											size="icon"
											onclick={detectDockerSockets}
											disabled={detectingSockets}
											title={m.envmodal_socket_autodetect_title()}
										>
											{#if detectingSockets}
												<Loader2 class="w-4 h-4 animate-spin" />
											{:else}
												<Pipette class="w-4 h-4" />
											{/if}
										</Button>
									</div>
									{#if showSocketDropdown && detectedSockets.length > 1}
										<div class="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg z-50">
											<div class="py-1">
												{#each detectedSockets as socket}
													<button
														onclick={() => selectSocket(socket.path)}
														class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left cursor-pointer"
													>
														<Unplug class="w-4 h-4 text-muted-foreground shrink-0" />
														<div class="flex-1 min-w-0">
															<div class="font-medium truncate">{socket.name}</div>
															<div class="text-xs text-muted-foreground truncate">{socket.path}</div>
														</div>
														{#if formSocketPath === socket.path}
															<Check class="w-4 h-4 text-primary shrink-0" />
														{/if}
													</button>
												{/each}
											</div>
										</div>
									{/if}
								</div>
								<p class="text-xs text-muted-foreground">
									{splitAtName(m.envmodal_socket_autodetect_hint)[0]}<Pipette class="w-3 h-3 inline" />{splitAtName(m.envmodal_socket_autodetect_hint)[1]}
								</p>
							</div>
						{/if}

						<!-- Stack path: hawser = backup-only; direct = backup + relative-bind rewrite on deploy -->
						{#if usesStackPath(formConnectionType)}
							<div class="space-y-2">
								<div class="flex items-center gap-1.5">
									<Label for="edit-env-remote-stacks-dir">
										{m.envmodal_remote_stack_path_label()}
										<span class="text-muted-foreground font-normal">{m.envmodal_optional()}</span>
									</Label>
									<Tooltip.Root>
										<Tooltip.Trigger type="button" class="text-muted-foreground hover:text-foreground">
											<HelpCircle class="w-3.5 h-3.5" />
										</Tooltip.Trigger>
										<Tooltip.Content class="w-80 z-[200]" side="right">
											{#if isHawserConn(formConnectionType)}
												<div class="space-y-2">
													<p class="font-medium">{m.envmodal_stackpath_hawser_title()}</p>
													<p class="text-muted-foreground">
														{m.envmodal_stackpath_hawser_before_path()}
														<code class="bg-muted px-1 rounded">{m.envmodal_stackpath_pattern()}</code>
														{m.envmodal_stackpath_hawser_before_host()} <span class="font-medium text-foreground">{m.envmodal_stackpath_hawser_own_host()}</span>{m.envmodal_stackpath_hawser_before_not()} <span class="font-medium text-foreground">{m.envmodal_stackpath_hawser_not()}</span>
														{m.envmodal_stackpath_hawser_before_stacks_dir()}
														<code class="bg-muted px-1 rounded">STACKS_DIR</code>{m.envmodal_stackpath_hawser_after_stacks_dir()}
													</p>
													<p class="text-muted-foreground">
														{m.envmodal_stackpath_hawser_match_before()} <code class="bg-muted px-1 rounded">STACKS_DIR</code>
														{m.envmodal_stackpath_hawser_match_default()} <code class="bg-muted px-1 rounded">/data/stacks</code>{m.envmodal_stackpath_hawser_match_after()}
													</p>
													<p class="text-muted-foreground">
														{m.envmodal_stackpath_hawser_real_before()} <span class="font-medium text-foreground">{m.envmodal_stackpath_hawser_real_path()}</span>
														{m.envmodal_stackpath_hawser_real_after()}
													</p>
												</div>
											{:else}
												<div class="space-y-2">
													<p class="font-medium">{m.envmodal_stackpath_direct_title()}</p>
													<p class="text-muted-foreground">
														{m.envmodal_stackpath_direct_before_path()}
														<code class="bg-muted px-1 rounded">{m.envmodal_stackpath_pattern()}</code>
														<span class="font-medium text-foreground">{m.envmodal_stackpath_direct_remote_host()}</span>
														<span class="font-medium text-foreground">{m.envmodal_stackpath_direct_each_deploy()}</span> {m.envmodal_stackpath_direct_before_bind()}<code class="bg-muted px-1 rounded">./data</code>{m.envmodal_stackpath_direct_after_bind()}
													</p>
													<p class="text-muted-foreground">
														{m.envmodal_stackpath_direct_skip_before()}
														<span class="font-medium text-foreground">{m.envmodal_stackpath_direct_absolute_paths()}</span> {m.envmodal_stackpath_direct_or()}
														<span class="font-medium text-foreground">{m.envmodal_stackpath_direct_named_volumes()}</span> {m.envmodal_stackpath_direct_skip_after()}
													</p>
												</div>
											{/if}
										</Tooltip.Content>
									</Tooltip.Root>
								</div>
								<Input
									id="edit-env-remote-stacks-dir"
									bind:value={formRemoteStacksDir}
									placeholder={isHawserConn(formConnectionType) ? '/data/stacks' : '/opt/dockhand/stacks'}
								/>
								<p class="text-xs text-muted-foreground">
									{#if isHawserConn(formConnectionType)}
										{splitAtName(m.envmodal_stackpath_hawser_hint)[0]}<code class="bg-muted px-1 rounded">/data/stacks</code>{splitAtName(m.envmodal_stackpath_hawser_hint)[1]}
									{:else}
										{m.envmodal_stackpath_direct_hint_before()}
										<span class="text-foreground font-medium">{m.envmodal_stackpath_direct_hint_next_deploy()}</span> {m.envmodal_stackpath_direct_hint_after()}
									{/if}
								</p>
							</div>
						{/if}

						<!-- Direct connection settings -->
						{#if formConnectionType === 'direct'}
							<div class="grid grid-cols-2 gap-4">
								<div class="space-y-2">
									<Label for="edit-env-host">{m.environments_host_label()}</Label>
									<Input
										id="edit-env-host"
										bind:value={formHost}
										placeholder="192.168.1.100"
										class={formErrors.host ? 'border-destructive focus-visible:ring-destructive' : ''}
										oninput={() => { formErrors.host = undefined; handleHostInput(); }}
										onblur={() => handleHostInput(true)}
									/>
									{#if formErrors.host}
										<p class="text-xs text-destructive">{formErrors.host}</p>
									{/if}
								</div>
								<div class="space-y-2">
									<Label for="edit-env-port">{m.environments_port_label()}</Label>
									<Input id="edit-env-port" type="number" bind:value={formPort} />
								</div>
							</div>
							<div class="space-y-2">
								<Label for="edit-env-protocol">{m.environments_protocol_label()}</Label>
								<Select.Root type="single" value={formProtocol} onValueChange={(v) => formProtocol = v}>
									<Select.Trigger class="w-full">
										<span class="flex items-center gap-2">
											{#if formProtocol === 'https'}
												<Lock class="w-4 h-4 text-green-500" />
												HTTPS (TLS)
											{:else}
												<LockOpen class="w-4 h-4 text-muted-foreground" />
												HTTP
											{/if}
										</span>
									</Select.Trigger>
									<Select.Content>
										<Select.Item value="http">
											<span class="flex items-center gap-2">
												<LockOpen class="w-4 h-4 text-muted-foreground" />
												HTTP
											</span>
										</Select.Item>
										<Select.Item value="https">
											<span class="flex items-center gap-2">
												<Lock class="w-4 h-4 text-green-500" />
												HTTPS (TLS)
											</span>
										</Select.Item>
									</Select.Content>
								</Select.Root>
							</div>
							{#if formProtocol === 'https'}
								<div class="space-y-4 pt-2 border-t">
									<p class="text-xs text-muted-foreground">{m.envmodal_tls_certs_hint()}</p>
									<div class="space-y-2">
										<div class="flex items-center justify-between gap-2">
											<Label for="edit-env-tls_ca">{m.environments_tls_ca_label()}</Label>
											<Button variant="ghost" size="sm" type="button" class="h-7 px-2 text-xs" onclick={() => document.getElementById('edit-env-tls_ca-file')?.click()}>
												<Upload class="w-3 h-3 mr-1" />
												{m.envmodal_upload_file()}
											</Button>
											<input
												id="edit-env-tls_ca-file"
												type="file"
												accept=".pem,.crt,.cer,.ca,.cert,application/x-pem-file,application/x-x509-ca-cert"
												class="hidden"
												onchange={(e) => loadPemFromFile(e, (t) => (formTlsCa = t), m.environments_tls_ca_label())}
											/>
										</div>
										<textarea
											id="edit-env-tls_ca"
											bind:value={formTlsCa}
											placeholder="-----BEGIN CERTIFICATE-----"
											class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										></textarea>
									</div>
									<div class="space-y-2">
										<div class="flex items-center justify-between gap-2">
											<Label for="edit-env-tls_cert">{m.environments_tls_cert_label()}</Label>
											<Button variant="ghost" size="sm" type="button" class="h-7 px-2 text-xs" onclick={() => document.getElementById('edit-env-tls_cert-file')?.click()}>
												<Upload class="w-3 h-3 mr-1" />
												{m.envmodal_upload_file()}
											</Button>
											<input
												id="edit-env-tls_cert-file"
												type="file"
												accept=".pem,.crt,.cer,.cert,application/x-pem-file"
												class="hidden"
												onchange={(e) => loadPemFromFile(e, (t) => (formTlsCert = t), m.envmodal_pem_label_client_cert())}
											/>
										</div>
										<textarea
											id="edit-env-tls_cert"
											bind:value={formTlsCert}
											placeholder="-----BEGIN CERTIFICATE-----"
											class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										></textarea>
									</div>
									<div class="space-y-2">
										<div class="flex items-center justify-between gap-2">
											<Label for="edit-env-tls_key">{m.environments_tls_key_label()}</Label>
											<Button variant="ghost" size="sm" type="button" class="h-7 px-2 text-xs" onclick={() => document.getElementById('edit-env-tls_key-file')?.click()}>
												<Upload class="w-3 h-3 mr-1" />
												{m.envmodal_upload_file()}
											</Button>
											<input
												id="edit-env-tls_key-file"
												type="file"
												accept=".pem,.key,application/x-pem-file"
												class="hidden"
												onchange={(e) => loadPemFromFile(e, (t) => (formTlsKey = t), m.envmodal_pem_label_client_key())}
											/>
										</div>
										<textarea
											id="edit-env-tls_key"
											bind:value={formTlsKey}
											placeholder={hasStoredTlsKey ? m.envmodal_tls_key_stored_placeholder() : '-----BEGIN PRIVATE KEY-----'}
											class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										></textarea>
									</div>
								</div>
							{/if}
						{/if}

						<!-- Hawser standard mode settings -->
						{#if formConnectionType === 'hawser-standard'}
							<div class="grid grid-cols-2 gap-4">
								<div class="space-y-2">
									<Label for="edit-env-host">{m.envmodal_agent_host_label()}</Label>
									<Input
										id="edit-env-host"
										bind:value={formHost}
										placeholder="192.168.1.100"
										class={formErrors.host ? 'border-destructive focus-visible:ring-destructive' : ''}
										oninput={() => { formErrors.host = undefined; handleHostInput(); }}
										onblur={() => handleHostInput(true)}
									/>
									{#if formErrors.host}
										<p class="text-xs text-destructive">{formErrors.host}</p>
									{/if}
								</div>
								<div class="space-y-2">
									<Label for="edit-env-port">{m.envmodal_agent_port_label()}</Label>
									<Input id="edit-env-port" type="number" bind:value={formPort} placeholder="2376" />
								</div>
							</div>
							<div class="space-y-2">
								<Label for="edit-env-protocol">{m.environments_protocol_label()}</Label>
								<Select.Root type="single" value={formProtocol} onValueChange={(v) => formProtocol = v}>
									<Select.Trigger class="w-full">
										<span class="flex items-center gap-2">
											{#if formProtocol === 'https'}
												<Lock class="w-4 h-4 text-green-500" />
												HTTPS (TLS)
											{:else}
												<LockOpen class="w-4 h-4 text-muted-foreground" />
												HTTP
											{/if}
										</span>
									</Select.Trigger>
									<Select.Content>
										<Select.Item value="http">
											<span class="flex items-center gap-2">
												<LockOpen class="w-4 h-4 text-muted-foreground" />
												HTTP
											</span>
										</Select.Item>
										<Select.Item value="https">
											<span class="flex items-center gap-2">
												<Lock class="w-4 h-4 text-green-500" />
												HTTPS (TLS)
											</span>
										</Select.Item>
									</Select.Content>
								</Select.Root>
							</div>
							{#if formProtocol === 'https'}
								<div class="space-y-2">
									<div class="flex items-center justify-between gap-2">
										<Label for="edit-env-hawser-tls-ca">{m.envmodal_hawser_ca_label()}</Label>
										<Button variant="ghost" size="sm" type="button" class="h-7 px-2 text-xs" disabled={formTlsSkipVerify} onclick={() => document.getElementById('edit-env-hawser-tls-ca-file')?.click()}>
											<Upload class="w-3 h-3 mr-1" />
											{m.envmodal_upload_file()}
										</Button>
										<input
											id="edit-env-hawser-tls-ca-file"
											type="file"
											accept=".pem,.crt,.cer,.ca,.cert,application/x-pem-file,application/x-x509-ca-cert"
											class="hidden"
											onchange={(e) => loadPemFromFile(e, (t) => (formTlsCa = t), m.environments_tls_ca_label())}
										/>
									</div>
									<textarea
										id="edit-env-hawser-tls-ca"
										bind:value={formTlsCa}
										placeholder="-----BEGIN CERTIFICATE-----"
										class="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono text-xs"
										disabled={formTlsSkipVerify}
									></textarea>
									<p class="text-xs text-muted-foreground">{m.envmodal_hawser_ca_hint()}</p>
								</div>
								<div class="flex items-center justify-between">
									<div>
										<Label>{m.envmodal_skip_tls_verify_label()}</Label>
										<p class="text-xs text-muted-foreground">{m.envmodal_skip_tls_verify_hint()}</p>
									</div>
									<TogglePill bind:checked={formTlsSkipVerify} />
								</div>
							{/if}
							<div class="space-y-2">
								<div class="flex items-center justify-between">
									<Label for="edit-env-hawser-token">{m.envmodal_agent_token_label()}</Label>
									{#if !formHawserToken}
										<Button
											variant="outline"
											size="sm"
											class="h-7 text-xs"
											onclick={generateStandardToken}
										>
											<Key class="w-3 h-3" />
											{m.envmodal_generate()}
										</Button>
									{/if}
								</div>
								<Input id="edit-env-hawser-token" type="password" bind:value={formHawserToken} placeholder={hasStoredHawserToken ? m.envmodal_token_stored_placeholder() : m.envmodal_token_placeholder()} oninput={() => generatedStandardToken = null} />
								{#if generatedStandardToken}
									<div class="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded-md space-y-2">
										<p class="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1">
											<AlertTriangle class="w-3 h-3" />
											{m.envmodal_copy_token_now_standard()}
										</p>
										<div class="flex gap-2">
											<Input
												type="text"
												value={generatedStandardToken}
												readonly
												class="font-mono text-xs flex-1"
											/>
											<Button variant="outline" size="sm" onclick={() => copyToken(generatedStandardToken!)}>
												{#if copySuccess === 'error'}
													<Tooltip.Root open>
														<Tooltip.Trigger>
															<XCircle class="w-4 h-4 text-red-500" />
														</Tooltip.Trigger>
														<Tooltip.Content>{m.containers_inspect_copy_requires_https()}</Tooltip.Content>
													</Tooltip.Root>
												{:else if copySuccess === 'ok'}
													<Check class="w-4 h-4 text-green-500" />
												{:else}
													<Copy class="w-4 h-4" />
												{/if}
											</Button>
											<Button variant="outline" size="sm" onclick={() => { formHawserToken = ''; generateStandardToken(); }}>
												<RefreshCw class="w-4 h-4" />
											</Button>
										</div>
									</div>
								{:else}
									<p class="text-xs text-muted-foreground">{splitAtName(m.envmodal_standard_token_hint)[0]}<code class="bg-muted px-1 rounded">TOKEN</code>{splitAtName(m.envmodal_standard_token_hint)[1]}</p>
								{/if}
							</div>
							<div class="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 flex items-start gap-2">
								<Info class="w-3 h-3 mt-0.5 shrink-0" />
								<div class="space-y-1 flex-1">
									<span>{m.envmodal_run_hawser_standard()}</span>
									<div class="flex items-start gap-1.5">
										<code class="bg-muted px-1.5 py-0.5 rounded break-all flex-1">{formHawserToken ? `TOKEN=${formHawserToken} ` : ''}hawser standard --port {formPort}</code>
										{#if formHawserToken}
											<button
												class="shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
												onclick={() => {
													const cmd = `${formHawserToken ? `TOKEN=${formHawserToken} ` : ''}hawser standard --port ${formPort}`;
													copyToClipboard(cmd).then(ok => {
														copyCmdSuccess = ok ? 'ok' : 'error';
														setTimeout(() => { copyCmdSuccess = null; }, 2000);
													});
												}}
												title={m.envmodal_copy_command()}
											>
												{#if copyCmdSuccess === 'error'}
													<Tooltip.Root open>
														<Tooltip.Trigger>
															<XCircle class="w-3 h-3 text-red-500" />
														</Tooltip.Trigger>
														<Tooltip.Content>{m.containers_inspect_copy_requires_https()}</Tooltip.Content>
													</Tooltip.Root>
												{:else if copyCmdSuccess === 'ok'}
													<Check class="w-3 h-3 text-green-600" />
												{:else}
													<Copy class="w-3 h-3" />
												{/if}
											</button>
										{/if}
									</div>
								</div>
							</div>
						{/if}

						<!-- Hawser edge mode settings -->
						{#if formConnectionType === 'hawser-edge'}
							<div class="space-y-4">
								<!-- Connection status (edit mode only) -->
								{#if isEditing && environment}
									<div class="flex items-center justify-between">
										<Label>{m.envmodal_connection_status_label()}</Label>
										{#if environment.hawserAgentId}
											<Badge variant="outline" class="bg-green-50 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700">
												<Wifi class="w-3 h-3 mr-1" />
												{m.environments_test_connected()}
											</Badge>
										{:else}
											<Badge variant="outline" class="bg-slate-50 text-slate-500 border-slate-300 dark:bg-slate-900/30 dark:text-slate-400 dark:border-slate-700">
												<WifiOff class="w-3 h-3 mr-1" />
												{m.envmodal_waiting_for_agent()}
											</Badge>
										{/if}
									</div>

									<!-- Agent info if connected -->
									{#if environment.hawserAgentId}
										<div class="text-xs bg-muted/30 rounded-md p-2 space-y-1">
											<p><span class="text-muted-foreground">{m.envmodal_agent_info_agent()}</span> {environment.hawserAgentName || environment.hawserAgentId}</p>
											{#if environment.hawserVersion}
												<p><span class="text-muted-foreground">{m.envmodal_agent_info_version()}</span> {environment.hawserVersion}</p>
											{/if}
											{#if environment.hawserLastSeen}
												<p><span class="text-muted-foreground">{m.envmodal_agent_info_last_seen()}</span> {formatDateTime(environment.hawserLastSeen, true)}</p>
											{/if}
										</div>
									{/if}
								{/if}

								<!-- Token section -->
								<div class="space-y-2">
									<div class="flex items-center justify-between">
										<Label>{m.envmodal_connection_token_label()}</Label>
										{#if isEditing && hawserToken}
											<Button
												variant="outline"
												size="sm"
												class="h-7 text-xs"
												onclick={() => environment && regenerateHawserToken(environment.id)}
												disabled={generatingToken}
											>
												{#if generatingToken}
													<Loader2 class="w-3 h-3 mr-1 animate-spin" />
												{:else}
													<RefreshCw class="w-3 h-3" />
												{/if}
												{m.envmodal_regenerate()}
											</Button>
										{:else if isEditing && !hawserToken && !hawserTokenLoading}
											<Button
												variant="outline"
												size="sm"
												class="h-7 text-xs"
												onclick={() => environment && generateHawserToken(environment.id)}
												disabled={generatingToken}
											>
												{#if generatingToken}
													<Loader2 class="w-3 h-3 mr-1 animate-spin" />
												{:else}
													<Plus class="w-3 h-3" />
												{/if}
												{m.envmodal_generate()}
											</Button>
										{/if}
									</div>

									<!-- Add mode: auto-generate token on first visit -->
									{#if !isEditing}
										{#if !pendingToken}
											<Button
												variant="outline"
												size="sm"
												class="w-full"
												onclick={generatePendingToken}
											>
												<Key class="w-3.5 h-3.5 mr-1.5" />
												{m.envmodal_generate_connection_token()}
											</Button>
											<p class="text-xs text-muted-foreground">
												{m.envmodal_generate_token_now_hint()}
											</p>
										{:else}
											<!-- Show pending token -->
											<div class="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded-md space-y-2">
												<p class="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1">
													<AlertTriangle class="w-3 h-3" />
													{m.envmodal_copy_token_now_edge()}
												</p>
												<div class="flex gap-2">
													<Input
														type="text"
														value={pendingToken}
														readonly
														class="font-mono text-xs flex-1"
													/>
													<Button variant="outline" size="sm" onclick={() => copyToken(pendingToken!)}>
														{#if copySuccess === 'error'}
															<Tooltip.Root open>
																<Tooltip.Trigger>
																	<XCircle class="w-4 h-4 text-red-500" />
																</Tooltip.Trigger>
																<Tooltip.Content>{m.containers_inspect_copy_requires_https()}</Tooltip.Content>
															</Tooltip.Root>
														{:else if copySuccess === 'ok'}
															<Check class="w-4 h-4 text-green-500" />
														{:else}
															<Copy class="w-4 h-4" />
														{/if}
													</Button>
												</div>
												<div class="text-xs text-amber-600 dark:text-amber-300 space-y-1">
													<span>{m.envmodal_run_on_your_host()}</span>
													<div class="flex items-start gap-1.5">
														<code class="bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 rounded break-all flex-1">DOCKHAND_SERVER_URL={getConnectionUrl()} TOKEN={pendingToken} hawser</code>
														<button
															class="shrink-0 p-0.5 rounded hover:bg-amber-200 dark:hover:bg-amber-800 transition-colors"
															onclick={() => copyCommand(pendingToken!)}
															title={m.envmodal_copy_command()}
														>
															{#if copyCmdSuccess === 'error'}
																<Tooltip.Root open>
																	<Tooltip.Trigger>
																		<XCircle class="w-3 h-3 text-red-500" />
																	</Tooltip.Trigger>
																	<Tooltip.Content>{m.containers_inspect_copy_requires_https()}</Tooltip.Content>
																</Tooltip.Root>
															{:else if copyCmdSuccess === 'ok'}
																<Check class="w-3 h-3 text-green-600" />
															{:else}
																<Copy class="w-3 h-3" />
															{/if}
														</button>
													</div>
												</div>
												<Button variant="ghost" size="sm" class="h-6 text-xs" onclick={generatePendingToken}>
													<RefreshCw class="w-3 h-3" />
													{m.envmodal_generate_new_token()}
												</Button>
											</div>
										{/if}
									{/if}

									<!-- Edit mode: show existing token or newly generated -->
									{#if isEditing}
										{#if hawserTokenLoading}
											<div class="flex items-center justify-center py-4">
												<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
											</div>
										{:else if generatedToken}
											<!-- Just generated a new token - show full value -->
											<div class="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded-md space-y-2">
												<p class="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1">
													<AlertTriangle class="w-3 h-3" />
													{m.envmodal_save_token_now()}
												</p>
												<div class="flex gap-2">
													<Input
														type="text"
														value={generatedToken}
														readonly
														class="font-mono text-xs flex-1"
													/>
													<Button variant="outline" size="sm" onclick={() => copyToken(generatedToken!)}>
														{#if copySuccess === 'error'}
															<Tooltip.Root open>
																<Tooltip.Trigger>
																	<XCircle class="w-4 h-4 text-red-500" />
																</Tooltip.Trigger>
																<Tooltip.Content>{m.containers_inspect_copy_requires_https()}</Tooltip.Content>
															</Tooltip.Root>
														{:else if copySuccess === 'ok'}
															<Check class="w-4 h-4 text-green-500" />
														{:else}
															<Copy class="w-4 h-4" />
														{/if}
													</Button>
												</div>
												<div class="text-xs text-amber-600 dark:text-amber-300 space-y-1">
													<span>{m.envmodal_run_on_your_host()}</span>
													<div class="flex items-start gap-1.5">
														<code class="bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 rounded break-all flex-1">DOCKHAND_SERVER_URL={getConnectionUrl()} TOKEN={generatedToken} hawser</code>
														<button
															class="shrink-0 p-0.5 rounded hover:bg-amber-200 dark:hover:bg-amber-800 transition-colors"
															onclick={() => copyCommand(generatedToken!)}
															title={m.envmodal_copy_command()}
														>
															{#if copyCmdSuccess === 'error'}
																<Tooltip.Root open>
																	<Tooltip.Trigger>
																		<XCircle class="w-3 h-3 text-red-500" />
																	</Tooltip.Trigger>
																	<Tooltip.Content>{m.containers_inspect_copy_requires_https()}</Tooltip.Content>
																</Tooltip.Root>
															{:else if copyCmdSuccess === 'ok'}
																<Check class="w-3 h-3 text-green-600" />
															{:else}
																<Copy class="w-3 h-3" />
															{/if}
														</button>
													</div>
												</div>
											</div>
										{:else if hawserToken}
											<!-- Existing token - show partial -->
											<div class="flex items-center gap-2 p-2 bg-muted/30 rounded-md text-xs">
												<Key class="w-3.5 h-3.5 text-muted-foreground" />
												<span class="font-mono">{hawserToken.tokenPrefix}...</span>
												{#if hawserToken.lastUsed}
													<span class="text-muted-foreground ml-auto flex items-center gap-1">
														<Clock class="w-3 h-3" />
														{m.envmodal_token_last_used({ date: formatDate(hawserToken.lastUsed) })}
													</span>
												{/if}
											</div>
										{:else}
											<p class="text-xs text-muted-foreground text-center py-2">{m.envmodal_no_token_yet()}</p>
										{/if}
									{/if}
								</div>
							</div>
						{/if}

						<!-- Public IP field -->
						<div class="space-y-2 pt-4 border-t">
							<div class="flex items-center gap-2">
								<Label for="edit-env-public-ip">{m.envmodal_public_ip_label()}</Label>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
									</Tooltip.Trigger>
									<Tooltip.Content side="bottom" class="w-72">
										<p>{m.envmodal_public_ip_help()}</p>
									</Tooltip.Content>
								</Tooltip.Root>
							</div>
							<Input
								id="edit-env-public-ip"
								bind:value={formPublicIp}
								placeholder={m.envmodal_public_ip_placeholder()}
								class="w-full"
							/>
							<p class="text-xs text-muted-foreground">
								{m.envmodal_public_ip_hint()}
							</p>
						</div>
					</Tabs.Content>

				<!-- Updates Tab -->
				<Tabs.Content value="updates" class="space-y-4 mt-0 h-full">
					<UpdatesTab
						updateCheckLoading={updateCheckLoading}
						bind:updateCheckEnabled={updateCheckEnabled}
						bind:updateCheckCron={updateCheckCron}
						bind:updateCheckAutoUpdate={updateCheckAutoUpdate}
						bind:updateCheckVulnerabilityCriteria={updateCheckVulnerabilityCriteria}
						bind:minimumReleaseAgeHours={minimumReleaseAgeHours}
						minimumReleaseAgeOverridden={minimumReleaseAgeOverridden}
						bind:minimumReleaseAgeOverride={minimumReleaseAgeOverride}
						scannerEnabled={scannerEnabled}
						imagePruneLoading={imagePruneLoading}
						bind:imagePruneEnabled={imagePruneEnabled}
						bind:imagePruneCron={imagePruneCron}
						bind:imagePruneMode={imagePruneMode}
						imagePruneLastPruned={imagePruneLastPruned}
						imagePruneLastResult={imagePruneLastResult}
						bind:timezone={formTimezone}
					/>
				</Tabs.Content>

				<!-- Activity Tab -->
				<Tabs.Content value="activity" class="space-y-4 mt-0 h-full">
					<ActivityTab
						bind:collectActivity={formCollectActivity}
						bind:collectMetrics={formCollectMetrics}
						bind:highlightChanges={formHighlightChanges}
						bind:diskWarningEnabled={formDiskWarningEnabled}
						bind:diskWarningMode={formDiskWarningMode}
						bind:diskWarningThreshold={formDiskWarningThreshold}
						bind:diskWarningThresholdGb={formDiskWarningThresholdGb}
						percentageSupported={formPercentageSupported}
						storageDriver={formStorageDriver}
						{storedDiskWarningMode}
					/>
				</Tabs.Content>

				<!-- Security Tab -->
				<Tabs.Content value="security" class="space-y-4 mt-0 h-full">
					<div class="space-y-4">
						<div class="flex items-center gap-2 text-sm font-medium">
							<ShieldCheck class="w-4 h-4" />
							{m.envmodal_vulnerability_scanning()}
						</div>

						{#if !isEditing}
							<!-- Add mode - full security settings -->
							<div class="flex items-start gap-3">
								<div class="flex-1">
									<Label>{m.envmodal_enable_scanning()}</Label>
									<p class="text-xs text-muted-foreground">{m.envmodal_enable_scanning_hint()}</p>
								</div>
								<TogglePill bind:checked={formEnableScanner} />
							</div>

							{#if formEnableScanner}
								<div class="flex items-start gap-3">
									<div class="flex-1">
										<Label>{m.envmodal_scanner_label()}</Label>
										<p class="text-xs text-muted-foreground">{m.envmodal_scanner_hint()}</p>
									</div>
									<ToggleGroup
										value={formScannerType}
										options={scannerOptions}
										onchange={(v) => { formScannerType = v as ScannerType; }}
									/>
								</div>

								<div class="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 flex items-start gap-2">
									<Info class="w-3 h-3 mt-0.5 shrink-0" />
									<span>{m.envmodal_scanner_images_info()}</span>
								</div>
							{/if}
						{:else if scannerLoading}
							<div class="flex items-center justify-center py-4">
								<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
							</div>
						{:else}
							<div class="flex items-start gap-3">
								<div class="flex-1">
									<Label>{m.envmodal_enable_scanning()}</Label>
									<p class="text-xs text-muted-foreground">{m.envmodal_enable_scanning_hint()}</p>
								</div>
								<TogglePill bind:checked={scannerEnabled} />
							</div>

							{#if scannerEnabled}
								<div class="flex items-start gap-3">
									<div class="flex-1">
										<Label>{m.envmodal_scanner_label()}</Label>
										<p class="text-xs text-muted-foreground">{m.envmodal_scanner_hint()}</p>
									</div>
									<ToggleGroup
										value={selectedScanner}
										options={scannerOptions}
										onchange={(v) => { selectedScanner = v as ScannerType; }}
									/>
								</div>

								<div class="space-y-2">
									<!-- Grype row -->
									{#if selectedScanner === 'grype' || selectedScanner === 'both'}
									<div class="px-3 py-2 rounded-md bg-muted/30 space-y-2">
										<div class="flex items-center gap-2">
											<span class="text-xs font-medium w-12">Grype</span>
											{#if loadingScannerVersions}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 flex items-center gap-0.5">
													<Loader2 class="w-2 h-2 animate-spin text-muted-foreground" />
												</Badge>
											{:else if scannerAvailability.grype && scannerVersions.grype}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">v{scannerVersions.grype}</Badge>
											{:else if scannerAvailability.grype}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">{m.envmodal_scanner_ready()}</Badge>
											{:else}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-amber-500/10 text-amber-600 border-amber-500/30">{m.envmodal_scanner_not_installed()}</Badge>
											{/if}
											{#if !loadingScannerVersions}
												{#if !scannerAvailability.grype}
													<ImagePullProgressPopover imageName={scannerGrypeImage} envId={environment?.id} onComplete={() => reloadScannerAvailability(environment?.id)}>
														<button class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
															<Download class="w-2.5 h-2.5 mr-0.5" />
															{m.images_list_pull()}
														</button>
													</ImagePullProgressPopover>
												{:else}
													<button
														class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border border-destructive/30 bg-destructive/10 hover:bg-destructive/20 text-destructive transition-colors disabled:opacity-50"
														onclick={() => removeGrype(environment?.id)}
														disabled={removingGrype}
													>
														{#if removingGrype}
															<Loader2 class="w-2.5 h-2.5 mr-0.5 animate-spin" />
														{:else}
															<Trash2 class="w-2.5 h-2.5 mr-0.5" />
														{/if}
														{m.containers_list_remove()}
													</button>
													{#if grypeUpdateStatus === 'up-to-date'}
														<span class="inline-flex items-center text-2xs px-1.5 py-0 h-4 text-green-600">
															<CheckCircle2 class="w-2.5 h-2.5 mr-0.5" />
															{m.envmodal_scanner_latest()}
														</span>
													{:else if grypeUpdateStatus === 'update-available' || pullingGrype}
														<button
															class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 transition-colors disabled:opacity-50"
															onclick={() => pullGrypeImage()}
															disabled={pullingGrype}
														>
															{#if pullingGrype}
																<Loader2 class="w-2.5 h-2.5 mr-0.5 animate-spin" />
																{m.envmodal_scanner_pulling()}
															{:else}
																<Download class="w-2.5 h-2.5 mr-0.5" />
																{#if grypeNewerVersion}{m.envmodal_scanner_update_to({ version: grypeNewerVersion })}{:else}{m.containers_list_update()}{/if}
															{/if}
														</button>
													{:else}
														<button
															class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
															onclick={() => checkGrypeUpdate()}
															disabled={checkingGrypeUpdate}
														>
															{#if checkingGrypeUpdate}
																<Loader2 class="w-2.5 h-2.5 mr-0.5 animate-spin" />
																{m.envmodal_scanner_checking()}
															{:else}
																<RefreshCw class="w-2.5 h-2.5 mr-0.5" />
																{m.envmodal_scanner_check()}
															{/if}
														</button>
													{/if}
												{/if}
											{/if}
										</div>
									</div>
									{/if}

									<!-- Trivy row -->
									{#if selectedScanner === 'trivy' || selectedScanner === 'both'}
									<div class="px-3 py-2 rounded-md bg-muted/30 space-y-2">
										<div class="flex items-center gap-2">
											<span class="text-xs font-medium w-12">Trivy</span>
											{#if loadingScannerVersions}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 flex items-center gap-0.5">
													<Loader2 class="w-2 h-2 animate-spin text-muted-foreground" />
												</Badge>
											{:else if scannerAvailability.trivy && scannerVersions.trivy}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">v{scannerVersions.trivy}</Badge>
											{:else if scannerAvailability.trivy}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">{m.envmodal_scanner_ready()}</Badge>
											{:else}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-amber-500/10 text-amber-600 border-amber-500/30">{m.envmodal_scanner_not_installed()}</Badge>
											{/if}
											{#if !loadingScannerVersions}
												{#if !scannerAvailability.trivy}
													<ImagePullProgressPopover imageName={scannerTrivyImage} envId={environment?.id} onComplete={() => reloadScannerAvailability(environment?.id)}>
														<button class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
															<Download class="w-2.5 h-2.5 mr-0.5" />
															{m.images_list_pull()}
														</button>
													</ImagePullProgressPopover>
												{:else}
													<button
														class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border border-destructive/30 bg-destructive/10 hover:bg-destructive/20 text-destructive transition-colors disabled:opacity-50"
														onclick={() => removeTrivy(environment?.id)}
														disabled={removingTrivy}
													>
														{#if removingTrivy}
															<Loader2 class="w-2.5 h-2.5 mr-0.5 animate-spin" />
														{:else}
															<Trash2 class="w-2.5 h-2.5 mr-0.5" />
														{/if}
														{m.containers_list_remove()}
													</button>
													{#if trivyUpdateStatus === 'up-to-date'}
														<span class="inline-flex items-center text-2xs px-1.5 py-0 h-4 text-green-600">
															<CheckCircle2 class="w-2.5 h-2.5 mr-0.5" />
															{m.envmodal_scanner_latest()}
														</span>
													{:else if trivyUpdateStatus === 'update-available' || pullingTrivy}
														<button
															class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 transition-colors disabled:opacity-50"
															onclick={() => pullTrivyImage()}
															disabled={pullingTrivy}
														>
															{#if pullingTrivy}
																<Loader2 class="w-2.5 h-2.5 mr-0.5 animate-spin" />
																{m.envmodal_scanner_pulling()}
															{:else}
																<Download class="w-2.5 h-2.5 mr-0.5" />
																{#if trivyNewerVersion}{m.envmodal_scanner_update_to({ version: trivyNewerVersion })}{:else}{m.containers_list_update()}{/if}
															{/if}
														</button>
													{:else}
														<button
															class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
															onclick={() => checkTrivyUpdate()}
															disabled={checkingTrivyUpdate}
														>
															{#if checkingTrivyUpdate}
																<Loader2 class="w-2.5 h-2.5 mr-0.5 animate-spin" />
																{m.envmodal_scanner_checking()}
															{:else}
																<RefreshCw class="w-2.5 h-2.5 mr-0.5" />
																{m.envmodal_scanner_check()}
															{/if}
														</button>
													{/if}
												{/if}
											{/if}
										</div>
									</div>
									{/if}

									<!-- Info about automatic download -->
									{#if ((selectedScanner === 'grype' || selectedScanner === 'both') && !scannerAvailability.grype) || ((selectedScanner === 'trivy' || selectedScanner === 'both') && !scannerAvailability.trivy)}
										<div class="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 flex items-start gap-2">
											<Info class="w-3 h-3 mt-0.5 shrink-0" />
											<span>{m.envmodal_scanner_images_info()}</span>
										</div>
									{/if}
								</div>
							{/if}
						{/if}
					</div>
				</Tabs.Content>

				<!-- Notifications Tab -->
				<!-- Backup Tab -->
				<Tabs.Content value="backup" class="mt-0 h-full">
					{#if environment?.id}
						<EnvironmentBackupsTab
							environmentId={environment.id}
							environmentName={environment.name}
							connectionType={environment.connectionType}
							host={environment.host}
						/>
					{:else}
						<p class="text-sm text-muted-foreground py-4">{m.envmodal_backups_save_first()}</p>
					{/if}
				</Tabs.Content>

				<Tabs.Content value="notifications" class="mt-0 h-full flex flex-col">
					<div class="flex items-center gap-2 text-sm font-medium flex-shrink-0">
						<Bell class="w-4 h-4" />
						{m.envmodal_notification_channels_title()}
					</div>

					{#if !isEditing}
						<!-- Add mode - show available channels to select -->
						<p class="text-xs text-muted-foreground mt-2 flex-shrink-0">
							{m.envmodal_notifications_select_hint()}
						</p>

						{#if notifications.length === 0}
							<div class="flex-1 flex flex-col items-center justify-center py-8 text-center">
								<Bell class="w-10 h-10 text-muted-foreground mb-3 opacity-50" />
								<p class="text-sm text-muted-foreground">{m.envmodal_no_channels_yet()}</p>
								<p class="text-xs text-muted-foreground mt-1">{m.envmodal_create_channels_first()}</p>
							</div>
						{:else}
							<div class="space-y-2 mt-3 flex-1 overflow-y-auto min-h-0">
								{#each notifications as channel (channel.id)}
									{@const isSelected = formSelectedNotifications.some(n => n.id === channel.id)}
									{@const selectedNotif = formSelectedNotifications.find(n => n.id === channel.id)}
									<div class="p-2 rounded-md border bg-card {isSelected ? 'border-primary/50' : ''}">
										<div class="flex items-center justify-between gap-2">
											<div class="flex items-center gap-1.5 min-w-0">
												{#if channel.type === 'smtp'}
													<Mail class="w-3.5 h-3.5 shrink-0 text-blue-500" />
												{:else}
													<Send class="w-3.5 h-3.5 shrink-0 text-purple-500" />
												{/if}
												<span class="text-xs font-medium truncate">{channel.name} <span class="text-2xs text-muted-foreground capitalize font-normal">({channel.type})</span></span>
											</div>
											<div class="flex items-center gap-1 shrink-0">
												<TogglePill
													checked={isSelected}
													disabled={!channel.enabled}
													onchange={() => {
														if (isSelected) {
															formSelectedNotifications = formSelectedNotifications.filter(n => n.id !== channel.id);
														} else {
															formSelectedNotifications = [...formSelectedNotifications, { id: channel.id, eventTypes: NOTIFICATION_EVENT_TYPES.map(e => e.id) }];
														}
													}}
												/>
											</div>
										</div>
										{#if !channel.enabled}
											<p class="text-2xs text-amber-600 mt-1 flex items-center gap-1">
												<AlertCircle class="w-2.5 h-2.5" />
												{m.envmodal_channel_disabled_globally()}
											</p>
										{/if}
										<!-- Event Types (only show if selected) -->
										{#if isSelected && selectedNotif}
											{@const isCollapsed = collapsedChannels.has(channel.id)}
											<div class="mt-2 pt-2 border-t">
												<div
													class="flex items-center gap-1 cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5 -mx-1"
													role="button"
													tabindex="0"
													onclick={() => toggleChannelCollapse(channel.id)}
													onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleChannelCollapse(channel.id); } }}
												>
													{#if isCollapsed}
														<ChevronRight class="w-3 h-3 text-muted-foreground" />
													{:else}
														<ChevronDown class="w-3 h-3 text-muted-foreground" />
													{/if}
													<span class="text-xs text-muted-foreground">{m.envmodal_event_types_count({ count: selectedNotif.eventTypes.length })}</span>
												</div>
												{#if !isCollapsed}
													<EventTypesEditor
														selectedEventTypes={selectedNotif.eventTypes}
														onchange={(newTypes) => {
															formSelectedNotifications = formSelectedNotifications.map(n =>
																n.id === channel.id ? { ...n, eventTypes: newTypes } : n
															);
														}}
													/>
												{/if}
											</div>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					{:else}
						<p class="text-xs text-muted-foreground mt-2 flex-shrink-0">
							{m.envmodal_notifications_configure_hint()}
							{#if environment && !environment.collectActivity}
								<span class="text-amber-500">{m.envmodal_activity_auto_enable()}</span>
							{/if}
						</p>

						{#if envNotifLoading}
							<div class="flex items-center justify-center py-8 flex-1">
								<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
							</div>
						{:else}
							<!-- Configured Channels - scrollable area -->
							{#if envNotifications.length > 0}
								<div class="space-y-2 mt-3 flex-1 overflow-y-auto min-h-0">
									{#each envNotifications as notif (notif.id)}
										<div class="rounded-md border bg-card overflow-hidden">
											<!-- Channel Header - Clickable to collapse -->
											<div
												class="flex items-center justify-between gap-2 p-2 cursor-pointer hover:bg-muted/30 transition-colors"
												role="button"
												tabindex="0"
												onclick={() => toggleChannelCollapse(notif.notificationId)}
												onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleChannelCollapse(notif.notificationId); } }}
											>
												<div class="flex items-center gap-2 min-w-0">
													{#if collapsedChannels.has(notif.notificationId)}
														<ChevronRight class="w-4 h-4 text-muted-foreground shrink-0" />
													{:else}
														<ChevronDown class="w-4 h-4 text-muted-foreground shrink-0" />
													{/if}
													{#if notif.channelType === 'smtp'}
														<Mail class="w-4 h-4 shrink-0 text-blue-500" />
													{:else}
														<Send class="w-4 h-4 shrink-0 text-purple-500" />
													{/if}
													<span class="text-sm font-medium truncate">{notif.channelName}</span>
													<span class="text-xs text-muted-foreground">{m.envmodal_events_count({ count: notif.eventTypes.length })}</span>
												</div>
												<div class="flex items-center gap-1 shrink-0" role="group" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
													<TogglePill
														checked={notif.enabled}
														disabled={!notif.channelEnabled}
														onchange={() => environment && updateEnvNotification(environment.id, notif.notificationId, { enabled: !notif.enabled, eventTypes: notif.eventTypes })}
													/>
													<Button
														variant="ghost"
														size="sm"
														class="h-6 w-6 p-0 text-destructive hover:text-destructive"
														onclick={() => environment && deleteEnvNotification(environment.id, notif.notificationId)}
													>
														<Trash2 class="w-3 h-3" />
													</Button>
												</div>
											</div>
											{#if !notif.channelEnabled}
												<div class="px-2 pb-2">
													<p class="text-2xs text-amber-600 flex items-center gap-1">
														<AlertCircle class="w-2.5 h-2.5" />
														{m.envmodal_channel_disabled_globally()}
													</p>
												</div>
											{/if}
											<!-- Event Types - collapsible content -->
											{#if !collapsedChannels.has(notif.notificationId)}
												<div class="px-2 pb-2 pt-1 border-t">
													<EventTypesEditor
														selectedEventTypes={notif.eventTypes}
														onchange={(newTypes) => {
															environment && updateEnvNotification(environment.id, notif.notificationId, { enabled: notif.enabled, eventTypes: newTypes });
														}}
													/>
												</div>
											{/if}
										</div>
									{/each}
								</div>
							{:else}
								<div class="text-center py-6 text-muted-foreground">
									<Bell class="w-8 h-8 mx-auto mb-2 opacity-50" />
									<p class="text-sm">{m.envmodal_no_channels_configured()}</p>
									<p class="text-xs mt-1">{m.envmodal_add_channel_below()}</p>
								</div>
							{/if}

							<!-- Add Channel - fixed at bottom -->
							{@const availableChannels = notifications.filter(n => !envNotifications.some(en => en.notificationId === n.id))}
							{#if availableChannels.length > 0}
								<div class="pt-3 border-t flex-shrink-0 mt-4">
									<Label class="text-xs text-muted-foreground mb-2 block">{m.envmodal_add_notification_channel()}</Label>
									<div class="flex flex-wrap gap-2">
										{#each availableChannels as channel}
											<button
												class="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border bg-muted/30 hover:bg-muted transition-colors"
												onclick={() => environment && addEnvNotification(environment.id, channel.id)}
											>
												{#if channel.type === 'smtp'}
													<Mail class="w-3 h-3 text-blue-500" />
												{:else}
													<Send class="w-3 h-3 text-purple-500" />
												{/if}
												{channel.name}
												<Plus class="w-3 h-3 ml-1" />
											</button>
										{/each}
									</div>
								</div>
							{:else if notifications.length === 0}
								<div class="p-3 rounded-md bg-muted/30 text-xs text-muted-foreground flex items-start gap-2 flex-shrink-0 mt-4">
									<Info class="w-3.5 h-3.5 mt-0.5 shrink-0" />
									{#if !$licenseStore.isEnterprise || $canAccess('notifications', 'create')}
										<span>{m.envmodal_no_channels_created_before()} <a href="/settings?tab=notifications" class="text-primary hover:underline" onclick={onClose}>{m.envmodal_no_channels_created_link()}</a> {m.envmodal_no_channels_created_after()}</span>
									{:else}
										<span>{m.envmodal_no_channels_created_contact_admin()}</span>
									{/if}
								</div>
							{/if}
						{/if}
					{/if}
				</Tabs.Content>

				<!-- Scheduled state report. Admin only - the mail carries the full inventory
				     and its vulnerabilities out of the installation, unattended. -->
				{#if isAdmin}
					<Tabs.Content value="reports" class="mt-0 h-full">
						<ReportsTab
							environmentId={environment?.id ?? null}
							{reportLoading}
							bind:reportEnabled
							bind:reportCron
							bind:reportFormat
							bind:reportNotificationId
							{smtpChannels}
							licensed={$licenseStore.licenseType === 'smb' || $licenseStore.licenseType === 'enterprise'}
						/>
					</Tabs.Content>
				{/if}
			</div>
		</Tabs.Root>

		<Dialog.Footer class="flex-shrink-0 border-t pt-4">
			<div class="flex items-center gap-2 w-full">
				<!-- Test connection button (left side) -->
				<Button
					variant="outline"
					onclick={testConnection}
					disabled={testingConnection || formSaving}
					class="mr-auto"
				>
					{#if testingConnection}
						<Loader2 class="w-4 h-4 animate-spin" />
						{m.envmodal_testing()}
					{:else if testResult?.success}
						<CheckCircle2 class="w-4 h-4 text-green-500" />
						{m.envmodal_test_connection()}
					{:else if testResult && !testResult.success}
						<AlertCircle class="w-4 h-4 text-red-500" />
						{m.envmodal_test_connection()}
					{:else}
						<Wifi class="w-4 h-4" />
						{m.envmodal_test_connection()}
					{/if}
				</Button>

				{#if !isEditing}
					<!-- Add mode -->
					<Button variant="outline" onclick={onClose}>
						{m.environments_cancel()}
					</Button>
					<Button onclick={createEnvironment} disabled={formSaving}>
						{#if formSaving}
							<RefreshCw class="w-4 h-4 animate-spin" />
						{:else}
							<Plus class="w-4 h-4" />
						{/if}
						{m.environments_add_button()}
					</Button>
				{:else}
					<!-- Edit mode -->
					<Button variant="outline" onclick={onClose}>
						{m.environments_cancel()}
					</Button>
					<Button onclick={updateEnvironment} disabled={formSaving}>
						{#if formSaving}
							<RefreshCw class="w-4 h-4 animate-spin" />
						{:else}
							<Check class="w-4 h-4" />
						{/if}
						{m.environments_save_button()}
					</Button>
				{/if}
			</div>
		</Dialog.Footer>
		<AvatarCropper
			show={showIconCropper}
			imageUrl={iconCropperImageUrl}
			cropShape="round"
			outputSize={128}
			outputFormat="image/webp"
			outputQuality={0.85}
			title={m.stacks_icon_crop_title()}
			saveLabel={m.stacks_icon_save()}
			onCancel={() => showIconCropper = false}
			onSave={handleIconCropSave}
		/>
	</Dialog.Content>
</Dialog.Root>

<!-- Kernel cgroup memory accounting is disabled on this daemon (container memory shows 0). -->
<Dialog.Root bind:open={memWarnOpen}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2 text-amber-600 dark:text-amber-400">
				<AlertTriangle class="w-5 h-5" />
				{m.envmodal_mem_warning_title()}
			</Dialog.Title>
		</Dialog.Header>
		<div class="text-sm text-muted-foreground space-y-3">
			<p>
				{splitAtName(m.envmodal_mem_warning_body)[0]}<span class="font-medium text-foreground whitespace-nowrap">0&nbsp;B</span>{splitAtName(m.envmodal_mem_warning_body)[1]}
			</p>
			<p>
				{m.envmodal_mem_warning_fix()}
				<a href={MEMORY_SUPPORT_DOC_URL} target="_blank" rel="noopener noreferrer"
					class="text-primary hover:underline inline-flex items-center gap-1">
					{m.envmodal_mem_warning_guide_link()}
					<ExternalLink class="w-3 h-3" />
				</a>
			</p>
		</div>
		<Dialog.Footer>
			<Button onclick={() => (memWarnOpen = false)}>{m.stacks_modal_ok()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Env-rename confirmation: only fires for socket/direct envs where the
     server actually moves $DATA_DIR/stacks/<oldName> → <newName>. -->
<Dialog.Root bind:open={showRenameConfirm}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<AlertTriangle class="w-5 h-5 text-amber-500" />
				{m.envmodal_rename_title()}
			</Dialog.Title>
			<Dialog.Description class="pt-2 space-y-3 text-sm">
				<p>{m.envmodal_rename_dirs_moved()}</p>
				<div class="space-y-1 text-xs font-mono bg-muted/40 rounded-md p-3 border overflow-x-auto">
					<div class="flex items-center gap-2 whitespace-nowrap">
						<code class="whitespace-nowrap">$DATA_DIR/stacks/{renameConfirmFrom}/</code>
						<ArrowRight class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
						<code class="whitespace-nowrap">$DATA_DIR/stacks/{renameConfirmTo}/</code>
					</div>
					<div class="flex items-center gap-2 whitespace-nowrap">
						<code class="whitespace-nowrap">$DATA_DIR/git-repos/{renameConfirmFrom}/</code>
						<ArrowRight class="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
						<code class="whitespace-nowrap">$DATA_DIR/git-repos/{renameConfirmTo}/</code>
					</div>
				</div>
				{#if renameCountsUnknown}
					<p>
						{m.envmodal_rename_counts_unknown()}
						{#if renameAffectsContainers}
							<strong>{m.envmodal_rename_counts_unknown_redeploy()}</strong> {m.envmodal_rename_counts_unknown_redeploy_after()}
						{/if}
					</p>
				{:else if renameStackCount === 0 && renameGitStackCount === 0}
					<p>{m.envmodal_rename_no_stacks()}</p>
				{:else if renameAffectsContainers}
					<p>
						{#if renameStackCount > 0 && renameGitStackCount > 0}
							<strong>{m.envmodal_rename_stack_count({ count: renameStackCount })}</strong>
							{m.envmodal_rename_and()} <strong>{m.envmodal_rename_git_stack_count({ count: renameGitStackCount })}</strong>
							{m.envmodal_rename_redeploy_after({ count: renameStackCount + renameGitStackCount })}
						{:else if renameStackCount > 0}
							<strong>{m.envmodal_rename_stack_count({ count: renameStackCount })}</strong>
							{m.envmodal_rename_redeploy_after({ count: renameStackCount })}
						{:else}
							<strong>{m.envmodal_rename_git_stack_count({ count: renameGitStackCount })}</strong>
							{m.envmodal_rename_redeploy_after({ count: renameGitStackCount })}
						{/if}
					</p>
					<p>
						{m.envmodal_rename_running_containers()}
					</p>
				{:else}
					<p>
						{#if renameStackCount > 0 && renameGitStackCount > 0}
							<strong>{m.envmodal_rename_stack_count({ count: renameStackCount })}</strong>
							{m.envmodal_rename_and()} <strong>{m.envmodal_rename_git_stack_count({ count: renameGitStackCount })}</strong>
							{m.envmodal_rename_tracked_after({ count: renameStackCount + renameGitStackCount })}
						{:else if renameStackCount > 0}
							<strong>{m.envmodal_rename_stack_count({ count: renameStackCount })}</strong>
							{m.envmodal_rename_tracked_after({ count: renameStackCount })}
						{:else}
							<strong>{m.envmodal_rename_git_stack_count({ count: renameGitStackCount })}</strong>
							{m.envmodal_rename_tracked_after({ count: renameGitStackCount })}
						{/if}
					</p>
					<p>
						{m.envmodal_rename_hawser_containers()}
					</p>
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex justify-end gap-2 mt-4">
			<Button variant="outline" onclick={() => (showRenameConfirm = false)}>
				{m.environments_cancel()}
			</Button>
			<Button
				variant="default"
				onclick={async () => {
					showRenameConfirm = false;
					await commitEnvironmentUpdate();
				}}
			>
				{m.envmodal_rename_and_continue()}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
