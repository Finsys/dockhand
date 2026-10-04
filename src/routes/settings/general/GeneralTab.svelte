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
		toast.success('Compose template updated');
	}

	function revertComposeTemplate() {
		composeTemplateWIP = builtinComposeTemplate;
		toast.info('Template reverted to default');
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
					toast.success(`Scanner cache cleared (${total} items removed)`);
				} else {
					toast.info('Scanner cache was already empty');
				}
			} else {
				toast.error(data.error || 'Failed to clear scanner cache');
			}
		} catch {
			toast.error('Failed to clear scanner cache');
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
		{ value: 'tar', label: 'tar', description: 'Uncompressed archive' },
		{ value: 'tar.gz', label: 'tar.gz', description: 'Gzip-compressed archive' },
		{ value: 'raw', label: 'No archive', description: 'Single file, raw bytes' }
	];

	const downloadFormatLabel: Record<DownloadFormat, string> = {
		tar: 'tar',
		'tar.gz': 'tar.gz',
		raw: 'No archive'
	};

	function handleScheduleRetentionChange(e: Event) {
		const value = Math.max(1, Math.min(365, parseInt((e.target as HTMLInputElement).value) || 30));
		appSettings.setScheduleRetentionDays(value);
		toast.success('Schedule retention updated');
	}

	function handleEventRetentionChange(e: Event) {
		const value = Math.max(1, Math.min(365, parseInt((e.target as HTMLInputElement).value) || 30));
		appSettings.setEventRetentionDays(value);
		toast.success('Event retention updated');
	}

	function handleScheduleCleanupCronChange(cron: string) {
		appSettings.setScheduleCleanupCron(cron);
		toast.success('Schedule cleanup cron updated');
	}

	function handleEventCleanupCronChange(cron: string) {
		appSettings.setEventCleanupCron(cron);
		toast.success('Event cleanup cron updated');
	}

	function handleScheduleCleanupEnabledChange() {
		const newState = !scheduleCleanupEnabled;
		appSettings.setScheduleCleanupEnabled(newState);
		toast.success(newState ? 'Schedule cleanup enabled' : 'Schedule cleanup disabled');
	}

	function handleEventCleanupEnabledChange() {
		const newState = !eventCleanupEnabled;
		appSettings.setEventCleanupEnabled(newState);
		toast.success(newState ? 'Event cleanup enabled' : 'Event cleanup disabled');
	}

	function handleScanRetentionEnabledChange() {
		const newState = !scanRetentionEnabled;
		appSettings.setScanRetentionEnabled(newState);
		toast.success(newState ? 'Scan retention enabled' : 'Scan retention disabled');
	}

	function handleScanRetentionCronChange(cron: string) {
		appSettings.setScanRetentionCron(cron);
		toast.success('Scan retention schedule updated');
	}

	function handleScanRetentionKeepChange(event: Event) {
		const value = parseInt((event.target as HTMLInputElement).value, 10);
		if (!Number.isFinite(value) || value < 1) return;
		appSettings.setScanRetentionKeep(value);
		toast.success('Scan retention updated');
	}

	function handleScanRetentionGraceChange(event: Event) {
		const value = parseInt((event.target as HTMLInputElement).value, 10);
		if (!Number.isFinite(value) || value < 0) return;
		appSettings.setScanRetentionGraceDays(value);
		toast.success('Scan retention updated');
	}

	function handleScannerCleanupCronChange(cron: string) {
		appSettings.setScannerCleanupCron(cron);
		toast.success('Scanner cleanup cron updated');
	}

	function handleScannerCleanupEnabledChange() {
		const newState = !scannerCleanupEnabled;
		appSettings.setScannerCleanupEnabled(newState);
		toast.success(newState ? 'Scanner cleanup enabled' : 'Scanner cleanup disabled');
	}

	function handleDeployLogReconcileCronChange(cron: string) {
		appSettings.setDeployLogReconcileCron(cron);
		toast.success('Deploy log reconcile cron updated');
	}

	function handleDeployLogReconcileEnabledChange() {
		const newState = !deployLogReconcileEnabled;
		appSettings.setDeployLogReconcileEnabled(newState);
		toast.success(newState ? 'Deploy log reconcile enabled' : 'Deploy log reconcile disabled');
	}

	function handleGrypeImageBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value && value !== defaultGrypeImage) {
			appSettings.setDefaultGrypeImage(value);
			toast.success('Grype image updated');
		}
	}

	function handleTrivyImageBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value && value !== defaultTrivyImage) {
			appSettings.setDefaultTrivyImage(value);
			toast.success('Trivy image updated');
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
			toast.error('Could not reach the registry to check scanner versions');
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
		toast.success(`Scanner image set to ${image} - pull it to start using it`);
	}

	function handleGrypeArgsBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value !== defaultGrypeArgs) {
			appSettings.setDefaultGrypeArgs(value);
			toast.success('Grype default arguments updated');
		}
	}

	function handleTrivyArgsBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value !== defaultTrivyArgs) {
			appSettings.setDefaultTrivyArgs(value);
			toast.success('Trivy default arguments updated');
		}
	}

	function handleScannerNetworkModeChange(value: string) {
		const trimmed = (value ?? '').trim();
		if (trimmed !== defaultScannerNetworkMode) {
			appSettings.setDefaultScannerNetworkMode(trimmed);
			toast.success(trimmed ? `Scanner network mode set to ${trimmed}` : 'Scanner network mode cleared');
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
			toast.success(cleaned.length ? `Scanner DNS set to ${cleaned.join(', ')}` : 'Scanner DNS cleared');
		}
	}

	// Anything above 2K starts feeling laggy in browsers without virtualized rendering.
	const logMaxLinesOptions = [
		{ value: '500', label: '500 lines' },
		{ value: '1000', label: '1,000 lines' },
		{ value: '2000', label: '2,000 lines' }
	];

	function handleLogMaxLinesChange(value: string | undefined) {
		const n = parseInt(value ?? '');
		if (!Number.isFinite(n) || n <= 0) return;
		appSettings.setLogMaxLines(Math.min(2000, Math.max(100, n)));
		toast.success('Log buffer size updated');
	}

	function handleEventCollectionModeChange(value: string | undefined) {
		if (value === 'stream' || value === 'poll') {
			appSettings.setEventCollectionMode(value);
			toast.success(`Event collection mode: ${value}`);
		}
	}

	function handleEventPollIntervalChange(selected: { value: number } | undefined) {
		if (selected?.value) {
			appSettings.setEventPollInterval(selected.value);
			toast.success(`Event poll interval: ${selected.value / 1000}s`);
		}
	}

	function handleMetricsIntervalChange(selected: { value: number } | undefined) {
		if (selected?.value) {
			appSettings.setMetricsCollectionInterval(selected.value);
			toast.success(`Metrics interval: ${selected.value / 1000}s`);
		}
	}

	function handleBackupImageBlur(e: Event) {
		const value = (e.target as HTMLInputElement).value.trim();
		if (value && value !== defaultBackupImage) {
			appSettings.setDefaultBackupImage(value);
			toast.success('Backup image updated');
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
			if (!res.ok) throw new Error(data.error || 'Failed to save minimum image age');
			toast.success('Minimum image age updated');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to save minimum image age');
		} finally { releaseAgeSaving = false; }
	}

	// Global newer-version-tag (semver) detection.
	let semverEnabled = $state(false);
	let semverMaxBump = $state<'patch' | 'minor' | 'major'>('major');
	let semverMatchFlavor = $state(true);
	let semverIncludePrerelease = $state(false);
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
					includePrerelease: semverIncludePrerelease
				})
			});
		} catch {
			toast.error('Failed to save version-check settings');
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
						Appearance
						<Tooltip.Provider delayDuration={100}>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<HelpCircle class="w-4 h-4 text-muted-foreground cursor-help" />
								</Tooltip.Trigger>
								<Tooltip.Portal>
									<Tooltip.Content side="right" sideOffset={8} class="!w-80">
										{#if $authStore.authEnabled}
											These settings apply to the login page and as defaults. Personal preferences can be configured in your profile.
										{:else}
											Theme and font settings are global when authentication is disabled.
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
									<Label>Show stopped containers</Label>
									<TogglePill
										checked={showStoppedContainers}
										onchange={(checked) => {
											appSettings.setShowStoppedContainers(checked);
											toast.success(checked ? 'Stopped containers shown' : 'Stopped containers hidden');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Display stopped and exited containers in lists</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Highlight available updates</Label>
									<TogglePill
										checked={highlightUpdates}
										onchange={(checked) => {
											appSettings.setHighlightUpdates(checked);
											toast.success(checked ? 'Update highlighting enabled' : 'Update highlighting disabled');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Highlight container rows in amber when updates are available</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Show changelog links</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>Surface a release-notes link next to the image name on rows with updates available. The link is resolved from the image's <code>org.opencontainers.image.source</code> label, from the <code>ghcr.io</code> registry path, or from an explicit <code>dockhand.changelog.url</code> label override.</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={showImageChangelogLinks}
										onchange={(checked) => {
											appSettings.setShowImageChangelogLinks(checked);
											toast.success(checked ? 'Changelog links shown' : 'Changelog links hidden');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Show a release-notes icon next to images with updates available</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Use selfh.st icons</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>Show app logos from <a href="https://selfh.st" target="_blank" rel="noopener" class="underline">selfh.st</a> as container icons, matched automatically from the image name. Logos are fetched once and cached locally, so your browser never contacts an external CDN. Off by default. Logos are CC BY 4.0; product names and trademarks are the property of their respective owners and are shown for identification only, without implying endorsement.</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={useSelfhstIcons}
										onchange={(checked) => {
											appSettings.setUseSelfhstIcons(checked);
											toast.success(checked ? 'selfh.st icons enabled' : 'selfh.st icons disabled');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Auto app logos on containers, fetched from selfh.st and cached locally</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Show "What's New"</Label>
									<TogglePill
										checked={showWhatsNew}
										onchange={(checked) => {
											appSettings.setShowWhatsNew(checked);
											toast.success(checked ? "What's New popup enabled" : "What's New popup disabled");
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Show the "What's New" popup after upgrading to a new version</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Compact port display</Label>
									<TogglePill
										checked={compactPorts}
										onchange={(checked) => {
											appSettings.setCompactPorts(checked);
											toast.success(checked ? 'Compact port display enabled' : 'Showing all ports');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Show first port with +N count instead of all ports</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Show exposed ports</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>Shows internal container ports (from EXPOSE directives) that are not published to the host. These appear in the container list with an amber badge to distinguish them from published port mappings.</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={showExposedPorts}
										onchange={(checked) => {
											appSettings.setShowExposedPorts(checked);
											toast.success(checked ? 'Showing exposed ports in container list' : 'Exposed ports hidden from container list');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Display internal container ports in the container list grid</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Show git commit hash</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>Shows the deployed short commit hash on the Git badge in the stacks list source column, with the full hash, repo URL and branch in a tooltip.</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={showGitCommitHash}
										onchange={(checked) => {
											appSettings.setShowGitCommitHash(checked);
											toast.success(checked ? 'Showing git commit hash on stack badges' : 'Git commit hash hidden');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Display the deployed commit hash on the Git source badge in the stacks list</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Honor Traefik/Pangolin/Caddy labels</Label>
									<Tooltip.Root>
										<Tooltip.Trigger>
											<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
										</Tooltip.Trigger>
										<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
											<p>Parse <code>traefik.http.routers.&lt;name&gt;.rule</code>, <code>pangolin.public-resources.&lt;name&gt;.full-domain</code>, <code>pangolin.private-resources.&lt;name&gt;.full-domain</code>, and caddy-docker-proxy <code>caddy</code>/<code>caddy_&lt;n&gt;</code> site-address labels, and surface the resulting URLs as clickable pills next to ports. When off, only explicit <code>dockhand.url</code> labels are shown.</p>
										</Tooltip.Content>
									</Tooltip.Root>
									<TogglePill
										checked={honorProxyLabels}
										onchange={(checked) => {
											appSettings.setHonorProxyLabels(checked);
											toast.success(checked ? 'Proxy labels honored' : 'Proxy labels ignored');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Show URLs inferred from Traefik and Pangolin labels alongside dockhand.url</p>
							</div>
						</div>
						<!-- Right column: Theme settings (always shown, with hint when auth enabled) -->
						<div class="space-y-4">
							<ThemeSelector />
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
										<p>These are the <strong>defaults for new users</strong> - they don't change your own view. To customise how <em>you</em> see the app, use the theme settings in your <a href="/profile" class="text-primary hover:underline">profile</a>.</p>
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
								<Label>Time format</Label>
								<ToggleSwitch
									value={timeFormat}
									leftValue="24h"
									rightValue="12h"
									onchange={(newFormat) => {
										appSettings.setTimeFormat(newFormat as '12h' | '24h');
										toast.success(`Time format set to ${newFormat === '12h' ? '12-hour (AM/PM)' : '24-hour'}`);
									}}
									disabled={!$canAccess('settings', 'edit')}
								/>
							</div>
							<p class="text-xs text-muted-foreground">Clock display used throughout the app</p>
						</div>
						<div class="space-y-1">
							<div class="flex items-center gap-3">
								<Label>Date format</Label>
								<Select.Root
									type="single"
									value={dateFormat}
									onValueChange={(value) => {
										if (value) {
											appSettings.setDateFormat(value as DateFormat);
											toast.success(`Date format set to ${value}`);
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
							<p class="text-xs text-muted-foreground">Date display used throughout the app</p>
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
						Navigation
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
						Scheduling
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-2">
						<Label>Default timezone</Label>
						<TimezoneSelector
							value={defaultTimezone}
							onchange={(value) => {
								appSettings.setDefaultTimezone(value);
								toast.success(`Default timezone set to ${value}`);
							}}
							class="w-[320px]"
						/>
						<p class="text-xs text-muted-foreground">Default timezone for new environments. Used for scheduled tasks like auto-updates.</p>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Bell class="w-4 h-4" />
						Confirmations
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-1">
						<div class="flex items-center gap-3">
							<Label>Confirm destructive actions</Label>
							<TogglePill
								checked={confirmDestructive}
								onchange={(checked) => {
									appSettings.setConfirmDestructive(checked);
									toast.success(checked ? 'Confirmations enabled' : 'Confirmations disabled');
								}}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">Show confirmation dialogs before deleting resources</p>
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<FileText class="w-4 h-4" />
						Logs & files
					</Card.Title>
				</Card.Header>
				<Card.Content>
					<div class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
						<div class="space-y-4">
							<div class="space-y-2">
								<Label for="log-max-lines">Log buffer size</Label>
								<Select.Root
									type="single"
									value={String(logMaxLines)}
									onValueChange={handleLogMaxLinesChange}
									disabled={!$canAccess('settings', 'edit')}
								>
									<Select.Trigger id="log-max-lines" class="w-48">
										{logMaxLines.toLocaleString()} lines
									</Select.Trigger>
									<Select.Content>
										{#each logMaxLinesOptions as opt}
											<Select.Item value={opt.value}>{opt.label}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
								<p class="text-xs text-muted-foreground">Maximum number of log lines kept per container panel. Older lines are dropped when the limit is exceeded.</p>
							</div>
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Download format</Label>
									<Select.Root
										type="single"
										value={downloadFormat}
										onValueChange={(value) => {
											if (value) {
												appSettings.setDownloadFormat(value as DownloadFormat);
												toast.success(`Download format set to ${downloadFormatLabel[value as DownloadFormat]}`);
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
								<p class="text-xs text-muted-foreground">Format when downloading files from containers or volumes. "No archive" emits raw bytes for single files; directories still download as tar.</p>
							</div>
						</div>
						<div class="space-y-4">
							<div class="space-y-1">
								<div class="flex items-center gap-3">
									<Label>Format log timestamps</Label>
									<TogglePill
										checked={formatLogTimestamps}
										onchange={(checked) => {
											appSettings.setFormatLogTimestamps(checked);
											toast.success(checked ? 'Log timestamp formatting enabled' : 'Log timestamp formatting disabled');
										}}
										disabled={!$canAccess('settings', 'edit')}
									/>
								</div>
								<p class="text-xs text-muted-foreground">Convert ISO timestamps in logs to your configured date/time format</p>
								<div class="flex items-start gap-1.5 mt-1">
									<Info class="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
									<p class="text-xs text-muted-foreground">Docker logs use UTC timestamps by default. When enabled, timestamps like <code class="bg-muted px-1 rounded">2026-01-12T07:47:44Z</code> are converted to local time using your date/time settings.</p>
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
						Stack operation logs
					</Card.Title>
					<p class="text-xs text-muted-foreground">Choose which stack operations open the full compose-log popover. Unchecked operations run quietly with just a toast; their log still opens automatically if the operation fails.</p>
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
								<Label>{op.label}</Label>
							</div>
						{/each}
					</div>
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<FileText class="w-4 h-4" />
						Compose template
					</Card.Title>
					<p class="text-xs text-muted-foreground">Default YAML content when creating a new stack.</p>
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
								Save template
							</Button>
							<Button size="sm" variant="ghost" onclick={revertComposeTemplate}>
								<RotateCcw class="w-3.5 h-3.5" />
								Revert to default
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
						Vulnerability scanners
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-2">
						<Label for="grype-image">Grype image</Label>
						<Input
							id="grype-image"
							value={defaultGrypeImage}
							onblur={handleGrypeImageBlur}
							disabled={!$canAccess('settings', 'edit')}
							placeholder={DEFAULT_GRYPE_IMAGE}
						/>
						<div class="flex items-center gap-2 flex-wrap">
							<p class="text-xs text-muted-foreground">Docker image for Grype scanner. Pin to a specific version for supply chain security.</p>
							{#if newerScanners.grype}
								<button
									type="button"
									class="inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors"
									onclick={() => applyScannerVersion('grype')}
									disabled={!$canAccess('settings', 'edit')}
								>
									Use {newerScanners.grype}
								</button>
							{:else if scannerUpToDate.grype}
								<span class="text-2xs text-muted-foreground">Up to date</span>
							{/if}
						</div>
					</div>
					<div class="space-y-2">
						<Label for="trivy-image">Trivy image</Label>
						<Input
							id="trivy-image"
							value={defaultTrivyImage}
							onblur={handleTrivyImageBlur}
							disabled={!$canAccess('settings', 'edit')}
							placeholder={DEFAULT_TRIVY_IMAGE}
						/>
						<div class="flex items-center gap-2 flex-wrap">
							<p class="text-xs text-muted-foreground">Docker image for Trivy scanner. Pin to a specific version for supply chain security.</p>
							{#if newerScanners.trivy}
								<button
									type="button"
									class="inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-600 hover:bg-green-500/20 transition-colors"
									onclick={() => applyScannerVersion('trivy')}
									disabled={!$canAccess('settings', 'edit')}
								>
									Use {newerScanners.trivy}
								</button>
							{:else if scannerUpToDate.trivy}
								<span class="text-2xs text-muted-foreground">Up to date</span>
							{/if}
						</div>
						<div class="pt-1">
							<Button variant="outline" size="sm" onclick={checkScannerVersions} disabled={checkingScannerVersions}>
								{checkingScannerVersions ? 'Checking...' : 'Check for newer scanner versions'}
							</Button>
						</div>
					</div>
					<div class="space-y-2">
						<Label for="grype-args">Default Grype arguments</Label>
						<Input
							id="grype-args"
							value={defaultGrypeArgs}
							onblur={handleGrypeArgsBlur}
							disabled={!$canAccess('settings', 'edit')}
							placeholder={DEFAULT_GRYPE_ARGS}
						/>
						<p class="text-xs text-muted-foreground">Use <code class="bg-muted px-1 rounded">{'{image}'}</code> as placeholder for the image name</p>
					</div>
					<div class="space-y-2">
						<Label for="trivy-args">Default Trivy arguments</Label>
						<Input
							id="trivy-args"
							value={defaultTrivyArgs}
							onblur={handleTrivyArgsBlur}
							disabled={!$canAccess('settings', 'edit')}
							placeholder={DEFAULT_TRIVY_ARGS}
						/>
						<p class="text-xs text-muted-foreground">Use <code class="bg-muted px-1 rounded">{'{image}'}</code> as placeholder for the image name</p>
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
							Advanced settings
						</button>
					</div>
					{#if showAdvancedScannerSettings}
						<div class="space-y-2">
							<Label for="scanner-network-mode">Network mode</Label>
							<Select.Root
								type="single"
								value={defaultScannerNetworkMode}
								onValueChange={handleScannerNetworkModeChange}
							>
								<Select.Trigger id="scanner-network-mode" class="w-full" disabled={!$canAccess('settings', 'edit')}>
									<span>{defaultScannerNetworkMode || 'Default (auto-detect)'}</span>
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="">Default (auto-detect)</Select.Item>
									<Select.Item value="host">host</Select.Item>
									<Select.Item value="bridge">bridge</Select.Item>
									<Select.Item value="none">none</Select.Item>
								</Select.Content>
							</Select.Root>
							<p class="text-xs text-muted-foreground">Override the Docker network mode for vulnerability scanner containers. Use <code class="bg-muted px-1 rounded">host</code> on hosts where the default bridge can't reach the internet (e.g. iptables disabled, SELinux restricted).</p>
						</div>
						<div class="space-y-2">
							<Label for="scanner-dns">DNS servers</Label>
							<Input
								id="scanner-dns"
								value={defaultScannerDns.join(', ')}
								onblur={handleScannerDnsBlur}
								disabled={!$canAccess('settings', 'edit')}
							/>
							<p class="text-xs text-muted-foreground">Comma-separated DNS IPs for scanner containers. Empty = inherit from the Docker daemon.</p>
						</div>
					{/if}
					<div class="pt-2 border-t">
						<div class="flex items-center justify-between">
							<div>
								<p class="text-sm font-medium">Scanner cache</p>
								<p class="text-xs text-muted-foreground">Remove cached vulnerability databases to free disk space. Next scan will re-download fresh data (~200MB).</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={clearingCache || !$canAccess('settings', 'edit')}
								onclick={clearScannerCache}
							>
								{#if clearingCache}
									Clearing...
								{:else}
									Clear cache
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
						Minimum image age
						<Tooltip.Provider delayDuration={100}>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<HelpCircle class="w-4 h-4 text-muted-foreground cursor-help" />
								</Tooltip.Trigger>
								<Tooltip.Portal>
									<Tooltip.Content side="right" sideOffset={8} class="!w-96 space-y-2">
										<p>The age comes from the image's creation time in the registry, which records the build rather than the publication. When the registry gives no usable time, Dockhand counts from when it first saw that digest.</p>
										<p>An environment can override this value. Manual pulls warn and proceed; stack deployments, including scheduled Git ones, are exempt.</p>
										<p>A newer image restarts the wait on itself, so a project publishing faster than this age never updates automatically.</p>
									</Tooltip.Content>
								</Tooltip.Portal>
							</Tooltip.Root>
						</Tooltip.Provider>
					</Card.Title>
					<Card.Description>
						Hold automatic container updates until a new image has been out for a while.
					</Card.Description>
				</Card.Header>
				<Card.Content class="flex items-end gap-3">
					<div class="space-y-2 flex-1">
						<Label for="minimum-release-age">Hours (0–720)</Label>
						<Input id="minimum-release-age" type="number" min="0" max="720" step="1" bind:value={releaseAgeHours} disabled={releaseAgeOverridden || !$canAccess('settings', 'edit')} />
					</div>
					<Button onclick={saveReleaseAge} disabled={releaseAgeSaving || releaseAgeOverridden || !$canAccess('settings', 'edit')}>Save</Button>
				</Card.Content>
				{#if releaseAgeOverridden}
					<p class="px-6 pb-4 text-xs text-muted-foreground">Set by MINIMUM_RELEASE_AGE_HOURS.</p>
				{/if}
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<Tags class="w-4 h-4" />
						Newer version tags
					</Card.Title>
					<Card.Description>
						How the update check looks for newer version tags on pinned images. Applies to every
						check - scheduled and manual. Per-environment settings decide whether to check on a
						schedule; this decides how versions are compared.
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<SemverCheckConfig
						bind:enabled={semverEnabled}
						bind:maxBump={semverMaxBump}
						bind:matchFlavor={semverMatchFlavor}
						bind:includePrerelease={semverIncludePrerelease}
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
						System jobs
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-3">
						<div>
							<div class="flex items-center gap-2">
								<Label>Activity event collection mode</Label>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
									</Tooltip.Trigger>
									<Tooltip.Content class="w-80">
										<p class="text-xs">
											<strong>Stream:</strong> Continuous event stream from Docker, instant notifications, higher CPU usage<br />
											<strong>Poll:</strong> Periodic checks for new events, slight notification delay, lower CPU usage
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
									<span class="text-sm">Stream</span>
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
									<span class="text-sm">Poll</span>
								</label>

								<span class="text-xs text-muted-foreground {(eventCollectionMode || 'stream') === 'poll' ? '' : 'invisible'}">every</span>
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
							<Label for="metrics-interval">Metrics collection interval</Label>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
								</Tooltip.Trigger>
								<Tooltip.Content class="w-80">
									<p class="text-xs">
										How often to collect CPU/memory metrics from running containers. Lower intervals
										provide more frequent updates but increase CPU usage.
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
							<Label for="schedule-retention">Schedule execution cleanup</Label>
							<TogglePill
								checked={scheduleCleanupEnabled}
								onchange={handleScheduleCleanupEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">Delete executions older than specified days</p>
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
							<span class="text-sm text-muted-foreground">days</span>
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
							<Label for="event-retention">Container event cleanup</Label>
							<TogglePill
								checked={eventCleanupEnabled}
								onchange={handleEventCleanupEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">Delete events older than specified days</p>
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
							<span class="text-sm text-muted-foreground">days</span>
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
							<Label for="scan-retention-keep">Vulnerability scan retention</Label>
							<TogglePill
								checked={scanRetentionEnabled}
								onchange={handleScanRetentionEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">
							Keep the newest scans per image and drop scans for images the host no longer has
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
							<span class="text-sm text-muted-foreground">newest per image</span>
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
							<span class="text-sm text-muted-foreground">days grace</span>
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
							<Label>Volume helper cleanup</Label>
							<Badge variant="secondary" class="text-xs">Always enabled</Badge>
						</div>
						<p class="text-xs text-muted-foreground">
							Automatically removes temporary containers used for browsing volume contents.
							Runs every 30 minutes and on startup.
						</p>
					</div>
					<div class="space-y-1 pt-2 border-t">
						<div class="flex items-center gap-3">
							<Label>Scanner cache cleanup</Label>
							<TogglePill
								checked={scannerCleanupEnabled}
								onchange={handleScannerCleanupEnabledChange}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">Remove cached vulnerability databases to reclaim disk space</p>
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
							<Label>Deploy log reconcile</Label>
							<Tooltip.Provider delayDuration={100}>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-4 h-4 text-muted-foreground cursor-help" />
									</Tooltip.Trigger>
									<Tooltip.Portal>
										<Tooltip.Content side="right" sideOffset={8} class="!w-80">
											Every deploy from Dockhand keeps a log file on disk, linked to its run in the
											Deploys tab. This job runs on a schedule to keep the two in sync: it deletes
											orphaned log files whose deploy run was already removed, and marks a run whose
											log file has gone missing (so the Deploys tab shows "log unavailable" instead
											of a blank). It never deletes a deploy run itself.
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
						<p class="text-xs text-muted-foreground">Keeps deploy-log files in sync with their deploy records: removes logs whose run is gone, and flags runs whose log went missing (never deletes a run).</p>
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
							<Label>Protect helper images from prune</Label>
							<Tooltip.Root>
								<Tooltip.Trigger>
									<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
								</Tooltip.Trigger>
								<Tooltip.Content side="top" class="w-96 max-w-[90vw]">
									<p>When ON, "Prune all unused" skips the images Dockhand runs its own jobs from: the grype and trivy scanners, and the backup helper. Each is pulled once and reused, so keeping them saves the next scan re-downloading the ~100MB vulnerability database, and the next backup re-pulling the helper - which on a host without internet access would fail outright. When OFF, prune behaves like vanilla Docker and may remove them.</p>
								</Tooltip.Content>
							</Tooltip.Root>
							<TogglePill
								checked={$appSettings.protectScannerImages}
								onchange={(checked) => {
									appSettings.setProtectScannerImages(checked);
									toast.success(checked ? 'Helper images will be skipped during prune' : 'Helper images will be pruned with everything else');
								}}
								disabled={!$canAccess('settings', 'edit')}
							/>
						</div>
						<p class="text-xs text-muted-foreground">Skip the grype, trivy and backup-helper images during "Prune all unused"</p>
					</div>
				</Card.Content>
			</Card.Root>
			{/if}

			<Card.Root>
				<Card.Header>
					<Card.Title class="text-sm font-medium flex items-center gap-2">
						<LayoutDashboard class="w-4 h-4" />
						Dashboard
					</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<div class="space-y-3">
						<div class="space-y-1">
							<div class="flex items-center gap-3">
								<Label>Environment label filter matching</Label>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-3.5 h-3.5 text-muted-foreground" />
									</Tooltip.Trigger>
									<Tooltip.Content class="w-80">
										<p class="text-xs">
											Controls how multiple selected environment labels filter environments on the dashboard.
											<strong>"Any"</strong>: shows environments that have at least one of the selected labels.
											<strong>"All"</strong>: shows only environments that have every selected label.
										</p>
									</Tooltip.Content>
								</Tooltip.Root>
								<ToggleSwitch
									value={labelFilterMode}
									leftValue="any"
									rightValue="all"
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
