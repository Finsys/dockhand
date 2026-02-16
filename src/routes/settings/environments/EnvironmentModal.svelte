<script lang="ts">
	import { toast } from 'svelte-sonner';
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
		XCircle
	} from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as Alert from '$lib/components/ui/alert';
	import * as Popover from '$lib/components/ui/popover';
	import IconPicker from '$lib/components/icon-picker.svelte';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import TimezoneSelector from '$lib/components/TimezoneSelector.svelte';
	import { whale } from '@lucide/lab';
	import ImagePullProgressPopover from '../../images/ImagePullProgressPopover.svelte';
	import { TogglePill, ToggleGroup } from '$lib/components/ui/toggle-pill';
	import { ShieldOff } from 'lucide-svelte';
	import { focusFirstInput } from '$lib/utils';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { authStore, canAccess } from '$lib/stores/auth';
	import { licenseStore } from '$lib/stores/license';
	import { formatDateTime, formatDate } from '$lib/stores/settings';
	import { getLabelColor, getLabelBgColor, parseLabels, MAX_LABELS } from '$lib/utils/label-colors';
	import EventTypesEditor from './EventTypesEditor.svelte';
	import UpdatesTab from './tabs/UpdatesTab.svelte';
	import ActivityTab from './tabs/ActivityTab.svelte';

	// Scanner options for ToggleGroup
	const scannerOptions = [
		{ value: 'grype', label: 'Grype' },
		{ value: 'trivy', label: 'Trivy' },
		{ value: 'both', label: 'Both', icon: ShieldCheck }
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
		tlsKey?: string;
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
				{ id: 'container_updated', label: 'Container updated', description: 'When a container image is updated' }
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
	let formTlsCa = $state('');
	let formTlsCert = $state('');
	let formTlsKey = $state('');
	let formTlsSkipVerify = $state(false);
	let formIcon = $state('globe');
	let formSocketPath = $state('/var/run/docker.sock');
	let formCollectActivity = $state(true);
	let formCollectMetrics = $state(true);
	let formHighlightChanges = $state(true);
	let formConnectionType = $state<ConnectionType>('socket');
	let formHawserToken = $state('');
	let formLabels = $state<string[]>([]);
	let newLabelInput = $state('');
	let showLabelDropdown = $state(false);
	let formPublicIp = $state('');
	let formTimezone = $state('UTC');
	let formError = $state('');
	let formErrors = $state<{ name?: string; host?: string }>({});
	let formSaving = $state(false);

	/**
	 * Clean a PEM certificate - remove leading/trailing whitespace from each line
	 * This handles copy/paste from formatted output with line numbers
	 */
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
		return value.replace(/^(?:\w+:\/\/)/, '').replace(/[:/].*$/, '');
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
	let scannerLoading = $state(true);
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
	let updateCheckEnabled = $state(false);
	let updateCheckCron = $state('0 4 * * *'); // Default: 4 AM daily
	let updateCheckAutoUpdate = $state(false);
	let updateCheckVulnerabilityCriteria = $state<VulnerabilityCriteria>('never');
	let updateCheckLoading = $state(false);

	// Image prune settings state
	let imagePruneEnabled = $state(false);
	let imagePruneCron = $state('0 3 * * 0'); // Default: 3 AM Sunday
	let imagePruneMode = $state<'dangling' | 'all'>('dangling');
	let imagePruneLastPruned = $state<string | undefined>(undefined);
	let imagePruneLastResult = $state<{ spaceReclaimed: number; imagesRemoved: number } | undefined>(undefined);
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
		const hostnamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
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
			formTlsKey = environment.tlsKey || '';
			formTlsSkipVerify = environment.tlsSkipVerify ?? false;
			formIcon = environment.icon || 'globe';
			formSocketPath = environment.socketPath || '/var/run/docker.sock';
			formCollectActivity = environment.collectActivity ?? true;
			formCollectMetrics = environment.collectMetrics ?? true;
			formHighlightChanges = environment.highlightChanges ?? true;
			formConnectionType = (environment.connectionType as ConnectionType) || 'socket';
			formHawserToken = environment.hawserToken || '';
			formLabels = parseLabels(environment.labels);
			newLabelInput = '';
			formPublicIp = environment.publicIp || '';
			modalTab = 'general';
			// Reset token state for this environment (important when switching between envs)
			hawserToken = null;
			generatedToken = null;
			pendingToken = null;
			// Load scanner settings, notifications, update check settings, image prune settings, and timezone
			loadScannerSettings(environment.id);
			loadEnvNotifications(environment.id);
			loadUpdateCheckSettings(environment.id);
			loadImagePruneSettings(environment.id);
			loadTimezone(environment.id);
			// Load Hawser token if edge mode
			if (formConnectionType === 'hawser-edge') {
				loadHawserToken(environment.id);
			}
		} else {
			formName = '';
			formHost = '';
			formPort = 2375;
			formProtocol = 'http';
			formTlsCa = '';
			formTlsCert = '';
			formTlsKey = '';
			formTlsSkipVerify = false;
			formIcon = 'globe';
			formSocketPath = '/var/run/docker.sock';
			formCollectActivity = true;
			formCollectMetrics = true;
			formHighlightChanges = true;
			formConnectionType = 'socket';
			formHawserToken = '';
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
			pendingToken = null;
			// Reset update check settings
			updateCheckEnabled = false;
			updateCheckCron = '0 4 * * *';
			updateCheckAutoUpdate = false;
			// Reset image prune settings
			imagePruneEnabled = false;
			imagePruneCron = '0 3 * * 0';
			imagePruneMode = 'dangling';
			imagePruneLastPruned = undefined;
			imagePruneLastResult = undefined;
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
					hawserToken: formHawserToken || pendingToken
				})
			});

			const result = await response.json();
			testResult = result;

			if (result.success) {
				if (result.isEdgeMode) {
					toast.info('Edge mode - connection will be tested when agent connects');
				} else {
					toast.success(`Connected! Docker ${result.info.serverVersion} - ${result.info.containers} containers`);
				}
			} else {
				toast.error(result.error || 'Connection failed');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Connection test failed';
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
				toast.error('No Docker sockets found');
			} else if (detectedSockets.length === 1) {
				// Auto-select if only one found
				formSocketPath = detectedSockets[0].path;
				toast.success(`Found ${detectedSockets[0].name}`);
			} else {
				// Show dropdown to select
				showSocketDropdown = true;
				toast.success(`Found ${detectedSockets.length} Docker sockets`);
			}
		} catch (error) {
			toast.error('Failed to detect sockets');
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
		// Validation based on connection type
		formErrors = {};
		let hasErrors = false;

		if (!formName.trim()) {
			formErrors.name = 'Name is required';
			hasErrors = true;
		}
		// Host is only required for direct and hawser-standard connection types
		if (formConnectionType === 'direct' || formConnectionType === 'hawser-standard') {
			if (!formHost.trim()) {
				formErrors.host = 'Host is required';
				hasErrors = true;
			} else {
				formHost = stripHostProtocol(formHost.trim());
				if (!isValidHost(formHost)) {
					formErrors.host = 'Enter an IP address or hostname only (no protocol or port)';
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
					icon: formIcon,
					socketPath: formConnectionType === 'socket' ? formSocketPath : undefined,
					collectActivity: formCollectActivity,
					collectMetrics: formCollectMetrics,
					highlightChanges: formHighlightChanges,
					labels: formLabels,
					connectionType: formConnectionType,
					hawserToken: formHawserToken || undefined,
					publicIp: formConnectionType !== 'hawser-edge' ? (stripHostProtocol(formPublicIp.trim()) || undefined) : undefined
				})
			});

			if (response.ok) {
				const newEnv = await response.json();
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
				// Save update check settings if enabled
				if (updateCheckEnabled && newEnv?.id) {
					await saveUpdateCheckSettings(newEnv.id);
				}
				// Save image prune settings if enabled
				if (imagePruneEnabled && newEnv?.id) {
					await saveImagePruneSettings(newEnv.id);
				}
				// Save timezone if not default
				if (newEnv?.id) {
					await saveTimezone(newEnv.id);
				}
				onSaved();
				onClose();
			} else {
				const data = await response.json();
				formError = data.error || 'Failed to create environment';
			}
		} catch (error) {
			formError = 'Failed to create environment';
		} finally {
			formSaving = false;
		}
	}

	async function updateEnvironment() {
		if (!environment) return;

		formErrors = {};
		let hasErrors = false;

		if (!formName.trim()) {
			formErrors.name = 'Name is required';
			hasErrors = true;
		}
		// Host is only required for direct and hawser-standard connection types
		if (formConnectionType === 'direct' || formConnectionType === 'hawser-standard') {
			if (!formHost.trim()) {
				formErrors.host = 'Host is required';
				hasErrors = true;
			} else {
				formHost = stripHostProtocol(formHost.trim());
				if (!isValidHost(formHost)) {
					formErrors.host = 'Enter an IP address or hostname only (no protocol or port)';
					hasErrors = true;
				}
			}
		}

		if (hasErrors) return;

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
					publicIp: formConnectionType !== 'hawser-edge' ? (stripHostProtocol(formPublicIp.trim()) || null) : null
				})
			});

			if (response.ok) {
				await saveScannerSettings(environment.id);
				await saveUpdateCheckSettings(environment.id);
				await saveImagePruneSettings(environment.id);
				await saveTimezone(environment.id);
				toast.success(`Updated environment: ${formName}`);
				onSaved();
				onClose();
			} else {
				const data = await response.json();
				formError = data.error || 'Failed to update environment';
			}
		} catch (error) {
			formError = 'Failed to update environment';
		} finally {
			formSaving = false;
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
			await fetch(`/api/environments/${envId}/timezone`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ timezone: formTimezone })
			});
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
				} else {
					// No settings found - use defaults
					updateCheckEnabled = false;
					updateCheckCron = '0 4 * * *';
					updateCheckAutoUpdate = false;
					updateCheckVulnerabilityCriteria = 'never';
				}
			}
		} catch (error) {
			console.error('Failed to load update check settings:', error);
		} finally {
			updateCheckLoading = false;
		}
	}

	async function saveUpdateCheckSettings(envId: number) {
		try {
			await fetch(`/api/environments/${envId}/update-check`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					enabled: updateCheckEnabled,
					cron: updateCheckCron,
					autoUpdate: updateCheckAutoUpdate,
					vulnerabilityCriteria: updateCheckVulnerabilityCriteria
				})
			});
		} catch (error) {
			console.error('Failed to save update check settings:', error);
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
			const response = await fetch(`/api/settings/scanner?checkUpdates=true${envParam}`);
			const data = await response.json();
			if (data.updates) {
				grypeUpdateStatus = data.updates.grype?.hasUpdate ? 'update-available' : 'up-to-date';
				setTimeout(() => { grypeUpdateStatus = 'idle'; }, 3000);
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
			const response = await fetch(`/api/settings/scanner?checkUpdates=true${envParam}`);
			const data = await response.json();
			if (data.updates) {
				trivyUpdateStatus = data.updates.trivy?.hasUpdate ? 'update-available' : 'up-to-date';
				setTimeout(() => { trivyUpdateStatus = 'idle'; }, 3000);
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
			const pullUrl = environment?.id ? `/api/images/pull?env=${environment.id}` : '/api/images/pull';
			const response = await fetch(pullUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: 'anchore/grype:latest' })
			});

			if (!response.ok) {
				throw new Error('Failed to pull Grype image');
			}

			// Read SSE stream to completion
			const reader = response.body?.getReader();
			if (reader) {
				const decoder = new TextDecoder();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value, { stream: true });
					if (text.includes('"status":"error"')) {
						throw new Error('Pull failed');
					}
				}
			}

			// Refresh scanner status after pull
			await loadScannerVersionsAsync(environment?.id);
			grypeUpdateStatus = 'up-to-date';
			setTimeout(() => { grypeUpdateStatus = 'idle'; }, 3000);
		} catch (error) {
			console.error('Failed to pull Grype image:', error);
		} finally {
			pullingGrype = false;
		}
	}

	async function pullTrivyImage() {
		if (pullingTrivy) return;
		pullingTrivy = true;
		trivyUpdateStatus = 'idle';
		try {
			const pullUrl = environment?.id ? `/api/images/pull?env=${environment.id}` : '/api/images/pull';
			const response = await fetch(pullUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ image: 'aquasec/trivy:latest' })
			});

			if (!response.ok) {
				throw new Error('Failed to pull Trivy image');
			}

			// Read SSE stream to completion
			const reader = response.body?.getReader();
			if (reader) {
				const decoder = new TextDecoder();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value, { stream: true });
					if (text.includes('"status":"error"')) {
						throw new Error('Pull failed');
					}
				}
			}

			// Refresh scanner status after pull
			await loadScannerVersionsAsync(environment?.id);
			trivyUpdateStatus = 'up-to-date';
			setTimeout(() => { trivyUpdateStatus = 'idle'; }, 3000);
		} catch (error) {
			console.error('Failed to pull Trivy image:', error);
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
				toast.success('Notification channel added');
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to add notification channel');
			}
		} catch (error) {
			console.error('Failed to add environment notification:', error);
			toast.error('Failed to add notification channel');
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
				toast.success('Token generated successfully');
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to generate token');
			}
		} catch (error) {
			console.error('Failed to generate Hawser token:', error);
			toast.error('Failed to generate token');
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
	<Dialog.Content class="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
		<Dialog.Header class="flex-shrink-0 border-b pb-4">
			<Dialog.Title class="flex items-center gap-2">
				{#if !isEditing}
					Add environment
				{:else}
					Edit environment
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
			<Tabs.List class="flex-shrink-0 mb-0 w-full grid grid-cols-5">
				<Tabs.Trigger value="general" class="flex items-center justify-center gap-1.5">
					<Globe class="w-3.5 h-3.5" />
					General
				</Tabs.Trigger>
				<Tabs.Trigger value="updates" class="flex items-center justify-center gap-1.5">
					<CircleFadingArrowUp class="w-3.5 h-3.5" />
					Updates
				</Tabs.Trigger>
				<Tabs.Trigger value="activity" class="flex items-center justify-center gap-1.5">
					<Activity class="w-3.5 h-3.5" />
					Activity
				</Tabs.Trigger>
				<Tabs.Trigger value="security" class="flex items-center justify-center gap-1.5">
					<ShieldCheck class="w-3.5 h-3.5" />
					Security
				</Tabs.Trigger>
				<Tabs.Trigger value="notifications" class="flex items-center justify-center gap-1.5">
					<Bell class="w-3.5 h-3.5" />
					Notifications
				</Tabs.Trigger>
			</Tabs.List>

			<div class="overflow-y-auto py-4 h-[520px]">
				<!-- General Tab (Connection Settings) -->
					<Tabs.Content value="general" class="space-y-4 mt-0 h-full">
						<!-- Name field -->
						<div class="space-y-2">
							<Label for="edit-env-name">Name</Label>
							<div class="flex gap-2">
								<IconPicker value={formIcon} onchange={(icon) => formIcon = icon} />
								<Input
									id="edit-env-name"
									bind:value={formName}
									placeholder="Production"
									class="flex-1 {formErrors.name ? 'border-destructive focus-visible:ring-destructive' : ''}"
									oninput={() => formErrors.name = undefined}
								/>
							</div>
							{#if formErrors.name}
								<p class="text-xs text-destructive">{formErrors.name}</p>
							{/if}
						</div>

						<!-- Labels section -->
						<div class="space-y-2">
							<div class="flex items-center gap-1.5">
								<Label>Labels</Label>
								<span class="text-xs text-muted-foreground">({formLabels.length}/{MAX_LABELS})</span>
							</div>
							{#if formLabels.length > 0}
								<div class="flex flex-wrap gap-1.5">
									{#each formLabels as label}
										<Badge
											variant="secondary"
											class="gap-1 pr-1 rounded-md"
											style="background-color: {getLabelBgColor(label)}; border-color: {getLabelColor(label)}; color: {getLabelColor(label)};"
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
											placeholder="Add label..."
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
													{@const colors = { color: getLabelColor(suggestion), bgColor: getLabelBgColor(suggestion) }}
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
								<p class="text-xs text-muted-foreground">Maximum labels reached</p>
							{/if}
						</div>

						<!-- Connection type selector -->
						<div class="space-y-2">
							<div class="flex items-center gap-1.5">
								<Label for="edit-env-connection-type">Connection type</Label>
								<Popover.Root>
									<Popover.Trigger>
										<button type="button" class="text-muted-foreground hover:text-foreground">
											<HelpCircle class="w-3.5 h-3.5" />
										</button>
									</Popover.Trigger>
									<Popover.Content class="w-80 text-sm z-[200]" side="right">
										<div class="space-y-3">
											<div class="flex items-start gap-2">
												<Unplug class="w-4 h-4 mt-0.5 text-cyan-500 shrink-0" />
												<div>
													<p class="font-medium">Unix socket</p>
													<p class="text-xs text-muted-foreground">Connect via Docker socket on the same machine. Default path: /var/run/docker.sock. Also works with Docker Desktop and OrbStack.</p>
												</div>
											</div>
											<div class="flex items-start gap-2">
												<Icon iconNode={whale} class="w-4 h-4 mt-0.5 text-blue-500 shrink-0" />
												<div>
													<p class="font-medium">Direct connection</p>
													<p class="text-xs text-muted-foreground">Connect directly to Docker Engine API. Requires Docker to expose its API on a TCP port (default 2375/2376). Best for LAN environments.</p>
												</div>
											</div>
											<div class="flex items-start gap-2">
												<Route class="w-4 h-4 mt-0.5 text-purple-500 shrink-0" />
												<div>
													<p class="font-medium">Hawser standard</p>
													<p class="text-xs text-muted-foreground">Hawser agent listens on a port and Dockhand connects to it. Good for LAN with static IPs.</p>
												</div>
											</div>
											<div class="flex items-start gap-2">
												<UndoDot class="w-4 h-4 mt-0.5 text-green-500 shrink-0" />
												<div>
													<p class="font-medium">Hawser edge</p>
													<p class="text-xs text-muted-foreground">Hawser agent initiates outbound WebSocket to Dockhand. No port forwarding needed. Perfect for VPS, NAT, or dynamic IPs.</p>
												</div>
											</div>
											<a href="https://github.com/Finsys/hawser" target="_blank" class="flex items-center gap-1 text-xs text-blue-500 hover:underline">
												<ExternalLink class="w-3 h-3" />
												Learn more about Hawser
											</a>
										</div>
									</Popover.Content>
								</Popover.Root>
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
											Unix socket
										{:else if formConnectionType === 'direct'}
											<Icon iconNode={whale} class="w-4 h-4 text-blue-500" />
											Direct connection
										{:else if formConnectionType === 'hawser-standard'}
											<Route class="w-4 h-4 text-purple-500" />
											Hawser agent (standard)
										{:else}
											<UndoDot class="w-4 h-4 text-green-500" />
											Hawser agent (edge)
										{/if}
									</span>
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="socket">
										<span class="flex items-center gap-2">
											<Unplug class="w-4 h-4 text-cyan-500" />
											Unix socket
										</span>
									</Select.Item>
									<Select.Item value="direct">
										<span class="flex items-center gap-2">
											<Icon iconNode={whale} class="w-4 h-4 text-blue-500" />
											Direct connection
										</span>
									</Select.Item>
									<Select.Item value="hawser-standard">
										<span class="flex items-center gap-2">
											<Route class="w-4 h-4 text-purple-500" />
											Hawser agent (standard)
										</span>
									</Select.Item>
									<Select.Item value="hawser-edge">
										<span class="flex items-center gap-2">
											<UndoDot class="w-4 h-4 text-green-500" />
											Hawser agent (edge)
										</span>
									</Select.Item>
								</Select.Content>
							</Select.Root>
							<!-- Short description with link -->
							<p class="text-xs text-muted-foreground">
								{#if formConnectionType === 'socket'}
									Connect via Unix socket on the same machine.
								{:else if formConnectionType === 'direct'}
									Connect directly to Docker Engine API on TCP port.
								{:else if formConnectionType === 'hawser-standard'}
									<a href="https://github.com/Finsys/hawser" target="_blank" class="text-blue-500 hover:underline">Hawser</a> agent listens, Dockhand connects.
								{:else}
									<a href="https://github.com/Finsys/hawser" target="_blank" class="text-blue-500 hover:underline">Hawser</a> agent connects out to Dockhand. No port forwarding needed.
								{/if}
							</p>
						</div>

						<!-- Socket connection settings -->
						{#if formConnectionType === 'socket'}
							<div class="space-y-2">
								<Label for="edit-env-socket-path">Socket path</Label>
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
											title="Auto-detect Docker socket"
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
									Click <Pipette class="w-3 h-3 inline" /> to auto-detect available Docker sockets
								</p>
							</div>
						{/if}

						<!-- Direct connection settings -->
						{#if formConnectionType === 'direct'}
							<div class="grid grid-cols-2 gap-4">
								<div class="space-y-2">
									<Label for="edit-env-host">Host</Label>
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
									<Label for="edit-env-port">Port</Label>
									<Input id="edit-env-port" type="number" bind:value={formPort} />
								</div>
							</div>
							<div class="space-y-2">
								<Label for="edit-env-protocol">Protocol</Label>
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
									<p class="text-xs text-muted-foreground">TLS certificates for mTLS authentication (RSA or ECDSA)</p>
									<div class="space-y-2">
										<Label for="edit-env-tls_ca">CA certificate</Label>
										<textarea
											id="edit-env-tls_ca"
											bind:value={formTlsCa}
											placeholder="-----BEGIN CERTIFICATE-----"
											class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										></textarea>
									</div>
									<div class="space-y-2">
										<Label for="edit-env-tls_cert">Client certificate</Label>
										<textarea
											id="edit-env-tls_cert"
											bind:value={formTlsCert}
											placeholder="-----BEGIN CERTIFICATE-----"
											class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										></textarea>
									</div>
									<div class="space-y-2">
										<Label for="edit-env-tls_key">Client key</Label>
										<textarea
											id="edit-env-tls_key"
											bind:value={formTlsKey}
											placeholder="-----BEGIN PRIVATE KEY-----"
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
									<Label for="edit-env-host">Agent host</Label>
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
									<Label for="edit-env-port">Agent port</Label>
									<Input id="edit-env-port" type="number" bind:value={formPort} placeholder="2376" />
								</div>
							</div>
							<div class="space-y-2">
								<Label for="edit-env-protocol">Protocol</Label>
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
									<Label for="edit-env-hawser-tls-ca">CA certificate (for self-signed)</Label>
									<textarea
										id="edit-env-hawser-tls-ca"
										bind:value={formTlsCa}
										placeholder="-----BEGIN CERTIFICATE-----"
										class="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono text-xs"
										disabled={formTlsSkipVerify}
									></textarea>
									<p class="text-xs text-muted-foreground">Paste the CA certificate if agent uses self-signed TLS (RSA or ECDSA).</p>
								</div>
								<div class="flex items-center justify-between">
									<div>
										<Label>Skip TLS verification</Label>
										<p class="text-xs text-muted-foreground">Disable certificate validation (insecure)</p>
									</div>
									<TogglePill bind:checked={formTlsSkipVerify} />
								</div>
							{/if}
							<div class="space-y-2">
								<Label for="edit-env-hawser-token">Agent token (optional)</Label>
								<Input id="edit-env-hawser-token" type="password" bind:value={formHawserToken} placeholder="Token for agent authentication" />
								<p class="text-xs text-muted-foreground">If the Hawser agent is configured with TOKEN, enter it here.</p>
							</div>
							<div class="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 flex items-start gap-2">
								<Info class="w-3 h-3 mt-0.5 shrink-0" />
								<span>Run Hawser agent on the target host: <code class="bg-muted px-1 rounded">hawser --port {formPort}</code></span>
							</div>
						{/if}

						<!-- Hawser edge mode settings -->
						{#if formConnectionType === 'hawser-edge'}
							<div class="space-y-4">
								<!-- Connection status (edit mode only) -->
								{#if isEditing && environment}
									<div class="flex items-center justify-between">
										<Label>Connection status</Label>
										{#if environment.hawserAgentId}
											<Badge variant="outline" class="bg-green-50 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700">
												<Wifi class="w-3 h-3 mr-1" />
												Connected
											</Badge>
										{:else}
											<Badge variant="outline" class="bg-slate-50 text-slate-500 border-slate-300 dark:bg-slate-900/30 dark:text-slate-400 dark:border-slate-700">
												<WifiOff class="w-3 h-3 mr-1" />
												Waiting for agent
											</Badge>
										{/if}
									</div>

									<!-- Agent info if connected -->
									{#if environment.hawserAgentId}
										<div class="text-xs bg-muted/30 rounded-md p-2 space-y-1">
											<p><span class="text-muted-foreground">Agent:</span> {environment.hawserAgentName || environment.hawserAgentId}</p>
											{#if environment.hawserVersion}
												<p><span class="text-muted-foreground">Version:</span> {environment.hawserVersion}</p>
											{/if}
											{#if environment.hawserLastSeen}
												<p><span class="text-muted-foreground">Last seen:</span> {formatDateTime(environment.hawserLastSeen, true)}</p>
											{/if}
										</div>
									{/if}
								{/if}

								<!-- Token section -->
								<div class="space-y-2">
									<div class="flex items-center justify-between">
										<Label>Connection token</Label>
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
												Regenerate
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
												Generate
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
												Generate connection token
											</Button>
											<p class="text-xs text-muted-foreground">
												Generate a token now. It will be saved when you add the environment.
											</p>
										{:else}
											<!-- Show pending token -->
											<div class="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded-md space-y-2">
												<p class="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1">
													<AlertTriangle class="w-3 h-3" />
													Copy this token now - you'll need it for the Hawser agent!
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
																<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
															</Tooltip.Root>
														{:else if copySuccess === 'ok'}
															<Check class="w-4 h-4 text-green-500" />
														{:else}
															<Copy class="w-4 h-4" />
														{/if}
													</Button>
												</div>
												<div class="text-xs text-amber-600 dark:text-amber-300 space-y-1">
													<span>Run on your host:</span>
													<div class="flex items-start gap-1.5">
														<code class="bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 rounded break-all flex-1">DOCKHAND_SERVER_URL={getConnectionUrl()} TOKEN={pendingToken} hawser</code>
														<button
															class="shrink-0 p-0.5 rounded hover:bg-amber-200 dark:hover:bg-amber-800 transition-colors"
															onclick={() => copyCommand(pendingToken!)}
															title="Copy command"
														>
															{#if copyCmdSuccess === 'error'}
																<Tooltip.Root open>
																	<Tooltip.Trigger>
																		<XCircle class="w-3 h-3 text-red-500" />
																	</Tooltip.Trigger>
																	<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
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
													Generate new token
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
													Save this token now - it won't be shown again!
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
																<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
															</Tooltip.Root>
														{:else if copySuccess === 'ok'}
															<Check class="w-4 h-4 text-green-500" />
														{:else}
															<Copy class="w-4 h-4" />
														{/if}
													</Button>
												</div>
												<div class="text-xs text-amber-600 dark:text-amber-300 space-y-1">
													<span>Run on your host:</span>
													<div class="flex items-start gap-1.5">
														<code class="bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 rounded break-all flex-1">DOCKHAND_SERVER_URL={getConnectionUrl()} TOKEN={generatedToken} hawser</code>
														<button
															class="shrink-0 p-0.5 rounded hover:bg-amber-200 dark:hover:bg-amber-800 transition-colors"
															onclick={() => copyCommand(generatedToken!)}
															title="Copy command"
														>
															{#if copyCmdSuccess === 'error'}
																<Tooltip.Root open>
																	<Tooltip.Trigger>
																		<XCircle class="w-3 h-3 text-red-500" />
																	</Tooltip.Trigger>
																	<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
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
														Last used: {formatDate(hawserToken.lastUsed)}
													</span>
												{/if}
											</div>
										{:else}
											<p class="text-xs text-muted-foreground text-center py-2">No token generated yet. Click Generate above.</p>
										{/if}
									{/if}
								</div>
							</div>
						{/if}

						<!-- Public IP field (for all types except hawser-edge) -->
						{#if formConnectionType !== 'hawser-edge'}
							<div class="space-y-2 pt-4 border-t">
								<div class="flex items-center gap-2">
									<Label for="edit-env-public-ip">Public IP</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="bottom" class="w-72">
											<p>IP address or hostname where container ports are accessible from your browser. For local Docker, use the server's LAN IP.</p>
										</Tooltip.Content>
									</Tooltip.Root>
								</div>
								<Input
									id="edit-env-public-ip"
									bind:value={formPublicIp}
									placeholder="e.g., 192.168.1.4"
									class="w-full"
								/>
								<p class="text-xs text-muted-foreground">
									Used for clickable port links on the containers page
								</p>
							</div>
						{/if}
					</Tabs.Content>

				<!-- Updates Tab -->
				<Tabs.Content value="updates" class="space-y-4 mt-0 h-full">
					<UpdatesTab
						updateCheckLoading={updateCheckLoading}
						bind:updateCheckEnabled={updateCheckEnabled}
						bind:updateCheckCron={updateCheckCron}
						bind:updateCheckAutoUpdate={updateCheckAutoUpdate}
						bind:updateCheckVulnerabilityCriteria={updateCheckVulnerabilityCriteria}
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
					/>
				</Tabs.Content>

				<!-- Security Tab -->
				<Tabs.Content value="security" class="space-y-4 mt-0 h-full">
					<div class="space-y-4">
						<div class="flex items-center gap-2 text-sm font-medium">
							<ShieldCheck class="w-4 h-4" />
							Vulnerability scanning
						</div>

						{#if !isEditing}
							<!-- Add mode - full security settings -->
							<div class="flex items-start gap-3">
								<div class="flex-1">
									<Label>Enable scanning</Label>
									<p class="text-xs text-muted-foreground">Scan images for known security vulnerabilities</p>
								</div>
								<TogglePill bind:checked={formEnableScanner} />
							</div>

							{#if formEnableScanner}
								<div class="flex items-start gap-3">
									<div class="flex-1">
										<Label>Scanner</Label>
										<p class="text-xs text-muted-foreground">Choose vulnerability scanner</p>
									</div>
									<ToggleGroup
										value={formScannerType}
										options={scannerOptions}
										onchange={(v) => { formScannerType = v as ScannerType; }}
									/>
								</div>

								<div class="text-xs text-muted-foreground bg-muted/50 rounded-md p-2 flex items-start gap-2">
									<Info class="w-3 h-3 mt-0.5 shrink-0" />
									<span>Scanner images will be pulled automatically on first scan. Vulnerability databases are cached in Docker volumes for faster subsequent scans.</span>
								</div>
							{/if}
						{:else if scannerLoading}
							<div class="flex items-center justify-center py-4">
								<RefreshCw class="w-5 h-5 animate-spin text-muted-foreground" />
							</div>
						{:else}
							<div class="flex items-start gap-3">
								<div class="flex-1">
									<Label>Enable scanning</Label>
									<p class="text-xs text-muted-foreground">Scan images for known security vulnerabilities</p>
								</div>
								<TogglePill bind:checked={scannerEnabled} />
							</div>

							{#if scannerEnabled}
								<div class="flex items-start gap-3">
									<div class="flex-1">
										<Label>Scanner</Label>
										<p class="text-xs text-muted-foreground">Choose vulnerability scanner</p>
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
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">Ready</Badge>
											{:else}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-amber-500/10 text-amber-600 border-amber-500/30">Not installed</Badge>
											{/if}
											{#if !loadingScannerVersions}
												{#if !scannerAvailability.grype}
													<ImagePullProgressPopover imageName="anchore/grype:latest" envId={environment?.id} onComplete={() => reloadScannerAvailability(environment?.id)}>
														<button class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
															<Download class="w-2.5 h-2.5 mr-0.5" />
															Pull
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
														Remove
													</button>
													{#if grypeUpdateStatus === 'up-to-date'}
														<span class="inline-flex items-center text-2xs px-1.5 py-0 h-4 text-green-600">
															<CheckCircle2 class="w-2.5 h-2.5 mr-0.5" />
															Latest
														</span>
													{:else if grypeUpdateStatus === 'update-available' || pullingGrype}
														<button
															class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 transition-colors disabled:opacity-50"
															onclick={() => pullGrypeImage()}
															disabled={pullingGrype}
														>
															{#if pullingGrype}
																<Loader2 class="w-2.5 h-2.5 mr-0.5 animate-spin" />
																Pulling
															{:else}
																<Download class="w-2.5 h-2.5 mr-0.5" />
																Update
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
																Checking
															{:else}
																<RefreshCw class="w-2.5 h-2.5 mr-0.5" />
																Check
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
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">Ready</Badge>
											{:else}
												<Badge variant="outline" class="text-2xs px-1 py-0 h-4 bg-amber-500/10 text-amber-600 border-amber-500/30">Not installed</Badge>
											{/if}
											{#if !loadingScannerVersions}
												{#if !scannerAvailability.trivy}
													<ImagePullProgressPopover imageName="aquasec/trivy:latest" envId={environment?.id} onComplete={() => reloadScannerAvailability(environment?.id)}>
														<button class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
															<Download class="w-2.5 h-2.5 mr-0.5" />
															Pull
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
														Remove
													</button>
													{#if trivyUpdateStatus === 'up-to-date'}
														<span class="inline-flex items-center text-2xs px-1.5 py-0 h-4 text-green-600">
															<CheckCircle2 class="w-2.5 h-2.5 mr-0.5" />
															Latest
														</span>
													{:else if trivyUpdateStatus === 'update-available' || pullingTrivy}
														<button
															class="inline-flex items-center text-2xs px-1.5 py-0 h-4 rounded-full border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 transition-colors disabled:opacity-50"
															onclick={() => pullTrivyImage()}
															disabled={pullingTrivy}
														>
															{#if pullingTrivy}
																<Loader2 class="w-2.5 h-2.5 mr-0.5 animate-spin" />
																Pulling
															{:else}
																<Download class="w-2.5 h-2.5 mr-0.5" />
																Update
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
																Checking
															{:else}
																<RefreshCw class="w-2.5 h-2.5 mr-0.5" />
																Check
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
											<span>Scanner images will be pulled automatically on first scan. Vulnerability databases are cached in Docker volumes for faster subsequent scans.</span>
										</div>
									{/if}
								</div>
							{/if}
						{/if}
					</div>
				</Tabs.Content>

				<!-- Notifications Tab -->
				<Tabs.Content value="notifications" class="mt-0 h-full flex flex-col">
					<div class="flex items-center gap-2 text-sm font-medium flex-shrink-0">
						<Bell class="w-4 h-4" />
						Notification channels
					</div>

					{#if !isEditing}
						<!-- Add mode - show available channels to select -->
						<p class="text-xs text-muted-foreground mt-2 flex-shrink-0">
							Select which notification channels should send alerts for events from this environment.
						</p>

						{#if notifications.length === 0}
							<div class="flex-1 flex flex-col items-center justify-center py-8 text-center">
								<Bell class="w-10 h-10 text-muted-foreground mb-3 opacity-50" />
								<p class="text-sm text-muted-foreground">No notification channels configured yet.</p>
								<p class="text-xs text-muted-foreground mt-1">Create notification channels in the Notifications settings tab first.</p>
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
												Channel disabled globally
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
													<span class="text-xs text-muted-foreground">Event types ({selectedNotif.eventTypes.length})</span>
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
							Configure which notification channels should send alerts for events from this environment.
							{#if environment && !environment.collectActivity}
								<span class="text-amber-500">Activity collection will be enabled automatically when you add a channel.</span>
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
													<span class="text-xs text-muted-foreground">({notif.eventTypes.length} events)</span>
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
														Channel disabled globally
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
									<p class="text-sm">No notification channels configured</p>
									<p class="text-xs mt-1">Add a channel below to receive alerts for this environment</p>
								</div>
							{/if}

							<!-- Add Channel - fixed at bottom -->
							{@const availableChannels = notifications.filter(n => !envNotifications.some(en => en.notificationId === n.id))}
							{#if availableChannels.length > 0}
								<div class="pt-3 border-t flex-shrink-0 mt-4">
									<Label class="text-xs text-muted-foreground mb-2 block">Add notification channel:</Label>
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
										<span>No notification channels have been created yet. <a href="/settings?tab=notifications" class="text-primary hover:underline" onclick={onClose}>Go to Settings → Notifications</a> to add channels first.</span>
									{:else}
										<span>No notification channels have been created yet. Contact your administrator to configure notification channels.</span>
									{/if}
								</div>
							{/if}
						{/if}
					{/if}
				</Tabs.Content>
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
						Testing...
					{:else if testResult?.success}
						<CheckCircle2 class="w-4 h-4 text-green-500" />
						Test connection
					{:else if testResult && !testResult.success}
						<AlertCircle class="w-4 h-4 text-red-500" />
						Test connection
					{:else}
						<Wifi class="w-4 h-4" />
						Test connection
					{/if}
				</Button>

				{#if !isEditing}
					<!-- Add mode -->
					<Button variant="outline" onclick={onClose}>
						Cancel
					</Button>
					<Button onclick={createEnvironment} disabled={formSaving}>
						{#if formSaving}
							<RefreshCw class="w-4 h-4 animate-spin" />
						{:else}
							<Plus class="w-4 h-4" />
						{/if}
						Add
					</Button>
				{:else}
					<!-- Edit mode -->
					<Button variant="outline" onclick={onClose}>
						Cancel
					</Button>
					<Button onclick={updateEnvironment} disabled={formSaving}>
						{#if formSaving}
							<RefreshCw class="w-4 h-4 animate-spin" />
						{:else}
							<Check class="w-4 h-4" />
						{/if}
						Save
					</Button>
				{/if}
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
