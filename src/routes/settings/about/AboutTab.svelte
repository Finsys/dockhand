<script lang="ts">
	// Trigger rebuild for debug logging changes
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Box, Images, HardDrive, Network, Cpu, Server, Crown, Building2, Layers, Clock, Code, Package, ExternalLink, Search, FileText, Tag, Sparkles, Bug, ChevronDown, ChevronRight, Plug, ScrollText, Shield, MessageSquarePlus, GitBranch, Coffee, Monitor, Cog, MemoryStick, Database, CircleArrowUp, Loader2, CheckCircle2 } from 'lucide-svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import { onMount, onDestroy } from 'svelte';
	import { licenseStore } from '$lib/stores/license';
	import { browser } from '$app/environment';
	import LicenseModal from './LicenseModal.svelte';
	import PrivacyModal from './PrivacyModal.svelte';
	import SelfUpdateDialog from './SelfUpdateDialog.svelte';

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
	const currentVersion = __APP_VERSION__ || 'unknown';

	const filteredDeps = $derived(
		dependencies.filter(dep =>
			dep.name.toLowerCase().includes(depsSearch.toLowerCase()) ||
			dep.license.toLowerCase().includes(depsSearch.toLowerCase())
		)
	);

	async function fetchDependencies() {
		try {
			const res = await fetch('/api/dependencies');
			if (!res.ok) throw new Error('Failed to fetch dependencies');
			dependencies = await res.json();
		} catch (e) {
			depsError = e instanceof Error ? e.message : 'Unknown error';
		} finally {
			loadingDeps = false;
		}
	}

	async function fetchChangelog() {
		try {
			const res = await fetch('/api/changelog');
			if (!res.ok) throw new Error('Failed to fetch changelog');
			changelog = await res.json();
		} catch (e) {
			changelogError = e instanceof Error ? e.message : 'Unknown error';
		} finally {
			loadingChangelog = false;
		}
	}

	function formatChangelogDate(dateStr: string): string {
		try {
			const date = new Date(dateStr);
			return date.toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'long',
				day: 'numeric'
			});
		} catch {
			return dateStr;
		}
	}

	// Build info - injected at build time
	declare const __BUILD_BRANCH__: string | null;
	const BUILD_DATE = __BUILD_DATE__ ?? null;
	const BUILD_COMMIT = __BUILD_COMMIT__ ?? null;
	const BUILD_BRANCH = __BUILD_BRANCH__ ?? null;

	const TAGLINES = [
		"Simplify. Deploy. Smile.",
		"Less typing. More shipping.",
		"Taming containers so you don't have to wrestle whales.",
		"Docker management, minus the sea monsters.",
		"Because wrangling containers shouldn't feel like open-heart surgery.",
		"One interface to rule your containers (and your sanity).",
		"CLI fatigue is real. We treat it.",
		"Automate, orchestrate, hydrate — we handle the first two.",
		"Turning docker ps into pure bliss.",
		"Your API deserves better than bash therapy.",
		"Where DevOps takes a deep breath.",
		"Zero friction. Just containers.",
		"Simplify. Deploy. Smile.",
		"Because even the whale needs a handler.",
		"From chaos to compose — elegantly.",
		"No sea-sickness. Just smooth shipping.",
		"Your Docker daemon's spirit guide.",
		"Stop speaking whale. Start managing Docker like a human.",
		"Because docker ps shouldn't be a lifestyle.",
		"Your containers deserve better than shell scripts and stress.",
		"We make your Docker behave — no magic flags required.",
		"From jumbled YAMLs to zen-like order.",
		"When your containers listen the first time.",
		"Control the chaos, skip the CLI yoga.",
		"Docker wrangling for the rest of us.",
		"Making containers civilized since version 1.0.",
		"Less whale-wrestling, more shipping.",
		"Calm seas for every deployment.",
		"No drama, just Docker.",
		"Docker management, distilled.",
		"Smooth orchestration. Zero overhead.",
		"Build. Ship. Chill.",
		"Think less. Deploy faster.",
		"Total control — no keyboard acrobatics.",
		"Because you've got better things to grep for.",
		"No more container existential crises.",
		"CLI fatigue? We prescribe automation.",
		"One app to outsmart your bash history.",
		"Making Docker less dockery since forever.",
		"Because Docker shouldn't require a PhD in bash.",
		"Your containers. Less chaos, more chill.",
		"Stop copy-pasting the same docker ps | grep again.",
		"Finally, a Docker UI that doesn't feel like punishment.",
		"We speak fluent container, so you don't have to.",
		"Bringing dignity back to Docker management.",
		"For when you love Docker but hate Docker.",
		"Automation for humans who still like buttons.",
		"Taming your containers without taming your spirit.",
		"No more whales in your workflow.",
		"Keeping your containers in line since this morning.",
		"Because every DevOps deserves a day off.",
		"Serious about containers. Not about suffering.",
		"Work smarter, not docker-harder.",
		"Made for people who break prod responsibly.",
		"Turning Docker discipline into an art form.",
		"Your shortcut to shipping sanity.",
		"Zero friction. Infinite containers.",
		"Less yak-shaving, more image-pulling.",
		"Because scripts age like milk.",
		"CLI acrobatics are so 2020.",
		"Containers behave. Developers rejoice.",
		"Finally, a tool that respects your time and your terminal."
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
			bun: string | null;
			bunRevision: string | null;
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
				updateCheckError = 'Failed to check for updates';
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

			if (data.updateAvailable) {
				updateInfo = {
					currentImage: data.currentImage,
					newImage: data.currentImage,
					currentDigest: data.currentDigest || '',
					newDigest: data.newDigest || '',
					containerName: data.containerName,
					isComposeManaged: data.isComposeManaged
				};
			}
		} catch (err) {
			updateCheckError = 'Check failed: ' + String(err);
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
			return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
		} else {
			return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
		}
	}

	function formatBuildDate(dateStr: string | null): string {
		if (!dateStr) return 'Development';
		try {
			const date = new Date(dateStr);
			return date.toLocaleDateString('en-US', {
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

	function formatBytes(bytes: number): string {
		const gb = bytes / (1024 * 1024 * 1024);
		return `${gb.toFixed(1)} GB`;
	}

	async function fetchSystemInfo() {
		try {
			const [systemRes, hostRes] = await Promise.all([
				fetch('/api/system'),
				fetch('/api/host')
			]);
			if (!systemRes.ok) throw new Error('Failed to fetch system info');
			systemInfo = await systemRes.json();

			if (hostRes.ok) {
				const hostData = await hostRes.json();
				serverUptime = hostData.uptime;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unknown error';
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
							src="/logo-light.webp"
							alt="Dockhand Logo"
							class="h-36 w-auto object-contain dark:hidden"
							style="filter: drop-shadow(1px 1px 2px rgba(0,0,0,0.3)) drop-shadow(-1px -1px 1px rgba(255,255,255,0.9));"
						/>
						<img
							src="/logo-dark.webp"
							alt="Dockhand Logo"
							class="h-36 w-auto object-contain hidden dark:block"
							style="filter: drop-shadow(2px 2px 3px rgba(0,0,0,0.6)) drop-shadow(-1px -1px 1px rgba(255,255,255,0.2));"
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
								Stop already, will you? Coming from r/selfhosted?
							</div>
						{/if}
					</div>

					<!-- Version Badge + Update Check -->
					<div class="flex flex-col items-center gap-1">
						<Badge variant="secondary" class="text-xs">Version {currentVersion}</Badge>
						{#if checkingUpdate}
							<span class="flex items-center gap-1 text-xs text-muted-foreground">
								<Loader2 class="w-3.5 h-3.5 animate-spin" />
								Checking for updates...
							</span>
						{:else if updateAvailable && updateInfo}
							<button class="flex items-center gap-1 text-xs text-amber-500 hover:text-amber-400 transition-colors" onclick={() => showSelfUpdateDialog = true}>
								<CircleArrowUp class="w-3.5 h-3.5" />
								Update available — click to see what's new
							</button>
						{:else if updateCheckDone && !updateAvailable}
							<button class="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-500 dark:hover:text-emerald-300 transition-colors" onclick={checkForUpdates}>
								<CheckCircle2 class="w-3.5 h-3.5" />
								Up to date
							</button>
						{:else if updateCheckError}
							<button class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors" onclick={checkForUpdates} title={updateCheckError}>
								Check for updates
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
								<span class="tabular-nums">Uptime {formatUptime(serverUptime)}</span>
							</div>
						{/if}
					</div>

					<!-- Description -->
					<p class="text-sm text-muted-foreground tagline-text {taglineAnimating ? 'tagline-zoom' : ''}">
						{TAGLINES[taglineIndex]}
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
				<Card.Title class="text-sm font-medium">System information</Card.Title>
			</Card.Header>
			<Card.Content>
				{#if loading}
					<div class="flex items-center justify-center py-6">
						<div class="text-sm text-muted-foreground">Loading...</div>
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
									<span class="text-muted-foreground">Version</span>
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
								Connection
							</div>
							<div class="text-sm pl-5">
								<div class="flex items-center gap-2 flex-wrap">
									{#if systemInfo.docker.connection.type === 'socket'}
										<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400 shadow-sm ring-1 ring-violet-500/20">
											Unix Socket
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
								Host
							</div>
							<div class="text-sm pl-5">
								<div class="flex items-center gap-2">
									<span class="text-muted-foreground">Name</span>
									<span>{systemInfo.host.name}</span>
									<span class="text-muted-foreground/50">|</span>
									<span class="text-muted-foreground">CPUs</span>
									<span>{systemInfo.host.cpus}</span>
									<span class="text-muted-foreground/50">|</span>
									<span class="text-muted-foreground">Memory</span>
									<span>{formatBytes(systemInfo.host.memory)}</span>
								</div>
							</div>
						</div>
						{/if}

						<!-- Runtime Info -->
						<div class="space-y-1.5">
							<div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
								<Cpu class="w-3.5 h-3.5" />
								Runtime
							</div>
							<div class="text-sm pl-5">
								<div class="flex items-center gap-2 flex-wrap">
									{#if systemInfo.runtime.bun}
										<span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 shadow-sm ring-1 ring-amber-500/20">
											Bun {systemInfo.runtime.bun}
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
										{systemInfo.runtime.container.runtime || 'Container'}
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
								Database
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
										<span class="text-muted-foreground">Schema</span>
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
								License
							</div>
							<div class="text-sm pl-5">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="text-muted-foreground">Edition</span>
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
										<span class="text-muted-foreground">Licensed to</span>
										<span>{$licenseStore.licensedTo}</span>
									{/if}
									<span class="text-muted-foreground/50">|</span>
									<button class="text-primary hover:underline cursor-pointer" onclick={() => showLicenseModal = true}>Terms</button>
									<span class="text-muted-foreground/50">|</span>
									<button class="text-primary hover:underline cursor-pointer" onclick={() => showPrivacyModal = true}>Privacy</button>
								</div>
								<div class="flex items-center gap-2 flex-wrap mt-3 pt-2 border-t border-border/50">
									<a href="https://github.com/Finsys/dockhand/issues" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline inline-flex items-center gap-1.5 font-medium">
										<MessageSquarePlus class="w-4 h-4" />
										Submit issue or idea
									</a>
									{#if !$licenseStore.isLicensed}
										<span class="text-muted-foreground/50">|</span>
										<a href="https://buymeacoffee.com/dockhand" target="_blank" rel="noopener noreferrer" class="hover:underline inline-flex items-center gap-1.5 font-medium text-amber-600 dark:text-yellow-400">
											<Coffee class="w-4 h-4" />
											Buy me a coffee
										</a>
									{/if}
								</div>
								{#if !$licenseStore.isLicensed}
									<p class="text-xs text-muted-foreground mt-2">Dockhand Community Edition is free and always will be. No strings attached. Like it? Fuel the dev with caffeine.</p>
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
								<div class="text-2xs text-muted-foreground font-medium">Containers</div>
							</div>
							<div class="stat-box stat-box-cyan">
								<div class="stat-icon-wrapper bg-cyan-500/10">
									<Layers class="w-4 h-4 text-cyan-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.stacks}</div>
								<div class="text-2xs text-muted-foreground font-medium">Stacks</div>
							</div>
							<div class="stat-box stat-box-purple">
								<div class="stat-icon-wrapper bg-purple-500/10">
									<Images class="w-4 h-4 text-purple-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.images}</div>
								<div class="text-2xs text-muted-foreground font-medium">Images</div>
							</div>
							<div class="stat-box stat-box-green">
								<div class="stat-icon-wrapper bg-green-500/10">
									<HardDrive class="w-4 h-4 text-green-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.volumes}</div>
								<div class="text-2xs text-muted-foreground font-medium">Volumes</div>
							</div>
							<div class="stat-box stat-box-orange">
								<div class="stat-icon-wrapper bg-orange-500/10">
									<Network class="w-4 h-4 text-orange-500" />
								</div>
								<div class="text-lg font-bold">{systemInfo.stats.networks}</div>
								<div class="text-2xs text-muted-foreground font-medium">Networks</div>
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
						<span>Release notes</span>
						<Badge variant="secondary" class="text-2xs">{changelog.length}</Badge>
					</Tabs.Trigger>
					<Tabs.Trigger value="dependencies" class="flex items-center gap-2">
						<Package class="w-4 h-4" />
						<span>Dependencies</span>
						<Badge variant="secondary" class="text-2xs">{dependencies.length}</Badge>
					</Tabs.Trigger>
				</Tabs.List>
			</div>

			<Tabs.Content value="releases" class="px-4 pb-4">
				{#if loadingChangelog}
					<div class="flex items-center justify-center py-8">
						<div class="text-sm text-muted-foreground">Loading releases...</div>
					</div>
				{:else if changelogError}
					<div class="flex items-center justify-center py-8">
						<div class="text-sm text-destructive">{changelogError}</div>
					</div>
				{:else}
					<div class="space-y-2 max-h-[400px] overflow-y-auto">
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
											<Badge variant="default" class="text-2xs">Latest</Badge>
										{/if}
										<Badge variant="secondary" class="text-2xs">{release.changes.length} changes</Badge>
									</div>
									<span class="text-xs text-muted-foreground">{formatChangelogDate(release.date)}</span>
								</div>
								{#if isExpanded}
									<div class="px-4 pb-4">
										<ul class="space-y-1.5 text-sm text-muted-foreground mb-3">
											{#each release.changes as change}
												<li class="flex items-start gap-2">
													{#if change.type === 'feature'}
														<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
															<Sparkles class="w-3 h-3" />
															New
														</span>
													{:else if change.type === 'fix'}
														<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">
															<Bug class="w-3 h-3" />
															Fix
														</span>
													{/if}
													<span>{change.text}</span>
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
					<div class="relative w-full max-w-xs">
						<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
						<Input
							type="text"
							placeholder="Search packages or licenses..."
							class="h-7 text-xs pl-7"
							bind:value={depsSearch}
						/>
					</div>
				</div>
				{#if loadingDeps}
					<div class="flex items-center justify-center py-8">
						<div class="text-sm text-muted-foreground">Loading dependencies...</div>
					</div>
				{:else if depsError}
					<div class="flex items-center justify-center py-8">
						<div class="text-sm text-destructive">{depsError}</div>
					</div>
				{:else}
					<div class="space-y-1">
						<div class="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-2xs font-medium text-muted-foreground px-2 py-1 border-b">
							<div>Package</div>
							<div class="w-20 text-center">Version</div>
							<div class="w-24 text-center">License</div>
							<div class="w-8"></div>
						</div>
						<div class="max-h-[300px] overflow-y-auto">
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
												title="View on GitHub"
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
		onclose={() => showSelfUpdateDialog = false}
	/>
{/if}
