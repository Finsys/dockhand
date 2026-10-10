<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { TogglePill, ToggleSwitch } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import TimezoneSelector from '$lib/components/TimezoneSelector.svelte';
	import { Eye, Bell, Database, Calendar, ShieldCheck, FileText, AlertTriangle, HelpCircle, Globe, Activity, Clock, Info, Save, RotateCcw, LayoutDashboard, Tags, Archive, ChevronRight, ChevronDown, Compass, Layers } from 'lucide-svelte';
	import { STACK_LOG_OPERATIONS, type StackLogOperation } from '$lib/utils/stack-log-operations';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import { appSettings, type DateFormat, type DownloadFormat, type EventCollectionMode, type LabelFilterMode } from '$lib/stores/settings';
	import { canAccess, authStore } from '$lib/stores/auth';
	import { toast } from 'svelte-sonner';
	import ThemeSelector from '$lib/components/ThemeSelector.svelte';
	import LanguageSelector from '$lib/components/LanguageSelector.svelte';
	import NavigationSelector from '$lib/components/NavigationSelector.svelte';
	import AnimateIconsToggle from '$lib/components/AnimateIconsToggle.svelte';
	import IndentGuidesToggle from '$lib/components/IndentGuidesToggle.svelte';
	import EditorThemeSelector from '$lib/components/EditorThemeSelector.svelte';
	import ColoredActionsToggle from '$lib/components/ColoredActionsToggle.svelte';
	import SemverCheckConfig from '$lib/components/SemverCheckConfig.svelte';
	import {
		DEFAULT_GRYPE_IMAGE,
		DEFAULT_TRIVY_IMAGE,
		DEFAULT_GRYPE_ARGS,
		DEFAULT_TRIVY_ARGS,
		imageRepo
	} from '$lib/utils/scanner-images';
	import { onMount } from 'svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { m } from '$lib/paraglide/messages.js';
	import { splitAtName } from '$lib/i18n/split';

	// General settings state - these derive from the store
	let confirmDestructive = $derived($appSettings.confirmDestructive);
	let showStoppedContainers = $derived($appSettings.showStoppedContainers);
	let highlightUpdates = $derived($appSettings.highlightUpdates);
	let compactPorts = $derived($appSettings.compactPorts);
	let showExposedPorts = $derived($appSettings.showExposedPorts);
	let showGitCommitHash = $derived($appSettings.showGitCommitHash);
	let honorProxyLabels = $derived($appSettings.honorProxyLabels);
	let showImageChangelogLinks = $derived($appSettings.showImageChangelogLinks);
	let useSelfhstIcons = $derived($appSettings.useSelfhstIcons);
	let showWhatsNew = $derived($appSettings.showWhatsNew);
	let timeFormat = $derived($appSettings.timeFormat);
	let dateFormat = $derived($appSettings.dateFormat);
	let downloadFormat = $derived($appSettings.downloadFormat);
	let defaultGrypeArgs = $derived($appSettings.defaultGrypeArgs);
	let defaultTrivyArgs = $derived($appSettings.defaultTrivyArgs);
	let defaultGrypeImage = $derived($appSettings.defaultGrypeImage);
	let defaultTrivyImage = $derived($appSettings.defaultTrivyImage);
	let defaultScannerNetworkMode = $derived($appSettings.defaultScannerNetworkMode);
	let defaultScannerDns = $derived($appSettings.defaultScannerDns);
	let stackLogOperations = $derived($appSettings.stackLogOperations);
	// Display labels; the shared module keeps its English labels for the server and tests.
	const stackLogOperationLabels: Record<StackLogOperation, () => string> = {
		start: m.settings_general_stack_log_op_start,
		stop: m.settings_general_stack_log_op_stop,
		restart: m.settings_general_stack_log_op_restart,
		deploy: m.settings_general_stack_log_op_deploy,
		down: m.settings_general_stack_log_op_down
	};

	function toggleStackLogOperation(op: StackLogOperation, show: boolean) {
		const next = show
			? [...stackLogOperations, op]
			: stackLogOperations.filter((o) => o !== op);
		appSettings.setStackLogOperations(next);
	}
	let showAdvancedScannerSettings = $state(false);
	let defaultComposeTemplate = $derived($appSettings.defaultComposeTemplate);
	let labelFilterMode = $derived($appSettings.labelFilterMode);
	let composeTemplateWIP = $state('');
	let composeTemplateInitialized = false;

	$effect(() => {
		if (!composeTemplateInitialized && defaultComposeTemplate !== undefined) {
			composeTemplateWIP = defaultComposeTemplate;
			composeTemplateInitialized = true;
		}
	});

	const builtinComposeTemplate = `version: "3.8"

services:
  app:
    image: nginx:alpine
    ports:
      - "8080:80"
    environment:
      - APP_ENV=\${APP_ENV:-production}
    volumes:
      - ./html:/usr/share/nginx/html:ro
    restart: unless-stopped

# Add more services as needed
# networks:
#   default:
#     driver: bridge
`;

	function saveComposeTemplate() {
		appSettings.setDefaultComposeTemplate(composeTemplateWIP);
		toast.success(m.settings_general_toast_compose_template_updated());
	}

	function revertComposeTemplate() {
		composeTemplateWIP = builtinComposeTemplate;
		toast.info(m.settings_general_toast_template_reverted());
	}
	let scheduleRetentionDays = $derived($appSettings.scheduleRetentionDays);
	let eventRetentionDays = $derived($appSettings.eventRetentionDays);
	let scheduleCleanupCron = $derived($appSettings.scheduleCleanupCron);
	let eventCleanupCron = $derived($appSettings.eventCleanupCron);
	let scheduleCleanupEnabled = $derived($appSettings.scheduleCleanupEnabled);
	let eventCleanupEnabled = $derived($appSettings.eventCleanupEnabled);
	let scanRetentionCron = $derived($appSettings.scanRetentionCron);
	let scanRetentionEnabled = $derived($appSettings.scanRetentionEnabled);
	let scanRetentionKeep = $derived($appSettings.scanRetentionKeep);
	let scanRetentionGraceDays = $derived($appSettings.scanRetentionGraceDays);
	let scannerCleanupCron = $derived($appSettings.scannerCleanupCron);
	let scannerCleanupEnabled = $derived($appSettings.scannerCleanupEnabled);
	let deployLogReconcileCron = $derived($appSettings.deployLogReconcileCron);
	let deployLogReconcileEnabled = $derived($appSettings.deployLogReconcileEnabled);
	let logMaxLines = $derived($appSettings.logMaxLines);
	let formatLogTimestamps = $derived($appSettings.formatLogTimestamps);
	let defaultTimezone = $derived($appSettings.defaultTimezone);
	let eventCollectionMode = $derived($appSettings.eventCollectionMode);
	let eventPollInterval = $derived($appSettings.eventPollInterval);
	let metricsCollectionInterval = $derived($appSettings.metricsCollectionInterval);
	let defaultBackupImage = $derived($appSettings.defaultBackupImage);

	let clearingCache = $state(false);

	async function clearScannerCache() {
		clearingCache = true;
		try {
			const res = await fetch('/api/settings/scanner/cache', { method: 'DELETE' });
			const data = await res.json();
			if (res.ok && data.success) {
				const total = (data.removedVolumes?.length || 0) + (data.removedDirs?.length || 0);
				if (total > 0) {
					toast.success(m.settings_general_toast_scanner_cache_cleared({ count: total }));
				} else {
					toast.info(m.settings_general_toast_scanner_cache_empty());
				}
			} else {
				toast.error(data.error || m.settings_general_toast_scanner_cache_clear_failed());
			}
		} catch {
			toast.error(m.settings_general_toast_scanner_cache_clear_failed());
		} finally {
			clearingCache = false;
		}
	}

	const dateFormatOptions: { value: DateFormat; label: string; example: string }[] = [
		{ value: 'DD.MM.YYYY', label: 'DD.MM.YYYY', example: '31.12.2024' },
		{ value: 'DD/MM/YYYY', label: 'DD/MM/YYYY', example: '31/12/2024' },
		{ value: 'MM/DD/YYYY', label: 'MM/DD/YYYY', example: '12/31/2024' },
		{ value: 'YYYY-MM-DD', label: 'YYYY-MM-DD', example: '2024-12-31' }
	];

	const downloadFormatOptions: { value: DownloadFormat; label: string; description: string }[] = [
		{ value: 'tar', label: 'tar', description: m.settings_general_download_tar_description() },
		{ value: 'tar.gz', label: 'tar.gz', description: m.settings_general_download_targz_description() },
		{ value: 'raw', label: m.settings_general_download_no_archive(), description: m.settings_general_download_raw_description() }
	];

	const downloadFormatLabel: Record<DownloadFormat, string> = {
		tar: 'tar',
		'tar.gz': 'tar.gz',
		raw: m.settings_general_download_no_archive()
	};

	function handleScheduleRetentionChange(e: Event) {
		const value = Math.max(1, Math.min(365, parseInt((e.target as HTMLInputElement).value) || 30));
		appSettings.setScheduleRetentionDays(value);
		toast.success(m.settings_general_toast_schedule_retention_updated());
	}

	function handleEventRetentionChange(e: Event) {
		const value = Math.max(1, Math.min(365, parseInt((e.target as HTMLInputElement).value) || 30));
		appSettings.setEventRetentionDays(value);
		toast.success(m.settings_general_toast_event_retention_updated());
	}

	function handleScheduleCleanupCronChange(cron: string) {
		appSettings.setScheduleCleanupCron(cron);
		toast.success(m.settings_general_toast_schedule_cleanup_cron_updated());
	}

	function handleEventCleanupCronChange(cron: string) {
		appSettings.setEventCleanupCron(cron);
		toast.success(m.settings_general_toast_event_cleanup_cron_updated());
	}

	function handleScheduleCleanupEnabledChange() {
		const newState = !scheduleCleanupEnabled;
		appSettings.setScheduleCleanupEnabled(newState);
		toast.success(newState ? m.settings_general_toast_schedule_cleanup_enabled() : m.settings_general_toast_schedule_cleanup_disabled());
	}

	function handleEventCleanupEnabledChange() {
		const newState = !eventCleanupEnabled;
		appSettings.setEventCleanupEnabled(newState);
		toast.success(newState ? m.settings_general_toast_event_cleanup_enabled() : m.settings_general_toast_event_cleanup_disabled());
	}

	function handleScanRetentionEnabledChange() {
		const newState = !scanRetentionEnabled;
		appSettings.setScanRetentionEnabled(newState);
		toast.success(newState ? m.settings_general_toast_scan_retention_enabled() : m.settings_general_toast_scan_retention_disabled());
	}

	function handleScanRetentionCronChange(cron: string) {
		appSettings.setScanRetentionCron(cron);
		toast.success(m.settings_general_toast_scan_retention_schedule_updated());
	}

	function handleScanRetentionKeepChange(event: Event) {
		const value = parseInt((event.target as HTMLInputElement).value, 10);
		if (!Number.isFinite(value) || value < 1) return;
		appSettings.setScanRetentionKeep(value);
		toast.success(m.settings_general_toast_scan_retention_updated());
	}

	function handleScanRetentionGraceChange(event: Event) {
		const value = parseInt((event.target as HTMLInputElement).value, 10);
		if (!Number.isFinite(value) || value < 0) return;
		appSettings.setScanRetentionGraceDays(value);
		toast.success(m.settings_general_toast_scan_retention_updated());
	}

	function handleScannerCleanupCronChange(cron: string) {
		appSettings.setScannerCleanupCron(cron);
		toast.success(m.settings_general_toast_scanner_cleanup_cron_updated());
	}

	function handleScannerCleanupEnabledChange() {
		const newState = !scannerCleanupEnabled;
		appSettings.setScannerCleanupEnabled(newState);
		toast.success(newState ? m.settings_general_toast_scanner_cleanup_enabled() : m.settings_general_toast_scanner_cleanup_disabled());
	}

	function handleDeployLogReconcileCronChange(cron: string) {
		appSettings.setDeployLogReconcileCron(cron);
		toast.success(m.settings_general_toast_deploy_log_reconcile_cron_updated());
	}

	function handleDeployLogReconcileEnabledChange() {
		const newState = !deployLogReconcileEnabled;
		appSettings.setDeployLogReconcileEnabled(newState);
		toast.success(newState ? m.settings_general_toast_deploy_log_reconcile_enabled() : m.settings_general_toast_deploy_log_reconcile_disabled());
	}

	function handleGrypeImageBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value && value !== defaultGrypeImage) {
			appSettings.setDefaultGrypeImage(value);
			toast.success(m.settings_general_toast_scanner_image_updated({ scanner: 'Grype' }));
		}
	}

	function handleTrivyImageBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value && value !== defaultTrivyImage) {
			appSettings.setDefaultTrivyImage(value);
			toast.success(m.settings_general_toast_scanner_image_updated({ scanner: 'Trivy' }));
		}
	}

	// Newer scanner releases, asked for on demand: the check reaches the registry,
	// and the image stays pinned until someone applies the suggestion.
	let checkingScannerVersions = $state(false);
	let newerScanners = $state<{ grype: string | null; trivy: string | null }>({ grype: null, trivy: null });
	// Per scanner: the check ran and found nothing newer. Applying a suggestion
	// does NOT set this - that image has not been re-checked.
	let scannerUpToDate = $state<{ grype: boolean; trivy: boolean }>({ grype: false, trivy: false });

	async function checkScannerVersions() {
		checkingScannerVersions = true;
		try {
			const res = await fetch('/api/settings/scanner?checkNewerVersions=true');
			const data = await res.json();
			newerScanners = {
				grype: data.newerVersions?.grype?.latest ?? null,
				trivy: data.newerVersions?.trivy?.latest ?? null
			};
			scannerUpToDate = { grype: !newerScanners.grype, trivy: !newerScanners.trivy };
		} catch {
			toast.error(m.settings_general_toast_scanner_versions_check_failed());
		} finally {
			checkingScannerVersions = false;
		}
	}

	function applyScannerVersion(scanner: 'grype' | 'trivy') {
		const tag = scanner === 'grype' ? newerScanners.grype : newerScanners.trivy;
		if (!tag) return;
		const current = scanner === 'grype' ? defaultGrypeImage : defaultTrivyImage;
		const image = `${imageRepo(current)}:${tag}`;
		if (scanner === 'grype') {
			appSettings.setDefaultGrypeImage(image);
			newerScanners = { ...newerScanners, grype: null };
			scannerUpToDate = { ...scannerUpToDate, grype: false };
		} else {
			appSettings.setDefaultTrivyImage(image);
			newerScanners = { ...newerScanners, trivy: null };
			scannerUpToDate = { ...scannerUpToDate, trivy: false };
		}
		toast.success(m.settings_general_toast_scanner_image_set({ image }));
	}

	function handleGrypeArgsBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value !== defaultGrypeArgs) {
			appSettings.setDefaultGrypeArgs(value);
			toast.success(m.settings_general_toast_scanner_args_updated({ scanner: 'Grype' }));
		}
	}

	function handleTrivyArgsBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value !== defaultTrivyArgs) {
			appSettings.setDefaultTrivyArgs(value);
			toast.success(m.settings_general_toast_scanner_args_updated({ scanner: 'Trivy' }));
		}
	}

	function handleScannerNetworkModeChange(value: string) {
		const trimmed = (value ?? '').trim();
		if (trimmed !== defaultScannerNetworkMode) {
			appSettings.setDefaultScannerNetworkMode(trimmed);
			toast.success(trimmed ? m.settings_general_toast_scanner_network_mode_set({ mode: trimmed }) : m.settings_general_toast_scanner_network_mode_cleared());
		}
	}

	function handleScannerDnsBlur(e: Event) {
		const raw = (e.target as HTMLInputElement).value.trim();
		const cleaned = raw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const sameAsCurrent =
			cleaned.length === defaultScannerDns.length &&
			cleaned.every((v, i) => v === defaultScannerDns[i]);
		if (!sameAsCurrent) {
			appSettings.setDefaultScannerDns(cleaned);
			toast.success(cleaned.length ? m.settings_general_toast_scanner_dns_set({ dns: cleaned.join(', ') }) : m.settings_general_toast_scanner_dns_cleared());
		}
	}

	// Anything above 2K starts feeling laggy in browsers without virtualized rendering.
	const logMaxLinesOptions = [
		{ value: '500', label: m.settings_general_log_lines({ lines: (500).toLocaleString() }) },
		{ value: '1000', label: m.settings_general_log_lines({ lines: (1000).toLocaleString() }) },
		{ value: '2000', label: m.settings_general_log_lines({ lines: (2000).toLocaleString() }) }
	];

	function handleLogMaxLinesChange(value: string | undefined) {
		const n = parseInt(value ?? '');
		if (!Number.isFinite(n) || n <= 0) return;
		appSettings.setLogMaxLines(Math.min(2000, Math.max(100, n)));
		toast.success(m.settings_general_toast_log_buffer_updated());
	}

	function handleEventCollectionModeChange(value: string | undefined) {
		if (value === 'stream' || value === 'poll') {
			appSettings.setEventCollectionMode(value);
			toast.success(m.settings_general_toast_event_mode({ mode: value === 'stream' ? m.activity_mode_stream() : m.activity_mode_poll() }));
		}
	}

	function handleEventPollIntervalChange(selected: { value: number } | undefined) {
		if (selected?.value) {
			appSettings.setEventPollInterval(selected.value);
			toast.success(m.settings_general_toast_event_poll_interval({ seconds: selected.value / 1000 }));
		}
	}

	function handleMetricsIntervalChange(selected: { value: number } | undefined) {
		if (selected?.value) {
			appSettings.setMetricsCollectionInterval(selected.value);
			toast.success(m.settings_general_toast_metrics_interval({ seconds: selected.value / 1000 }));
		}
	}

	function handleBackupImageBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value && value !== defaultBackupImage) {
			appSettings.setDefaultBackupImage(value);
			toast.success(m.settings_general_toast_backup_image_updated());
		}
	}

	let releaseAgeHours = $state(0);
	let releaseAgeOverridden = $state(false);
	let releaseAgeSaving = $state(false);

	async function saveReleaseAge() {
		releaseAgeSaving = true;
		try {
			const res = await fetch('/api/settings/minimum-release-age', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hours: releaseAgeHours })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || m.settings_general_toast_min_age_save_failed());
			toast.success(m.settings_general_toast_min_age_updated());
		} catch (error) {
			toast.error(error instanceof Error ? error.message : m.settings_general_toast_min_age_save_failed());
		} finally { releaseAgeSaving = false; }
	}

	// Global newer-version-tag (semver) detection.
	let semverEnabled = $state(false);
	let semverMaxBump = $state<'patch' | 'minor' | 'major'>('major');
	let semverMatchFlavor = $state(true);
	let semverIncludePrerelease = $state(false);
	let semverRejectOlderImages = $state(true);
	let semverLoaded = $state(false);

	// The global theme defaults (what a new user starts with). With auth on the theme
	// toggles here edit these, not the admin's own profile. Rendering waits on
	// globalThemeLoaded: until the fetch fills these, a toggle handed globalValue=undefined
	// would fall back to the admin's personal store value and show it.
	let globalColoredActions = $state<boolean | undefined>(undefined);
	let globalAnimateIcons = $state<boolean | undefined>(undefined);
	let globalIndentGuides = $state<boolean | undefined>(undefined);
	let globalThemeLoaded = $state(false);

	onMount(async () => {
		try {
			const res = await fetch('/api/settings/minimum-release-age');
			if (res.ok) {
				const config = await res.json();
				releaseAgeHours = config.hours;
				releaseAgeOverridden = config.overridden;
			}
		} catch { /* keep default */ }
		try {
			const res = await fetch('/api/settings/semver');
			if (res.ok) {
				const c = await res.json();
				semverEnabled = c.enabled ?? false;
				semverMaxBump = c.maxBump ?? 'major';
				semverMatchFlavor = c.matchFlavor ?? true;
				semverIncludePrerelease = c.includePrerelease ?? false;
				semverRejectOlderImages = c.rejectOlderImages ?? true;
			}
			// A refusal means the values on screen are the built-in defaults, never the
			// configuration, so the save effect stays disarmed rather than writing a
			// guess over it. Any other failure still arms it: the controls are visible
			// and edits have to reach the server rather than vanish.
			semverLoaded = res.status !== 401 && res.status !== 403;
		} catch {
			// The request never landed, so nothing says this account may not save.
			semverLoaded = true;
		}

		try {
			const res = await fetch('/api/settings/general');
			if (res.ok) {
				const g = await res.json();
				globalColoredActions = !!g.coloredActionButtons;
				globalAnimateIcons = g.animateIcons ?? true;
				globalIndentGuides = !!g.editorIndentGuides;
			}
		} catch { /* toggles fall back to store when global value is unknown */ }
		globalThemeLoaded = true;
	});

	async function saveSemverConfig() {
		try {
			await fetch('/api/settings/semver', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					enabled: semverEnabled,
					maxBump: semverMaxBump,
					matchFlavor: semverMatchFlavor,
					includePrerelease: semverIncludePrerelease,
					rejectOlderImages: semverRejectOlderImages
				})
			});
		} catch {
			toast.error(m.settings_general_toast_semver_save_failed());
		}
	}

	// Persist on any change once the initial load is done (skip the load itself).
	$effect(() => {
		semverEnabled; semverMaxBump; semverMatchFlavor; semverIncludePrerelease;
		if (semverLoaded) saveSemverConfig();
	});
</script>

<div class="flex-1 min-h-0 overflow-y-auto">
	<div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
		<!-- Left column -->
		<div class="space-y-4">
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Eye class="w-4 h-4" />
						{m.profile_appearance_title()}
						<Tooltip.Provider delayDuration={100}>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<HelpCircle class="w-4 h-4 text-muted-foreground cursor-help" />
								</Tooltip.Trigger>
								<Tooltip.Portal>
									<Tooltip.Content side="right" sideOffset={8} class="!w-80">
										{#if $authStore.authEnabled}
											{m.settings_general_appearance_help_auth()}
										{:else}
											{m.settings_general_appearance_help_no_auth()}
										{/if}
									</Tooltip.Content>
								</Tooltip.Portal>
							</Tooltip.Root>
						</Tooltip.Provider>
					</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
						<!-- Left column -->
						<div class="space-y-4">
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_show_stopped()}</Label>
									<TogglePill
										checked={showStoppedContainers}
										onchange={(checked) => {
											appSettings.setShowStoppedContainers(checked);
											toast.success(checked ? m.settings_general_toast_stopped_shown() : m.settings_general_toast_stopped_hidden());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_show_stopped_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_highlight_updates()}</Label>
									<TogglePill
										checked={highlightUpdates}
										onchange={(checked) => {
											appSettings.setHighlightUpdates(checked);
											toast.success(checked ? m.settings_general_toast_highlight_updates_enabled() : m.settings_general_toast_highlight_updates_disabled());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_highlight_updates_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_changelog_links()}</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>{m.settings_general_changelog_links_help_before()} <code>org.opencontainers.image.source</code> {m.settings_general_changelog_links_help_after_label()} <code>ghcr.io</code> {m.settings_general_changelog_links_help_after_registry()} <code>dockhand.changelog.url</code> {m.settings_general_changelog_links_help_after_override()}</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={showImageChangelogLinks}
										onchange={(checked) => {
											appSettings.setShowImageChangelogLinks(checked);
											toast.success(checked ? m.settings_general_toast_changelog_links_shown() : m.settings_general_toast_changelog_links_hidden());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_changelog_links_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_selfhst_icons()}</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>{splitAtName(m.settings_general_selfhst_icons_help)[0]}<a href="https://selfh.st" target="_blank" rel="noopener" class="underline">selfh.st</a>{splitAtName(m.settings_general_selfhst_icons_help)[1]}</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={useSelfhstIcons}
										onchange={(checked) => {
											appSettings.setUseSelfhstIcons(checked);
											toast.success(checked ? m.settings_general_toast_selfhst_enabled() : m.settings_general_toast_selfhst_disabled());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_selfhst_icons_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_whats_new()}</Label>
									<TogglePill
										checked={showWhatsNew}
										onchange={(checked) => {
											appSettings.setShowWhatsNew(checked);
											toast.success(checked ? m.settings_general_toast_whats_new_enabled() : m.settings_general_toast_whats_new_disabled());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_whats_new_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_compact_ports()}</Label>
									<TogglePill
										checked={compactPorts}
										onchange={(checked) => {
											appSettings.setCompactPorts(checked);
											toast.success(checked ? m.settings_general_toast_compact_ports_enabled() : m.settings_general_toast_all_ports_shown());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_compact_ports_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_exposed_ports()}</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>{m.settings_general_exposed_ports_help()}</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={showExposedPorts}
										onchange={(checked) => {
											appSettings.setShowExposedPorts(checked);
											toast.success(checked ? m.settings_general_toast_exposed_ports_shown() : m.settings_general_toast_exposed_ports_hidden());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_exposed_ports_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_git_commit_hash()}</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>{m.settings_general_git_commit_hash_help()}</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={showGitCommitHash}
										onchange={(checked) => {
											appSettings.setShowGitCommitHash(checked);
											toast.success(checked ? m.settings_general_toast_git_commit_hash_shown() : m.settings_general_toast_git_commit_hash_hidden());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_git_commit_hash_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_proxy_labels()}</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>{m.settings_general_proxy_labels_help_before()} <code>traefik.http.routers.&lt;name&gt;.rule</code>, <code>pangolin.public-resources.&lt;name&gt;.full-domain</code>, <code>pangolin.private-resources.&lt;name&gt;.full-domain</code>, {m.settings_general_proxy_labels_help_caddy()} <code>caddy</code>/<code>caddy_&lt;n&gt;</code> {m.settings_general_proxy_labels_help_after_caddy()} <code>dockhand.url</code> {m.settings_general_proxy_labels_help_after_url()}</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={honorProxyLabels}
										onchange={(checked) => {
											appSettings.setHonorProxyLabels(checked);
											toast.success(checked ? m.settings_general_toast_proxy_labels_honored() : m.settings_general_toast_proxy_labels_ignored());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_proxy_labels_hint()}</p>
							</div>
						</div>
						<!-- Right column: Theme settings (always shown, with hint when auth enabled) -->
						<div class="space-y-4">
							<ThemeSelector />
							<!-- The language lives in this browser, so there is no global default to
							     edit here and no per-account value either. With auth on, the profile
							     page is where personal choices live, and this one goes with them. -->
							{#if !$authStore.authEnabled}
								<LanguageSelector />
							{/if}
							<!-- With auth on the toggles edit the GLOBAL defaults, so they wait for
							     those to load; binding globalValue=undefined first would show the
							     admin's own profile value. With auth off the store IS the global
							     value, so they render immediately. -->
							{#if !$authStore.authEnabled || globalThemeLoaded}
								<ColoredActionsToggle globalValue={$authStore.authEnabled ? globalColoredActions : undefined} />
								<AnimateIconsToggle globalValue={$authStore.authEnabled ? globalAnimateIcons : undefined} />
								<IndentGuidesToggle globalValue={$authStore.authEnabled ? globalIndentGuides : undefined} />
							{/if}
							{#if $authStore.authEnabled}
								<div class="text-xs text-muted-foreground flex items-start gap-1.5 mt-2 p-2 bg-muted/50 rounded-md">
									<HelpCircle class="w-3.5 h-3.5 shrink-0 mt-0.5" />
									<div>
										<p>{m.settings_general_theme_defaults_before()} <strong>{m.settings_general_theme_defaults_strong()}</strong> {m.settings_general_theme_defaults_middle()} <em>{m.settings_general_theme_defaults_you()}</em> {m.settings_general_theme_defaults_after()} <a href="/profile" class="text-primary hover:underline">{m.settings_general_theme_defaults_link()}</a>.</p>
									</div>
								</div>
							{/if}
						</div>
					</div>
				<!-- Time + date format span the full card width, two columns, so they get
				     room instead of crowding inside the narrow settings column. -->
				<div class="mt-4 border-t pt-4">
					<div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
						<div class="space-y-1">
							<div class="flex items-center gap-3">
								<Label>{m.settings_general_time_format()}</Label>
								<ToggleSwitch
									value={timeFormat}
									leftValue="24h"
									rightValue="12h"
									onchange={(newFormat) => {
										appSettings.setTimeFormat(newFormat as '12h' | '24h');
										toast.success(newFormat === '12h' ? m.settings_general_toast_time_format_12h() : m.settings_general_toast_time_format_24h());
									}}
									disabled={!$canAccess('settings', 'edit')}
								/>
							</div>
							<p class="text-xs text-muted-foreground">{m.settings_general_time_format_hint()}</p>
						</div>
						<div class="space-y-1">
							<div class="flex items-center gap-3">
								<Label>{m.settings_general_date_format()}</Label>
								<Select.Root
									type="single"
									value={dateFormat}
									onValueChange={(value) => {
										if (value) {
											appSettings.setDateFormat(value as DateFormat);
											toast.success(m.settings_general_toast_date_format({ format: value }));
										}
									}}
									disabled={!$canAccess('settings', 'edit')}
								>
									<Select.Trigger class="w-[180px]">
										<Calendar class="w-4 h-4 mr-2" />
										<span>{dateFormat}</span>
									</Select.Trigger>
									<Select.Content>
										{#each dateFormatOptions as option}
											<Select.Item value={option.value}>
												<div class="flex items-center justify-between w-full gap-4">
													<span>{option.label}</span>
													<span class="text-xs text-muted-foreground">{option.example}</span>
												</div>
											</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
							<p class="text-xs text-muted-foreground">{m.settings_general_date_format_hint()}</p>
						</div>
					</div>
				</div>
				<!-- Editor theme spans the full card width so the live preview isn't cramped. -->
				{#if !$authStore.authEnabled || globalThemeLoaded}
					<div class="mt-4 border-t pt-4">
						<EditorThemeSelector />
					</div>
				{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Compass class="w-4 h-4" />
						{m.profile_navigation_title()}
					</Card.Title>
				</Card.Header>
				<Card.Content>
					<NavigationSelector />
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Globe class="w-4 h-4" />
						{m.settings_general_scheduling()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-2">
						<Label>{m.settings_general_default_timezone()}</Label>
						<TimezoneSelector
							value={defaultTimezone}
							onchange={(value) => {
								appSettings.setDefaultTimezone(value);
								toast.success(m.settings_general_toast_default_timezone({ timezone: value }));
							}}
							class="w-[320px]"
						/>
						<p class="text-xs text-muted-foreground">{m.settings_general_default_timezone_hint()}</p>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Bell class="w-4 h-4" />
						{m.settings_general_confirmations()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-1">
						<div class="flex items-center gap-3">
							<Label>{m.settings_general_confirm_destructive()}</Label>
							<TogglePill
								checked={confirmDestructive}
								onchange={(checked) => {
									appSettings.setConfirmDestructive(checked);
									toast.success(checked ? m.settings_general_toast_confirmations_enabled() : m.settings_general_toast_confirmations_disabled());
								}}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">{m.settings_general_confirm_destructive_hint()}</p>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<FileText class="w-4 h-4" />
						{m.settings_general_logs_files()}
					</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
						<div class="space-y-4">
							<div class="space-y-2">
								<Label for="log-max-lines">{m.settings_general_log_buffer_size()}</Label>
								<Select.Root
									type="single"
									value={String(logMaxLines)}
									onValueChange={handleLogMaxLinesChange}
									disabled={!$canAccess('settings', 'edit')}
								>
									<Select.Trigger id="log-max-lines" class="w-48">
										{m.settings_general_log_lines({ lines: logMaxLines.toLocaleString() })}
									</Select.Trigger>
									<Select.Content>
										{#each logMaxLinesOptions as opt}
											<Select.Item value={opt.value}>{opt.label}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
								<p class="text-xs text-muted-foreground">{m.settings_general_log_buffer_size_hint()}</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_download_format()}</Label>
									<Select.Root
										type="single"
										value={downloadFormat}
										onValueChange={(value) => {
											if (value) {
												appSettings.setDownloadFormat(value as DownloadFormat);
												toast.success(m.settings_general_toast_download_format({ format: downloadFormatLabel[value as DownloadFormat] }));
											}
										}}
										disabled={!$canAccess('settings', 'edit')}
									>
										<Select.Trigger class="w-[180px]">
											<FileText class="w-4 h-4 mr-2" />
											<span>{downloadFormatLabel[downloadFormat]}</span>
										</Select.Trigger>
										<Select.Content>
											{#each downloadFormatOptions as option}
												<Select.Item value={option.value}>
													<div class="flex items-center justify-between w-full gap-4">
														<span>{option.label}</span>
														<span class="text-xs text-muted-foreground">{option.description}</span>
													</div>
												</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_download_format_hint()}</p>
							</div>
						</div>
						<div class="space-y-4">
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>{m.settings_general_format_log_timestamps()}</Label>
									<TogglePill
										checked={formatLogTimestamps}
										onchange={(checked) => {
											appSettings.setFormatLogTimestamps(checked);
											toast.success(checked ? m.settings_general_toast_log_timestamps_enabled() : m.settings_general_toast_log_timestamps_disabled());
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">{m.settings_general_format_log_timestamps_hint()}</p>
								<div class="flex items-start gap-1.5 mt-1">
									<Info class="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
									<p class="text-xs text-muted-foreground">{splitAtName(m.settings_general_format_log_timestamps_info)[0]}<code class="bg-muted px-1 rounded">2026-01-12T07:47:44Z</code>{splitAtName(m.settings_general_format_log_timestamps_info)[1]}</p>
								</div>
							</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Layers class="w-4 h-4" />
						{m.settings_general_stack_operation_logs()}
					</Card.Title>
					<p class="text-xs text-muted-foreground">{m.settings_general_stack_operation_logs_hint()}</p>
				</Card.Header>
				<Card.Content>
					<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
						{#each STACK_LOG_OPERATIONS as op}
							<div class="flex items-center gap-3">
								<TogglePill
									checked={stackLogOperations.includes(op.key)}
									onchange={(checked) => toggleStackLogOperation(op.key, checked)}
									disabled={!$canAccess('settings', 'edit')}
								/>
								<Label>{stackLogOperationLabels[op.key]()}</Label>
							</div>
						{/each}
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<FileText class="w-4 h-4" />
						{m.settings_general_compose_template()}
					</Card.Title>
					<p class="text-xs text-muted-foreground">{m.settings_general_compose_template_hint()}</p>
				</Card.Header>
				<Card.Content class="space-y-3">
					<div class="h-64">
						<CodeEditor
							value={composeTemplateWIP}
							onchange={(v) => { composeTemplateWIP = v; }}
							language="yaml"
							readonly={!$canAccess('settings', 'edit')}
							class="h-full rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700"
						/>
					</div>
					{#if $canAccess('settings', 'edit')}
						<div class="flex gap-2">
							<Button size="sm" variant="outline" onclick={saveComposeTemplate}>
								<Save class="w-3.5 h-3.5" />
								{m.settings_general_save_template()}
							</Button>
							<Button size="sm" variant="ghost" onclick={revertComposeTemplate}>
								<RotateCcw class="w-3.5 h-3.5" />
								{m.settings_general_revert_to_default()}
							</Button>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

		</div>

		<!-- Right column -->
		<div class="space-y-4">
			<!-- Held to settings:view: these describe how this installation is built
			     and run, and showing the built-in defaults to somebody who may not read
			     them would present a guess as the configuration. -->
			{#if $canAccess('settings', 'view')}
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<ShieldCheck class="w-4 h-4" />
						{m.settings_general_vulnerability_scanners()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-2">
						<Label for="grype-image">{m.settings_general_scanner_image({ scanner: 'Grype' })}</Label>
						<Input
							id="grype-image"
							value={defaultGrypeImage}
							onblur={handleGrypeImageBlur}
							disabled={!$canAccess('settings', 'edit')}
							placeholder={DEFAULT_GRYPE_IMAGE}
						/>
						<div class="flex items-center gap-2 flex-wrap">
							<p class="text-xs text-muted-foreground">{m.settings_general_scanner_image_hint({ scanner: 'Grype' })}</p>
							{#if newerScanners.grype}
								<button
									type="button"
									class="inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors"
									onclick={() => applyScannerVersion('grype')}
									disabled={!$canAccess('settings', 'edit')}
								>
									{m.settings_general_scanner_use_version({ version: newerScanners.grype })}
								</button>
							{:else if scannerUpToDate.grype}
								<span class="text-2xs text-muted-foreground">{m.settings_general_scanner_up_to_date()}</span>
							{/if}
						</div>
					</div>
					<div class="space-y-2">
						<Label for="trivy-image">{m.settings_general_scanner_image({ scanner: 'Trivy' })}</Label>
						<Input
							id="trivy-image"
							value={defaultTrivyImage}
							onblur={handleTrivyImageBlur}
							disabled={!$canAccess('settings', 'edit')}
							placeholder={DEFAULT_TRIVY_IMAGE}
						/>
						<div class="flex items-center gap-2 flex-wrap">
							<p class="text-xs text-muted-foreground">{m.settings_general_scanner_image_hint({ scanner: 'Trivy' })}</p>
							{#if newerScanners.trivy}
								<button
									type="button"
									class="inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors"
									onclick={() => applyScannerVersion('trivy')}
									disabled={!$canAccess('settings', 'edit')}
								>
									{m.settings_general_scanner_use_version({ version: newerScanners.trivy })}
								</button>
							{:else if scannerUpToDate.trivy}
								<span class="text-2xs text-muted-foreground">{m.settings_general_scanner_up_to_date()}</span>
							{/if}
						</div>
						<div class="pt-1">
							<Button variant="outline" size="sm" onclick={checkScannerVersions} disabled={checkingScannerVersions}>
								{checkingScannerVersions ? m.settings_general_scanner_checking() : m.settings_general_scanner_check_versions()}
							</Button>
						</div>
					</div>
					<div class="space-y-2">
						<Label for="grype-args">{m.settings_general_scanner_default_args({ scanner: 'Grype' })}</Label>
						<Input
							id="grype-args"
							value={defaultGrypeArgs}
							onblur={handleGrypeArgsBlur}
							disabled={!$canAccess('settings', 'edit')}
							placeholder={DEFAULT_GRYPE_ARGS}
						/>
						<p class="text-xs text-muted-foreground">{splitAtName(m.settings_general_scanner_args_hint)[0]}<code class="bg-muted px-1 rounded">{'{image}'}</code>{splitAtName(m.settings_general_scanner_args_hint)[1]}</p>
					</div>
					<div class="space-y-2">
						<Label for="trivy-args">{m.settings_general_scanner_default_args({ scanner: 'Trivy' })}</Label>
						<Input
							id="trivy-args"
							value={defaultTrivyArgs}
							onblur={handleTrivyArgsBlur}
							disabled={!$canAccess('settings', 'edit')}
							placeholder={DEFAULT_TRIVY_ARGS}
						/>
						<p class="text-xs text-muted-foreground">{splitAtName(m.settings_general_scanner_args_hint)[0]}<code class="bg-muted px-1 rounded">{'{image}'}</code>{splitAtName(m.settings_general_scanner_args_hint)[1]}</p>
					</div>
					<div class="pt-2">
						<button
							type="button"
							class="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 select-none"
							onclick={() => (showAdvancedScannerSettings = !showAdvancedScannerSettings)}
						>
							{#if showAdvancedScannerSettings}
								<ChevronDown class="w-3.5 h-3.5" />
							{:else}
								<ChevronRight class="w-3.5 h-3.5" />
							{/if}
							{m.settings_general_advanced_settings()}
						</button>
					</div>
					{#if showAdvancedScannerSettings}
						<div class="space-y-2">
							<Label for="scanner-network-mode">{m.containers_inspect_network_mode()}</Label>
							<Select.Root
								type="single"
								value={defaultScannerNetworkMode}
								onValueChange={handleScannerNetworkModeChange}
							>
								<Select.Trigger id="scanner-network-mode" class="w-full" disabled={!$canAccess('settings', 'edit')}>
									<span>{defaultScannerNetworkMode || m.settings_general_scanner_network_default()}</span>
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="">{m.settings_general_scanner_network_default()}</Select.Item>
									<Select.Item value="host">host</Select.Item>
									<Select.Item value="bridge">bridge</Select.Item>
									<Select.Item value="none">none</Select.Item>
								</Select.Content>
							</Select.Root>
							<p class="text-xs text-muted-foreground">{splitAtName(m.settings_general_scanner_network_mode_hint)[0]}<code class="bg-muted px-1 rounded">host</code>{splitAtName(m.settings_general_scanner_network_mode_hint)[1]}</p>
						</div>
						<div class="space-y-2">
							<Label for="scanner-dns">{m.containers_settings_dns_servers()}</Label>
							<Input
								id="scanner-dns"
								value={defaultScannerDns.join(', ')}
								onblur={handleScannerDnsBlur}
								disabled={!$canAccess('settings', 'edit')}
							/>
							<p class="text-xs text-muted-foreground">{m.settings_general_scanner_dns_hint()}</p>
						</div>
					{/if}
					<div class="pt-2 border-t">
						<div class="flex items-center justify-between">
							<div>
								<p class="text-sm font-medium">{m.settings_general_scanner_cache()}</p>
								<p class="text-xs text-muted-foreground">{m.settings_general_scanner_cache_hint()}</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={clearingCache || !$canAccess('settings', 'edit')}
								onclick={clearScannerCache}
							>
								{#if clearingCache}
									{m.settings_general_clearing()}
								{:else}
									{m.settings_general_clear_cache()}
								{/if}
							</Button>
						</div>
					</div>
				</Card.Content>
			</Card.Root>
			{/if}

			<!-- Held to settings:view with the rest: it decides how every update check
			     compares versions, and the defaults shown to somebody who may not read
			     it would be saved over the real configuration on the first change. -->
			{#if $canAccess('settings', 'view')}
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Clock class="w-4 h-4" />
						{m.settings_envs_min_age_title()}
						<Tooltip.Provider delayDuration={100}>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<HelpCircle class="w-4 h-4 text-muted-foreground cursor-help" />
								</Tooltip.Trigger>
								<Tooltip.Portal>
									<Tooltip.Content side="right" sideOffset={8} class="!w-96 space-y-2">
										<p>{m.settings_envs_min_age_help_source()}</p>
										<p>{m.settings_general_min_age_help_override()}</p>
										<p>{m.settings_envs_min_age_help_restart()}</p>
									</Tooltip.Content>
								</Tooltip.Portal>
							</Tooltip.Root>
						</Tooltip.Provider>
					</Card.Title>
					<Card.Description>
						{m.settings_envs_min_age_description()}
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex items-end gap-3">
					<div class="space-y-2 flex-1">
						<Label for="minimum-release-age">{m.settings_general_min_age_hours()}</Label>
						<Input id="minimum-release-age" type="number" min="0" max="720" step="1" bind:value={releaseAgeHours} disabled={releaseAgeOverridden || !$canAccess('settings', 'edit')} />
					</div>
					<Button onclick={saveReleaseAge} disabled={releaseAgeSaving || releaseAgeOverridden || !$canAccess('settings', 'edit')}>{m.settings_general_save()}</Button>
				</Card.Content>
				{#if releaseAgeOverridden}
					<p class="px-6 pb-4 text-xs text-muted-foreground">{m.settings_general_min_age_set_by_env()}</p>
				{/if}
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Tags class="w-4 h-4" />
						{m.settings_general_newer_version_tags()}
					</Card.Title>
					<Card.Description>
						{m.settings_general_newer_version_tags_description()}
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<SemverCheckConfig
						bind:enabled={semverEnabled}
						bind:maxBump={semverMaxBump}
						bind:matchFlavor={semverMatchFlavor}
						bind:includePrerelease={semverIncludePrerelease}
						bind:rejectOlderImages={semverRejectOlderImages}
					/>
				</Card.Content>
			</Card.Root>
			{/if}

			<!-- Held to settings:view: these describe how this installation is built
			     and run, and showing the built-in defaults to somebody who may not read
			     them would present a guess as the configuration. -->
			{#if $canAccess('settings', 'view')}
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Database class="w-4 h-4" />
						{m.schedules_type_system_jobs()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-3">
						<div>
							<div class="flex items-center gap-2">
								<Label>{m.settings_general_event_collection_mode()}</Label>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
									</Tooltip.Trigger>
									<Tooltip.Content class="w-80">
										<p class="text-xs">
											<strong>{m.activity_mode_stream()}:</strong> {m.settings_general_event_mode_stream_hint()}<br />
											<strong>{m.activity_mode_poll()}:</strong> {m.settings_general_event_mode_poll_hint()}
										</p>
									</Tooltip.Content>
								</Tooltip.Root>
							</div>
							<div class="flex items-center gap-4 mt-2">
								<label class="flex items-center gap-2 cursor-pointer">
									<input
										type="radio"
										name="eventCollectionMode"
										value="stream"
										checked={(eventCollectionMode || 'stream') === 'stream'}
										onchange={() => handleEventCollectionModeChange('stream')}
										disabled={!$canAccess('settings', 'edit')}
										class="accent-primary w-4 h-4"
									/>
									<Activity class="w-3.5 h-3.5" />
									<span class="text-sm">{m.activity_mode_stream()}</span>
								</label>
								<label class="flex items-center gap-2 cursor-pointer">
									<input
										type="radio"
										name="eventCollectionMode"
										value="poll"
										checked={(eventCollectionMode || 'stream') === 'poll'}
										onchange={() => handleEventCollectionModeChange('poll')}
										disabled={!$canAccess('settings', 'edit')}
										class="accent-primary w-4 h-4"
									/>
									<Clock class="w-3.5 h-3.5" />
									<span class="text-sm">{m.activity_mode_poll()}</span>
								</label>

								<span class="text-xs text-muted-foreground {(eventCollectionMode || 'stream') === 'poll' ? '' : 'invisible'}">{m.settings_general_poll_every()}</span>
								<Select.Root
									type="single"
									value={String(eventPollInterval || 60000)}
									onValueChange={(v) => v && handleEventPollIntervalChange({ value: parseInt(v) })}
									disabled={!$canAccess('settings', 'edit') || (eventCollectionMode || 'stream') !== 'poll'}
								>
									<Select.Trigger class="w-24 h-8 {(eventCollectionMode || 'stream') === 'poll' ? '' : 'invisible'}">
										{(eventPollInterval || 60000) === 30000 ? '30s' : (eventPollInterval || 60000) === 60000 ? '60s' : (eventPollInterval || 60000) === 120000 ? '120s' : '300s'}
									</Select.Trigger>
									<Select.Content>
										<Select.Item value="30000">30s</Select.Item>
										<Select.Item value="60000">60s</Select.Item>
										<Select.Item value="120000">120s</Select.Item>
										<Select.Item value="300000">300s</Select.Item>
									</Select.Content>
								</Select.Root>
							</div>
						</div>
					</div>

					<div class="space-y-1 pt-2 border-t">
						<div class="flex items-center gap-2">
							<Label for="metrics-interval">{m.settings_general_metrics_interval()}</Label>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
								</Tooltip.Trigger>
								<Tooltip.Content class="w-80">
									<p class="text-xs">
										{m.settings_general_metrics_interval_help()}
									</p>
								</Tooltip.Content>
							</Tooltip.Root>
						</div>
						<div class="flex items-center gap-2 mt-2">
							<Select.Root
								type="single"
								value={String(metricsCollectionInterval || 30000)}
								onValueChange={(v) => v && handleMetricsIntervalChange({ value: parseInt(v) })}
								disabled={!$canAccess('settings', 'edit')}
							>
								<Select.Trigger class="w-24 h-8">
									{(metricsCollectionInterval || 30000) === 10000 ? '10s' : (metricsCollectionInterval || 30000) === 30000 ? '30s' : (metricsCollectionInterval || 30000) === 60000 ? '60s' : '120s'}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="10000">10s</Select.Item>
									<Select.Item value="30000">30s</Select.Item>
									<Select.Item value="60000">60s</Select.Item>
									<Select.Item value="120000">120s</Select.Item>
								</Select.Content>
							</Select.Root>
						</div>
					</div>

					<div class="space-y-1 pt-2 border-t">
						<div class="flex items-center gap-3">
							<Label for="schedule-retention">{m.settings_general_schedule_cleanup()}</Label>
							<TogglePill
								checked={scheduleCleanupEnabled}
								onchange={handleScheduleCleanupEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">{m.settings_general_schedule_cleanup_hint()}</p>
						<div class="flex items-center gap-2 mt-2">
							<Input
								id="schedule-retention"
								type="number"
								min="1"
								max="365"
								value={scheduleRetentionDays}
								onchange={handleScheduleRetentionChange}
								disabled={!$canAccess('settings', 'edit') || !scheduleCleanupEnabled}
								class="w-20"
							/>
							<span class="text-sm text-muted-foreground">{m.settings_general_days()}</span>
							<div class="ml-auto">
								<CronEditor
									value={scheduleCleanupCron}
									onchange={handleScheduleCleanupCronChange}
									disabled={!$canAccess('settings', 'edit') || !scheduleCleanupEnabled}
								/>
							</div>
						</div>
					</div>
					<div class="space-y-1">
						<div class="flex items-center gap-3">
							<Label for="event-retention">{m.settings_general_event_cleanup()}</Label>
							<TogglePill
								checked={eventCleanupEnabled}
								onchange={handleEventCleanupEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">{m.settings_general_event_cleanup_hint()}</p>
						<div class="flex items-center gap-2 mt-2">
							<Input
								id="event-retention"
								type="number"
								min="1"
								max="365"
								value={eventRetentionDays}
								onchange={handleEventRetentionChange}
								disabled={!$canAccess('settings', 'edit') || !eventCleanupEnabled}
								class="w-20"
							/>
							<span class="text-sm text-muted-foreground">{m.settings_general_days()}</span>
							<div class="ml-auto">
								<CronEditor
									value={eventCleanupCron}
									onchange={handleEventCleanupCronChange}
									disabled={!$canAccess('settings', 'edit') || !eventCleanupEnabled}
								/>
							</div>
						</div>
					</div>
					<div class="space-y-1">
						<div class="flex items-center gap-3">
							<Label for="scan-retention-keep">{m.settings_general_scan_retention()}</Label>
							<TogglePill
								checked={scanRetentionEnabled}
								onchange={handleScanRetentionEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">
							{m.settings_general_scan_retention_hint()}
						</p>
						<div class="flex items-center gap-2 mt-2">
							<Input
								id="scan-retention-keep"
								type="number"
								min="1"
								max="100"
								value={scanRetentionKeep}
								onchange={handleScanRetentionKeepChange}
								disabled={!$canAccess('settings', 'edit') || !scanRetentionEnabled}
								class="w-20"
							/>
							<span class="text-sm text-muted-foreground">{m.settings_general_scan_retention_keep()}</span>
							<Input
								id="scan-retention-grace"
								type="number"
								min="0"
								max="365"
								value={scanRetentionGraceDays}
								onchange={handleScanRetentionGraceChange}
								disabled={!$canAccess('settings', 'edit') || !scanRetentionEnabled}
								class="w-20 ml-3"
							/>
							<span class="text-sm text-muted-foreground">{m.settings_general_scan_retention_grace()}</span>
							<div class="ml-auto">
								<CronEditor
									value={scanRetentionCron}
									onchange={handleScanRetentionCronChange}
									disabled={!$canAccess('settings', 'edit') || !scanRetentionEnabled}
								/>
							</div>
						</div>
					</div>
					<div class="space-y-1 pt-2 border-t">
						<div class="flex items-center gap-3">
							<Label>{m.settings_general_volume_helper_cleanup()}</Label>
							<Badge variant="secondary" class="text-xs">{m.settings_general_always_enabled()}</Badge>
						</div>
						<p class="text-xs text-muted-foreground">
							{m.settings_general_volume_helper_cleanup_hint()}
						</p>
					</div>
					<div class="space-y-1 pt-2 border-t">
						<div class="flex items-center gap-3">
							<Label>{m.settings_general_scanner_cleanup()}</Label>
							<TogglePill
								checked={scannerCleanupEnabled}
								onchange={handleScannerCleanupEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">{m.settings_general_scanner_cleanup_hint()}</p>
						{#if scannerCleanupEnabled}
							<div class="mt-2">
								<CronEditor
									value={scannerCleanupCron}
									onchange={handleScannerCleanupCronChange}
									disabled={!$canAccess('settings', 'edit')}
								/>
							</div>
						{/if}
					</div>
					<div class="space-y-1 pt-2 border-t">
						<div class="flex items-center gap-3">
							<Label>{m.schedules_type_deploy_log_reconcile()}</Label>
							<Tooltip.Provider delayDuration={100}>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-4 h-4 text-muted-foreground cursor-help" />
									</Tooltip.Trigger>
									<Tooltip.Portal>
										<Tooltip.Content side="right" sideOffset={8} class="!w-80">
											{m.settings_general_deploy_log_reconcile_help()}
										</Tooltip.Content>
									</Tooltip.Portal>
								</Tooltip.Root>
							</Tooltip.Provider>
							<TogglePill
								checked={deployLogReconcileEnabled}
								onchange={handleDeployLogReconcileEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">{m.settings_general_deploy_log_reconcile_hint()}</p>
						{#if deployLogReconcileEnabled}
							<div class="mt-2">
								<CronEditor
									value={deployLogReconcileCron}
									onchange={handleDeployLogReconcileCronChange}
									disabled={!$canAccess('settings', 'edit')}
								/>
							</div>
						{/if}
					</div>
					<div class="space-y-1 pt-2 border-t">
						<div class="flex items-center gap-3">
							<Label>{m.settings_general_protect_helper_images()}</Label>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
								</Tooltip.Trigger>
								<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
									<p>{m.settings_general_protect_helper_images_help()}</p>
								</Tooltip.Content>
							</Tooltip.Root>
							<TogglePill
								checked={$appSettings.protectScannerImages}
								onchange={(checked) => {
									appSettings.setProtectScannerImages(checked);
									toast.success(checked ? m.settings_general_toast_helper_images_protected() : m.settings_general_toast_helper_images_unprotected());
								}}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">{m.settings_general_protect_helper_images_hint()}</p>
					</div>
				</Card.Content>
			</Card.Root>
			{/if}

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<LayoutDashboard class="w-4 h-4" />
						{m.nav_dashboard()}
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-3">
						<div class="space-y-1">
							<div class="flex items-center gap-3">
								<Label>{m.settings_general_label_filter_mode()}</Label>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
									</Tooltip.Trigger>
									<Tooltip.Content class="w-80">
										<p class="text-xs">
											{m.settings_general_label_filter_help_intro()}
											<strong>{m.settings_general_label_filter_any_quoted()}</strong>: {m.settings_general_label_filter_any_help()}
											<strong>{m.settings_general_label_filter_all_quoted()}</strong>: {m.settings_general_label_filter_all_help()}
										</p>
									</Tooltip.Content>
								</Tooltip.Root>
								<ToggleSwitch
									value={labelFilterMode}
									leftValue="any"
									rightValue="all"
									leftLabel={m.settings_general_label_filter_any()}
									rightLabel={m.settings_general_label_filter_all()}
									onchange={(mode) => appSettings.setLabelFilterMode(mode as LabelFilterMode)}
									disabled={!$canAccess('settings', 'edit')}
								/>
							</div>
						</div>
					</div>
				</Card.Content>
			</Card.Root>
		</div>
	</div>
</div>
