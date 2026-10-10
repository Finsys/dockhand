<script lang="ts">
	// Trigger rebuild for debug logging changes
	import * as Card from '$lib/components/ui/card';
	import { releasedEntries } from '$lib/utils/changelog-filter';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { SearchInput } from '$lib/components/ui/search-input';
	import { Box, Images, HardDrive, Network, Cpu, Server, Crown, Building2, Layers, Clock, Code, Package, ExternalLink, FileText, Tag, Sparkles, Bug, ChevronDown, ChevronRight, Plug, ScrollText, Shield, MessageSquarePlus, GitBranch, Coffee, Monitor, Cog, MemoryStick, Database, CircleArrowUp, Loader2, CheckCircle2, TriangleAlert } from 'lucide-svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import { onMount, onDestroy } from 'svelte';
	import { licenseStore } from '$lib/stores/license';
	import { selfUpdate as selfUpdateStore } from '$lib/stores/self-update';
	import { formatBytes } from '$lib/utils/format';
	import { browser } from '$app/environment';
	import LicenseModal from './LicenseModal.svelte';
	import PrivacyModal from './PrivacyModal.svelte';
	import SelfUpdateDialog from './SelfUpdateDialog.svelte';
	import ChangelogText from '$lib/components/ChangelogText.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';

	interface Dependency {
		name: string;
		version: string;
		license: string;
		repository: string | null;
	}

	interface ChangelogChange {
		type: 'feature' | 'fix';
		text: string;
	}

	interface ChangelogEntry {
		version: string;
		date: string;
		changes: ChangelogChange[];
		imageTag: string;
		comingSoon?: boolean;
	}

	let dependencies = $state<Dependency[]>([]);
	let loadingDeps = $state(true);
	let depsError = $state<string | null>(null);
	let depsSearch = $state('');

	let changelog = $state<ChangelogEntry[]>([]);
	let loadingChangelog = $state(true);
	let changelogError = $state<string | null>(null);
	let expandedReleases = $state<Set<number>>(new Set([0])); // First release (latest) expanded by default

	let activeTab = $state('releases');

	function toggleRelease(index: number) {
		const newSet = new Set(expandedReleases);
		if (newSet.has(index)) {
			newSet.delete(index);
		} else {
			newSet.add(index);
		}
		expandedReleases = newSet;
	}

	// Current version from git tag (injected at build time)
	declare const __APP_VERSION__: string | null;
	const currentVersion = __APP_VERSION__ || m.settings_about_unknown();

	const filteredDeps = $derived(
		dependencies.filter(dep =>
			dep.name.toLowerCase().includes(depsSearch.toLowerCase()) ||
			dep.license.toLowerCase().includes(depsSearch.toLowerCase())
		)
	);

	async function fetchDependencies() {
		try {
			const res = await fetch('/api/dependencies');
			if (!res.ok) throw new Error(m.settings_about_dependencies_load_failed());
			dependencies = await res.json();
		} catch (e) {
			depsError = e instanceof Error ? e.message : m.settings_about_unknown_error();
		} finally {
			loadingDeps = false;
		}
	}

	async function fetchChangelog() {
		try {
			const res = await fetch('/api/changelog');
			if (!res.ok) throw new Error(m.settings_about_changelog_load_failed());
			// Shipped releases only: an unreleased (coming-soon) entry must not show as
			// the "Latest" version.
			changelog = releasedEntries(await res.json());
		} catch (e) {
			changelogError = e instanceof Error ? e.message : m.settings_about_unknown_error();
		} finally {
			loadingChangelog = false;
		}
	}

	function formatChangelogDate(dateStr: string): string {
		if (!dateStr) return m.settings_about_unreleased();
		try {
			const date = new Date(dateStr);
			if (isNaN(date.getTime())) return m.settings_about_unreleased();
			return date.toLocaleDateString(getLocale(), {
				year: 'numeric',
				month: 'long',
				day: 'numeric'
			});
		} catch {
			return m.settings_about_unreleased();
		}
	}

	function sortedChanges(changes: ChangelogChange[]): ChangelogChange[] {
		return [...changes].sort((a, b) => {
			if (a.type === b.type) return 0;
			return a.type === 'feature' ? -1 : 1;
		});
	}

	// Build info - injected at build time
	declare const __BUILD_BRANCH__: string | null;
	const BUILD_DATE = __BUILD_DATE__ ?? null;
	const BUILD_COMMIT = __BUILD_COMMIT__ ?? null;
	const BUILD_BRANCH = __BUILD_BRANCH__ ?? null;

	const TAGLINES = [
		m.settings_about_tagline_simplify_deploy_smile,
		m.settings_about_tagline_less_typing,
		m.settings_about_tagline_taming_containers,
		m.settings_about_tagline_minus_sea_monsters,
		m.settings_about_tagline_open_heart_surgery,
		m.settings_about_tagline_rule_your_containers,
		m.settings_about_tagline_cli_fatigue_real,
		m.settings_about_tagline_automate_orchestrate_hydrate,
		m.settings_about_tagline_docker_ps_bliss,
		m.settings_about_tagline_bash_therapy,
		m.settings_about_tagline_devops_deep_breath,
		m.settings_about_tagline_just_containers,
		m.settings_about_tagline_simplify_deploy_smile,
		m.settings_about_tagline_whale_needs_handler,
		m.settings_about_tagline_chaos_to_compose,
		m.settings_about_tagline_no_sea_sickness,
		m.settings_about_tagline_daemon_spirit_guide,
		m.settings_about_tagline_stop_speaking_whale,
		m.settings_about_tagline_docker_ps_lifestyle,
		m.settings_about_tagline_shell_scripts_and_stress,
		m.settings_about_tagline_no_magic_flags,
		m.settings_about_tagline_jumbled_yamls,
		m.settings_about_tagline_containers_listen,
		m.settings_about_tagline_skip_cli_yoga,
		m.settings_about_tagline_rest_of_us,
		m.settings_about_tagline_civilized_since_1_0,
		m.settings_about_tagline_less_whale_wrestling,
		m.settings_about_tagline_calm_seas,
		m.settings_about_tagline_no_drama,
		m.settings_about_tagline_distilled,
		m.settings_about_tagline_smooth_orchestration,
		m.settings_about_tagline_build_ship_chill,
		m.settings_about_tagline_think_less,
		m.settings_about_tagline_no_keyboard_acrobatics,
		m.settings_about_tagline_better_things_to_grep,
		m.settings_about_tagline_existential_crises,
		m.settings_about_tagline_prescribe_automation,
		m.settings_about_tagline_outsmart_bash_history,
		m.settings_about_tagline_less_dockery,
		m.settings_about_tagline_phd_in_bash,
		m.settings_about_tagline_less_chaos_more_chill,
		m.settings_about_tagline_stop_copy_pasting,
		m.settings_about_tagline_not_punishment,
		m.settings_about_tagline_fluent_container,
		m.settings_about_tagline_dignity,
		m.settings_about_tagline_love_hate_docker,
		m.settings_about_tagline_humans_like_buttons,
		m.settings_about_tagline_taming_spirit,
		m.settings_about_tagline_no_whales_in_workflow,
		m.settings_about_tagline_since_this_morning,
		m.settings_about_tagline_devops_day_off,
		m.settings_about_tagline_serious_about_containers,
		m.settings_about_tagline_work_smarter,
		m.settings_about_tagline_break_prod_responsibly,
		m.settings_about_tagline_art_form,
		m.settings_about_tagline_shipping_sanity,
		m.settings_about_tagline_infinite_containers,
		m.settings_about_tagline_less_yak_shaving,
		m.settings_about_tagline_scripts_age_like_milk,
		m.settings_about_tagline_so_2020,
		m.settings_about_tagline_developers_rejoice,
		m.settings_about_tagline_respects_your_time
	];

	interface SystemInfo {
		docker: {
			version: string;
			apiVersion: string;
			os: string;
			arch: string;
			kernelVersion: string;
			serverVersion: string;
			connection: {
				type: 'socket' | 'http' | 'https';
				socketPath?: string;
				host?: string;
				port?: number;
			};
		} | null;
		host: {
			name: string;
			cpus: number;
			memory: number;
			storageDriver: string;
		} | null;
		runtime: {
			runtimeName: string;
			runtimeVersion: string;
			nodeVersion: string;
			platform: string;
			arch: string;
			kernel: string;
			memory: {
				heapUsed: number;
				heapTotal: number;
				rss: number;
				external: number;
			};
			container: {
				inContainer: boolean;
				runtime?: string;
				containerId?: string;
			};
			ownContainer?: {
				id: string;
				name: string;
				image: string;
				imageId: string;
				created: string;
				status: string;
				restartCount: number;
				labels?: {
					version?: string;
					revision?: string;
				};
			} | null;
		};
		database: {
			type: string;
			schemaVersion: string | null;
			schemaDate: string | null;
			host?: string;
			port?: string;
		};
		stats: {
			containers: { total: number; running: number; stopped: number };
			images: number;
			volumes: number;
			networks: number;
			stacks: number;
		};
	}

	let systemInfo: SystemInfo | null = $state(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let isJumping = $state(false);
	let hasClicked = $state(false);
	let clickCount = $state(0);
	let totalClicks = $state(0);
	let showEasterEgg = $state(false);
	let taglineIndex = $state(0);
	let serverUptime = $state<number | null>(null);
	let showLicenseModal = $state(false);
	let showPrivacyModal = $state(false);

	// Self-update state
	let checkingUpdate = $state(false);
	let updateCheckDone = $state(false);
	let updateAvailable = $state(false);
	let updateInfo = $state<{
		currentImage: string;
		newImage: string;
		currentDigest: string;
		newDigest: string;
		containerName: string;
		isComposeManaged: boolean;
		latestVersion?: string;
		error?: string;
	} | null>(null);
	let updateCheckError = $state<string | null>(null);
	let showSelfUpdateDialog = $state(false);

	async function checkForUpdates() {
		checkingUpdate = true;
		updateCheckDone = false;
		updateAvailable = false;
		updateInfo = null;
		updateCheckError = null;

		try {
			const response = await fetch('/api/self-update/check');
			if (!response.ok) {
				updateCheckError = m.settings_about_update_check_failed();
				return;
			}

			const data = await response.json();

			if (data.error && !data.updateAvailable) {
				// Not in Docker or other non-critical issue
				updateCheckError = data.error;
				return;
			}

			updateAvailable = data.updateAvailable;
			updateCheckDone = true;

			// Mirror into the shared store so the sidebar indicator stays
			// in sync with the result of a manual "Check now" (#1146).
			selfUpdateStore.setFromResponse(data);

			if (data.updateAvailable) {
				updateInfo = {
					currentImage: data.currentImage,
					newImage: data.newImage || data.currentImage,
					currentDigest: data.currentDigest || '',
					newDigest: data.newDigest || '',
					containerName: data.containerName,
					isComposeManaged: data.isComposeManaged,
					latestVersion: data.latestVersion
				};
			}
		} catch (err) {
			updateCheckError = m.settings_about_check_failed({ error: String(err) });
		} finally {
			checkingUpdate = false;
		}
	}

	function formatUptime(seconds: number): string {
		const days = Math.floor(seconds / 86400);
		const hours = Math.floor((seconds % 86400) / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = Math.floor(seconds % 60);

		// Always show full format for layout stability
		const pad = (n: number) => n.toString().padStart(2, '0');
		if (days > 0) {
			return m.settings_about_uptime_days({ days, time: `${pad(hours)}:${pad(minutes)}:${pad(secs)}` });
		} else {
			return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
		}
	}

	function formatBuildDate(dateStr: string | null): string {
		if (!dateStr) return m.settings_about_build_development();
		try {
			const date = new Date(dateStr);
			return date.toLocaleDateString(getLocale(), {
				year: 'numeric',
				month: 'short',
				day: 'numeric'
			});
		} catch {
			return dateStr;
		}
	}

	function loadTaglineIndex() {
		if (browser) {
			const saved = localStorage.getItem('dockhand-tagline-index');
			if (saved !== null) {
				taglineIndex = parseInt(saved, 10) % TAGLINES.length;
			}
		}
	}

	function saveTaglineIndex() {
		if (browser) {
			localStorage.setItem('dockhand-tagline-index', String(taglineIndex));
		}
	}

	let jumpLevel = $state(0); // 0, 1, 2 for small, medium, big jump
	let taglineAnimating = $state(false);

	function handleLogoClick() {
		if (isJumping) return;
		hasClicked = true;
		clickCount++;
		totalClicks++;
		jumpLevel = (totalClicks - 1) % 3; // 0, 1, 2 cycle
		isJumping = true;

		// Change tagline every 3 clicks (after the big jump)
		if (totalClicks % 3 === 0) {
			taglineAnimating = true;
			taglineIndex = (taglineIndex + 1) % TAGLINES.length;
			saveTaglineIndex();
			setTimeout(() => {
				taglineAnimating = false;
			}, 400);
		}

		if (clickCount >= 10) {
			showEasterEgg = true;
			setTimeout(() => {
				showEasterEgg = false;
				clickCount = 0;
				totalClicks = 0; // Reset the tagline cycle too
			}, 5000);
		}

		setTimeout(() => {
			isJumping = false;
		}, 800);
	}

	async function fetchSystemInfo() {
		try {
			const [systemRes, hostRes] = await Promise.all([
				fetch('/api/system'),
				fetch('/api/host')
			]);
			if (!systemRes.ok) throw new Error(m.settings_about_system_info_load_failed());
			systemInfo = await systemRes.json();

			if (hostRes.ok) {
				const hostData = await hostRes.json();
				serverUptime = hostData.uptime;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : m.settings_about_unknown_error();
		} finally {
			loading = false;
		}
	}

	let uptimeInterval: ReturnType<typeof setInterval>;

	onMount(() => {
		loadTaglineIndex();
		fetchSystemInfo();
		fetchDependencies();
		fetchChangelog();
		checkForUpdates();
		// Increment uptime every second for real-time display
		uptimeInterval = setInterval(() => {
			if (serverUptime !== null) {
				serverUptime++;
			}
		}, 1000);
	});

	onDestroy(() => {
		if (uptimeInterval) {
			clearInterval(uptimeInterval);
		}
	});
</script>

<div class="flex flex-col items-center py-4 px-4 max-w-5xl mx-auto">
	<!-- Two Column Layout -->
	<div class="w-full grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
		<!-- App Info Card (Left) -->
		<Card.Root class="w-full flex flex-col">
			<Card.Content class="pt-8 pb-6 flex-1 flex items-center">
				<div class="flex flex-col items-center text-center space-y-4 w-full">
					<!-- Logo -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="animate-speedy {isJumping ? (clickCount >= 10 ? 'crazy-jumping' : `jumping-${jumpLevel}`) : ''} {hasClicked && !isJumping ? 'clicked' : ''}" onclick={handleLogoClick}>
						<img
							src="/logo.svg"
							alt={m.sidebar_logo_alt()}
							class="h-36 w-auto object-contain"
							style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.22));"
						/>
						<!-- Sparkles on DOCKHAND text area (bottom half) -->
						<span class="sparkle sparkle-1">✦</span>
						<span class="sparkle sparkle-2">✦</span>
						<span class="sparkle sparkle-3">✦</span>
						<span class="sparkle sparkle-4">✦</span>
						<span class="sparkle sparkle-5">✦</span>
						<span class="sparkle sparkle-6">✦</span>
						<span class="sparkle sparkle-7">✦</span>
						<span class="sparkle sparkle-8">✦</span>
						<!-- Easter Egg Popup -->
						{#if showEasterEgg}
							<div class="easter-egg-popup">
								{m.settings_about_easter_egg()}
							</div>
						{/if}
					</div>

					<!-- Version Badge + Update Check -->
					<div class="flex flex-col items-center gap-1">
						<Badge variant="secondary" class="text-xs">{m.settings_about_version_badge({ version: currentVersion })}</Badge>
						{#if checkingUpdate}
							<span class="flex items-center gap-1 text-xs text-muted-foreground">
								<Loader2 class="w-3.5 h-3.5 animate-spin" />
								{m.settings_about_checking_updates()}
							</span>
						{:else if updateAvailable && updateInfo}
							<button class="flex items-center gap-1 text-xs text-amber-500 hover:text-amber-400 transition-colors" onclick={() => showSelfUpdateDialog = true}>
								<CircleArrowUp class="w-3.5 h-3.5" />
								{m.settings_about_update_available()}
							</button>
						{:else if updateCheckDone && !updateAvailable}
							<button class="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-500 dark:hover:text-emerald-300 transition-colors" onclick={checkForUpdates}>
								<CheckCircle2 class="w-3.5 h-3.5" />
								{m.settings_about_up_to_date()}
							</button>
						{:else if updateCheckError}
							<button class="flex items-center gap-1 text-xs text-foreground hover:text-muted-foreground transition-colors" onclick={checkForUpdates} title={updateCheckError}>
								<TriangleAlert class="w-3.5 h-3.5 shrink-0" />
								{m.settings_about_update_check_unavailable()}
							</button>
						{/if}
					</div>

					<!-- Build & Uptime Info -->
					<div class="flex items-center gap-4 text-xs text-muted-foreground">
						{#if BUILD_BRANCH}
							<div class="flex items-center gap-1">
								<GitBranch class="w-3 h-3" />
								<span>{BUILD_BRANCH}</span>
							</div>
						{/if}
						{#if BUILD_COMMIT}
							<div class="flex items-center gap-1">
								<Code class="w-3 h-3" />
								<span>{BUILD_COMMIT.slice(0, 7)}{#if BUILD_DATE}&nbsp;({formatBuildDate(BUILD_DATE)}){/if}</span>
							</div>
						{/if}
						{#if serverUptime !== null}
							<div class="flex items-center gap-1 min-w-[8.5rem]">
								<Clock class="w-3 h-3 shrink-0" />
								<span class="tabular-nums">{m.settings_about_uptime({ uptime: formatUptime(serverUptime) })}</span>
							</div>
						{/if}
					</div>

					<!-- Description -->
					<p class="text-sm text-muted-foreground tagline-text {taglineAnimating ? 'tagline-zoom' : ''}">
						{TAGLINES[taglineIndex]()}
					</p>

					<!-- Website Link -->
					<a href="https://dockhand.pro" target="_blank" rel="noopener noreferrer" class="text-sm text-primary hover:underline">
						https://dockhand.pro
					</a>
				</div>
			</Card.Content>
		</Card.Root>

		<!-- System Stats Card (Right) -->
		<Card.Root class="w-full h-full">
			<Card.Header class="pb-2">
				<Card.Title class="text-sm font-medium">{m.settings_about_system_information()}</Card.Title>
			</Card.Header>
			<Card.Content>
				{#if loading}
					<div class="flex items-center justify-center py-6">
						<div class="text-sm text-muted-foreground">{m.settings_about_loading()}</div>
					</div>
				{:else if error}
					<div class="flex items-center justify-center py-6">
						<div class="text-sm text-destructive">{error}</div>
					</div>
				{:else if systemInfo}
					<div class="space-y-3">
						{#if systemInfo.docker}
						<!-- Docker Info -->
						<div class="space-y-1.5">
							<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<Server class="w-3.5 h-3.5" />
								Docker
							</div>
							<div class="text-sm pl-5 space-y-0.5">
								<div class="flex items-center gap-2">
									<span class="text-muted-foreground">{m.settings_about_version()}</span>
									<span>{systemInfo.docker.version}</span>
									<span class="text-muted-foreground/50">|</span>
									<span class="text-muted-foreground">API</span>
									<span>{systemInfo.docker.apiVersion}</span>
									<span class="text-muted-foreground/50">|</span>
									<span class="text-muted-foreground">OS/Arch</span>
									<span>{systemInfo.docker.os}/{systemInfo.docker.arch}</span>
								</div>
							</div>
						</div>

						<!-- Connection Info -->
						<div class="space-y-1.5">
							<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<Plug class="w-3.5 h-3.5" />
								{m.settings_about_connection()}
							</div>
							<div class="text-sm pl-5">
								<div class="flex items-center gap-2 flex-wrap">
									{#if systemInfo.docker.connection.type === 'socket'}
										<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400 shadow-sm ring-1 ring-violet-500/20">
											{m.settings_about_unix_socket()}
										</span>
										<span class="text-xs font-mono text-muted-foreground">{systemInfo.docker.connection.socketPath}</span>
									{:else if systemInfo.docker.connection.type === 'https'}
										<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/15 text-green-600 dark:text-green-400 shadow-sm ring-1 ring-green-500/20">
											HTTPS (TLS)
										</span>
										<span class="text-xs font-mono text-muted-foreground">{systemInfo.docker.connection.host}:{systemInfo.docker.connection.port}</span>
									{:else}
										<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 shadow-sm ring-1 ring-amber-500/20">
											HTTP
										</span>
										<span class="text-xs font-mono text-muted-foreground">{systemInfo.docker.connection.host}:{systemInfo.docker.connection.port}</span>
									{/if}
								</div>
							</div>
						</div>

						<!-- Host Info -->
						<div class="space-y-1.5">
							<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<Cpu class="w-3.5 h-3.5" />
								{m.settings_about_host()}
							</div>
							<div class="text-sm pl-5">
								<div class="flex items-center gap-2">
									<span class="text-muted-foreground">{m.settings_about_name()}</span>
									<span>{systemInfo.host.name}</span>
									<span class="text-muted-foreground/50">|</span>
									<span class="text-muted-foreground">{m.settings_about_cpus()}</span>
									<span>{systemInfo.host.cpus}</span>
									<span class="text-muted-foreground/50">|</span>
									<span class="text-muted-foreground">{m.settings_about_memory()}</span>
									<span>{formatBytes(systemInfo.host.memory)}</span>
								</div>
							</div>
						</div>
						{/if}

						<!-- Runtime Info -->
						<div class="space-y-1.5">
							<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<Cpu class="w-3.5 h-3.5" />
								{m.settings_about_runtime()}
							</div>
							<div class="text-sm pl-5">
								<div class="flex items-center gap-2 flex-wrap">
									{#if systemInfo.runtime.runtimeVersion}
										<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/15 text-green-600 dark:text-green-400 shadow-sm ring-1 ring-green-500/20">
											{systemInfo.runtime.runtimeName} {systemInfo.runtime.runtimeVersion}
										</span>
									{/if}
									<span class="text-muted-foreground/50">|</span>
									<Server class="w-3 h-3 text-muted-foreground" />
									<span>{systemInfo.runtime.platform}/{systemInfo.runtime.arch}</span>
									<span class="text-muted-foreground/50">|</span>
									<Cpu class="w-3 h-3 text-muted-foreground" />
									<span>{systemInfo.runtime.kernel}</span>
									<span class="text-muted-foreground/50">|</span>
									<MemoryStick class="w-3 h-3 text-muted-foreground" />
									<span>{formatBytes(systemInfo.runtime.memory.rss)}</span>
								</div>
								{#if systemInfo.runtime.container.inContainer}
								<div class="flex items-center gap-2 flex-wrap mt-1">
									<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-blue-500/20">
										{systemInfo.runtime.container.runtime || m.settings_about_container()}
									</span>
									{#if systemInfo.runtime.ownContainer}
										<span class="text-xs font-mono text-muted-foreground">{systemInfo.runtime.ownContainer.image}</span>
									{/if}
									{#if systemInfo.docker}
										<span class="text-muted-foreground/50">|</span>
										<span class="text-muted-foreground">Docker</span>
										<span>{systemInfo.docker.version}</span>
									{/if}
								</div>
								{/if}
							</div>
						</div>

						<!-- Database Info -->
						<div class="space-y-1.5">
							<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<Database class="w-3.5 h-3.5" />
								{m.settings_about_database()}
							</div>
							<div class="text-sm pl-5 space-y-1">
								<div class="flex items-center gap-2 flex-wrap">
									{#if systemInfo.database.type === 'PostgreSQL'}
										<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-blue-500/20">
											PostgreSQL
										</span>
										{#if systemInfo.database.host}
											<span class="text-muted-foreground/50">|</span>
											<span class="text-xs">{systemInfo.database.host}:{systemInfo.database.port}</span>
										{/if}
									{:else}
										<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shadow-sm ring-1 ring-emerald-500/20">
											SQLite
										</span>
									{/if}
								</div>
								{#if systemInfo.database.schemaVersion}
									<div class="flex items-center gap-2">
										<span class="text-muted-foreground">{m.settings_about_schema()}</span>
										<span class="font-mono text-xs">{systemInfo.database.schemaVersion}</span>
										{#if systemInfo.database.schemaDate}
											<span class="text-muted-foreground/60 text-xs">({systemInfo.database.schemaDate})</span>
										{/if}
									</div>
								{/if}
							</div>
						</div>

						<!-- License Info -->
						<div class="space-y-1.5">
							<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								{#if $licenseStore.licenseType === 'enterprise'}
									<Crown class="w-3.5 h-3.5" />
								{:else if $licenseStore.licenseType === 'smb'}
									<Building2 class="w-3.5 h-3.5" />
								{:else}
									<Crown class="w-3.5 h-3.5" />
								{/if}
								{m.settings_about_license()}
							</div>
							<div class="text-sm pl-5">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="text-muted-foreground">{m.settings_about_edition()}</span>
									{#if $licenseStore.licenseType === 'enterprise'}
										<span class="text-amber-500 font-medium flex items-center gap-1">
											<Crown class="w-3.5 h-3.5 fill-current" />
											Enterprise
										</span>
									{:else if $licenseStore.licenseType === 'smb'}
										<span class="text-blue-500 font-medium flex items-center gap-1">
											<Building2 class="w-3.5 h-3.5" />
											SMB
										</span>
									{:else}
										<span>Community</span>
									{/if}
									{#if $licenseStore.isLicensed && $licenseStore.licensedTo}
										<span class="text-muted-foreground/50">|</span>
										<span class="text-muted-foreground">{m.settings_license_licensed_to()}</span>
										<span>{$licenseStore.licensedTo}</span>
									{/if}
									<span class="text-muted-foreground/50">|</span>
									<button class="text-primary hover:underline cursor-pointer" onclick={() => showLicenseModal = true}>{m.settings_about_terms()}</button>
									<span class="text-muted-foreground/50">|</span>
									<button class="text-primary hover:underline cursor-pointer" onclick={() => showPrivacyModal = true}>{m.settings_about_privacy()}</button>
								</div>
								<div class="flex items-center gap-2 flex-wrap mt-3 pt-2 border-t border-border/50">
									<a href="https://github.com/Finsys/dockhand/issues" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline inline-flex items-center gap-1.5 font-medium">
										<MessageSquarePlus class="w-4 h-4" />
										{m.settings_about_submit_issue()}
									</a>
									<span class="text-muted-foreground/50">|</span>
									<a href="https://discord.gg/rMxW9Y5cQw" target="_blank" rel="noopener noreferrer" class="hover:underline inline-flex items-center gap-1.5 font-medium text-indigo-500 dark:text-indigo-400">
										<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
										Discord
									</a>
									{#if !$licenseStore.isLicensed}
										<span class="text-muted-foreground/50">|</span>
										<a href="https://buymeacoffee.com/dockhand" target="_blank" rel="noopener noreferrer" class="hover:underline inline-flex items-center gap-1.5 font-medium text-amber-600 dark:text-yellow-400">
											<Coffee class="w-4 h-4" />
											{m.settings_about_buy_coffee()}
										</a>
									{/if}
								</div>
								{#if !$licenseStore.isLicensed}
									<p class="text-xs text-muted-foreground mt-2">{m.settings_about_community_note()}</p>
								{/if}
							</div>
						</div>

						{#if systemInfo.docker}
						<!-- Resource Stats -->
						<div class="grid grid-cols-5 gap-2 pt-3">
							<div class="stat-box stat-box-blue">
								<div class="stat-icon-wrapper bg-blue-500/10">
									<Box class="w-4 h-4 text-blue-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.containers.total}</div>
								<div class="text-2xs text-muted-foreground font-medium">{m.nav_containers()}</div>
							</div>
							<div class="stat-box stat-box-cyan">
								<div class="stat-icon-wrapper bg-cyan-500/10">
									<Layers class="w-4 h-4 text-cyan-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.stacks}</div>
								<div class="text-2xs text-muted-foreground font-medium">{m.nav_stacks()}</div>
							</div>
							<div class="stat-box stat-box-purple">
								<div class="stat-icon-wrapper bg-purple-500/10">
									<Images class="w-4 h-4 text-purple-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.images}</div>
								<div class="text-2xs text-muted-foreground font-medium">{m.nav_images()}</div>
							</div>
							<div class="stat-box stat-box-green">
								<div class="stat-icon-wrapper bg-green-500/10">
									<HardDrive class="w-4 h-4 text-green-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.volumes}</div>
								<div class="text-2xs text-muted-foreground font-medium">{m.nav_volumes()}</div>
							</div>
							<div class="stat-box stat-box-orange">
								<div class="stat-icon-wrapper bg-orange-500/10">
									<Network class="w-4 h-4 text-orange-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.networks}</div>
								<div class="text-2xs text-muted-foreground font-medium">{m.nav_networks()}</div>
							</div>
						</div>
						{/if}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<!-- Releases & Dependencies Card with Tabs -->
	<Card.Root class="w-full mt-4">
		<Tabs.Root bind:value={activeTab} class="w-full">
			<div class="px-4 pt-4">
				<Tabs.List class="w-full grid grid-cols-2">
					<Tabs.Trigger value="releases" class="flex items-center gap-2">
						<FileText class="w-4 h-4" />
						<span>{m.settings_about_release_notes()}</span>
						<Badge variant="secondary" class="text-2xs">{changelog.length}</Badge>
					</Tabs.Trigger>
					<Tabs.Trigger value="dependencies" class="flex items-center gap-2">
						<Package class="w-4 h-4" />
						<span>{m.settings_about_dependencies()}</span>
						<Badge variant="secondary" class="text-2xs">{dependencies.length}</Badge>
					</Tabs.Trigger>
				</Tabs.List>
			</div>

			<Tabs.Content value="releases" class="px-4 pb-4">
				{#if loadingChangelog}
					<div class="flex items-center justify-center py-8">
						<div class="text-sm text-muted-foreground">{m.settings_about_loading_releases()}</div>
					</div>
				{:else if changelogError}
					<div class="flex items-center justify-center py-8">
						<div class="text-sm text-destructive">{changelogError}</div>
					</div>
				{:else}
					<div class="space-y-2 max-h-[400px] overflow-y-auto pr-2">
						{#each changelog as release, index}
							{@const isExpanded = expandedReleases.has(index)}
							<div class="border rounded-lg {index === 0 ? 'border-primary/30 bg-primary/5' : ''}">
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="flex items-center justify-between p-3 cursor-pointer hover:bg-muted/50 rounded-lg transition-colors"
									onclick={() => toggleRelease(index)}
								>
									<div class="flex items-center gap-2">
										{#if isExpanded}
											<ChevronDown class="w-4 h-4 text-muted-foreground" />
										{:else}
											<ChevronRight class="w-4 h-4 text-muted-foreground" />
										{/if}
										<Tag class="w-4 h-4 text-primary" />
										<span class="font-semibold">v{release.version}</span>
										{#if index === 0}
											<Badge variant="default" class="text-2xs">{m.settings_about_latest()}</Badge>
										{/if}
										<Badge variant="secondary" class="text-2xs">{m.settings_about_changes_count({ count: release.changes.length })}</Badge>
									</div>
									<span class="text-xs text-muted-foreground">{formatChangelogDate(release.date)}</span>
								</div>
								{#if isExpanded}
									<div class="px-4 pb-4">
										<ul class="space-y-1.5 text-sm text-muted-foreground mb-3">
											{#each sortedChanges(release.changes) as change}
												<li class="flex items-start gap-2">
													{#if change.type === 'feature'}
														<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
															<Sparkles class="w-3 h-3" />
															{m.settings_about_change_new()}
														</span>
													{:else if change.type === 'fix'}
														<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">
															<Bug class="w-3 h-3" />
															{m.settings_about_change_fix()}
														</span>
													{/if}
													<ChangelogText text={change.text} />
												</li>
											{/each}
										</ul>
										<div class="flex items-center gap-2 pt-2 border-t">
											<Badge variant="outline" class="text-2xs font-mono">{release.imageTag}</Badge>
										</div>
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</Tabs.Content>

			<Tabs.Content value="dependencies" class="px-4 pb-4">
				<div class="mb-3">
					<SearchInput bind:value={depsSearch} placeholder={m.settings_about_search_dependencies()} class="h-7 text-xs" containerClass="w-full max-w-xs" />
				</div>
				{#if loadingDeps}
					<div class="flex items-center justify-center py-8">
						<div class="text-sm text-muted-foreground">{m.settings_about_loading_dependencies()}</div>
					</div>
				{:else if depsError}
					<div class="flex items-center justify-center py-8">
						<div class="text-sm text-destructive">{depsError}</div>
					</div>
				{:else}
					<div class="space-y-1">
						<div class="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-2xs font-medium text-muted-foreground px-2 py-1 border-b">
							<div>{m.settings_about_package()}</div>
							<div class="w-20 text-center">{m.settings_about_version()}</div>
							<div class="w-24 text-center">{m.settings_about_license()}</div>
							<div class="w-8"></div>
						</div>
						<div class="max-h-[300px] overflow-y-auto pr-2">
							{#each filteredDeps as dep}
								<div class="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-xs px-2 py-1.5 hover:bg-muted/50 rounded items-center">
									<div class="font-mono text-[11px] truncate" title={dep.name}>{dep.name}</div>
									<div class="w-20 text-center">
										<Badge variant="outline" class="text-2xs px-1 py-0 h-4 font-mono">{dep.version}</Badge>
									</div>
									<div class="w-24 text-center">
										<Badge variant="secondary" class="text-2xs px-1.5 py-0 h-4">{dep.license}</Badge>
									</div>
									<div class="w-8 flex justify-center">
										{#if dep.repository}
											<a
												href={dep.repository}
												target="_blank"
												rel="noopener noreferrer"
												class="text-muted-foreground hover:text-foreground transition-colors"
												title={m.settings_about_view_on_github()}
											>
												<ExternalLink class="w-3.5 h-3.5" />
											</a>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</Tabs.Content>
		</Tabs.Root>
	</Card.Root>

</div>

<LicenseModal bind:open={showLicenseModal} />
<PrivacyModal bind:open={showPrivacyModal} />

{#if updateInfo}
	<SelfUpdateDialog
		bind:open={showSelfUpdateDialog}
		currentImage={updateInfo.currentImage}
		newImage={updateInfo.newImage}
		currentDigest={updateInfo.currentDigest}
		newDigest={updateInfo.newDigest}
		containerName={updateInfo.containerName}
		isComposeManaged={updateInfo.isComposeManaged}
		latestVersion={updateInfo.latestVersion}
		onclose={() => showSelfUpdateDialog = false}
	/>
{/if}
