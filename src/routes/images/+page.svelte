<svelte:head>
	<title>Images - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Tabs from '$lib/components/ui/tabs';
	import VulnerabilitiesTab from './VulnerabilitiesTab.svelte';
	import VulnerabilityScanModal from './VulnerabilityScanModal.svelte';
	import type { Finding as VulnFinding, VulnerabilitySummary as VulnSummary, SortField as VulnSortField } from '$lib/utils/vulnerability';
	import { EMPTY_SUMMARY } from '$lib/utils/vulnerability';
	import { createWindowedList } from '$lib/utils/windowed-list.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Trash2, Upload, RefreshCw, Play, Search, Layers, Server, ShieldCheck, ShieldAlert, Shield, ShieldQuestion, CheckSquare, Square, Tag, Check, XCircle, Icon, AlertTriangle, X, Images, Copy, Download, ChevronRight, ChevronDown, Loader2, ArrowUp, ArrowDown, ArrowUpDown, CircleDashed, CircleDot, Circle, Filter, FileJson, FileSpreadsheet, ShieldPlus } from 'lucide-svelte';
	import { broom, whale } from '@lucide/lab';
	import { formatBytes } from '$lib/utils/format';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { buildPinnedRef, shortDigest } from '$lib/utils/pinned-ref';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import BatchOperationModal from '$lib/components/BatchOperationModal.svelte';
	import ImageHistoryModal from './ImageHistoryModal.svelte';
	import ImageScanModal from './ImageScanModal.svelte';
	import PushToRegistryModal from './PushToRegistryModal.svelte';
	import ImagePullModal from '$lib/components/ImagePullModal.svelte';
	import type { ImageInfo } from '$lib/types';
	import { currentEnvironment, environments, appendEnvParam, clearStaleEnvironment } from '$lib/stores/environment';
	import CreateContainerModal from '../containers/CreateContainerModal.svelte';
	import { onDockerEvent, isImageListChange } from '$lib/stores/events';
	import { canAccess } from '$lib/stores/auth';
	import { formatDate, appSettings } from '$lib/stores/settings';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import { EmptyState, NoEnvironment } from '$lib/components/ui/empty-state';
	import TabbedPageHeader from '$lib/components/TabbedPageHeader.svelte';
	import MultiSelectFilter from '$lib/components/MultiSelectFilter.svelte';
	import { DataGrid } from '$lib/components/data-grid';
	import type { DataGridSortState } from '$lib/components/data-grid/types';

	let { data } = $props();

	type SortField = 'name' | 'size' | 'created' | 'tags';
	type SortDirection = 'asc' | 'desc';

	interface Registry {
		id: number;
		name: string;
		url: string;
		hasCredentials: boolean;
		is_default: boolean;
	}

	interface GroupedImage {
		repoName: string;
		tags: Array<{
			tag: string;
			fullRef: string;
			imageId: string;
			/** `repo:tag@sha256:...` for the "copy pinned reference" action, or null if the image has no digest. */
			pinnedRef: string | null;
			/** Shortened `sha256:...` shown next to the tag, or null. */
			digestShort: string | null;
			size: number;
			created: number;
			containers: number;
		}>;
		totalSize: number;
		latestCreated: number;
		imageIds: Set<string>;
		containers: number;
	}

	// Check if a registry is Docker Hub
	function isDockerHub(registry: Registry): boolean {
		const url = registry.url.toLowerCase();
		return url.includes('docker.io') ||
			   url.includes('hub.docker.com') ||
			   url.includes('registry.hub.docker.com');
	}

	let images = $state<ImageInfo[]>([]);
	let loading = $state(true);
	let envId = $state<number | null>(null);

	// Polling interval - module scope for cleanup in onDestroy
	let refreshInterval: ReturnType<typeof setInterval> | null = null;
	let unsubscribeDockerEvent: (() => void) | null = null;

	// Registry state
	let registries = $state<Registry[]>([]);

	// Push modal state
	let showPushModal = $state(false);
	let pushingImage = $state<{ id: string; tag: string } | null>(null);

	// Pull modal state
	let showPullModal = $state(false);

	// Load-from-tar state
	let loadFileInput = $state<HTMLInputElement | null>(null);
	let loadingImage = $state(false);

	async function handleLoadTar(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // reset so re-selecting the same file fires change again
		if (!file) return;

		loadingImage = true;
		const t = toast.loading(`Loading ${file.name}...`);
		try {
			// Stream the file body straight to the endpoint (no in-memory copy).
			const response = await fetch(appendEnvParam('/api/images/load', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-tar' },
				body: file
			});
			const data = await response.json();
			if (data?.success) {
				toast.success(data.loaded || `Loaded image from ${file.name}`, { id: t });
				await fetchImages();
			} else {
				toast.error(data?.error || 'Failed to load image', { id: t });
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to load image', { id: t });
		} finally {
			loadingImage = false;
		}
	}

	// Run modal state
	let showRunModal = $state(false);
	let prefilledImage = $state('');

	// History modal state
	let showHistoryModal = $state(false);
	let historyImageId = $state('');
	let historyImageName = $state('');

	// Scan modal state
	let showScanModal = $state(false);
	let scanImageName = $state('');

	// Scanner settings (loaded per-environment)
	let scannerEnabled = $state(false);

	// Vulnerability findings use a server-fetched sliding window (createWindowedList)
	// so the browser only ever holds ~windowSize rows regardless of env size.
	let vulnSummary = $state<VulnSummary>({ ...EMPTY_SUMMARY });
	let vulnFetched = $state(false); // has the tab been opened + first window fetched
	let showVulnScanModal = $state(false);

	const vulnList = createWindowedList<VulnFinding>({
		windowSize: 400,
		onError: (e) => console.error('Failed to load vulnerabilities:', e),
		fetchPage: async (offset, limit, signal) => {
			// Mark the tab as "opened" up front so a failed load doesn't leave the
			// lazy-load effect re-firing in a tight retry loop (it gates on !vulnFetched).
			vulnFetched = true;
			const res = await fetch(`/api/vulnerabilities?${vulnQueryParams(offset, limit)}`, { signal });
			if (!res.ok) throw new Error(`Failed to load vulnerabilities (${res.status})`);
			const data = await res.json();
			// The paged response carries a filtered summary — update the header pills so
			// the severity counts + total reflect the active filters, not the env total.
			if (data.summary) vulnSummary = data.summary;
			return { items: data.findings ?? [], total: data.total ?? 0 };
		}
	});

	// Vulnerabilities toolbar state (owned here so it renders in the header row).
	let vulnSearch = $state('');
	let vulnSeverityFilter = $state<string[]>([]);
	let vulnImageFilter = $state<string[]>([]);
	let vulnContainerFilter = $state<string[]>([]);
	let vulnStackFilter = $state<string[]>([]);
	// Server-driven sort (grid header clicks bubble up and refetch from offset 0).
	let vulnSort = $state<VulnSortField>('severity');
	let vulnDir = $state<'asc' | 'desc'>('asc');

	// Header badge total (from the meta endpoint), shown even from the Images tab.
	let vulnBadgeTotal = $state<number | null>(null);

	// Filter-dropdown options come from the meta endpoint (distinct across the full set).
	let vulnImageOptions = $state<{ value: string; label: string }[]>([]);
	let vulnContainerOptions = $state<{ value: string; label: string }[]>([]);
	let vulnStackOptions = $state<{ value: string; label: string }[]>([]);

	// Header counter: visible row range (from the grid) over the filtered total.
	let vulnVisibleStart = $state(1);
	let vulnVisibleEnd = $state(0);
	function handleVulnRange(start: number, end: number) {
		vulnVisibleStart = start;
		vulnVisibleEnd = end;
	}

	const toOpts = (vals: string[]) => vals.map((v) => ({ value: v, label: v }));

	// Meta (total + filter options) — fetched on env change without pulling findings,
	// so the Images page stays light for users who never open the Vulnerabilities tab.
	async function fetchVulnMeta() {
		if (envId === null) {
			vulnBadgeTotal = null;
			return;
		}
		try {
			const res = await fetch(appendEnvParam('/api/vulnerabilities/count', envId));
			if (res.ok) {
				const data = await res.json();
				vulnBadgeTotal = data.total ?? 0;
				vulnSummary = data.summary ?? vulnSummary;
				vulnImageOptions = toOpts(data.options?.images ?? []);
				vulnContainerOptions = toOpts(data.options?.containers ?? []);
				vulnStackOptions = toOpts(data.options?.stacks ?? []);
			}
		} catch (e) {
			console.error('Failed to load vulnerability meta:', e);
		}
	}

	// Single source of the env + filter + sort params. Both the paged grid fetch
	// and the export URL build on this, so a new filter can't be added to one and
	// silently dropped from the other (export would export a different set).
	function vulnFilterParams(): URLSearchParams {
		const p = new URLSearchParams();
		if (envId !== null) p.set('env', String(envId));
		p.set('sort', vulnSort);
		p.set('dir', vulnDir);
		if (vulnSearch.trim()) p.set('q', vulnSearch.trim());
		if (vulnSeverityFilter.length) p.set('severity', vulnSeverityFilter.join(','));
		if (vulnImageFilter.length) p.set('image', vulnImageFilter.join(','));
		if (vulnContainerFilter.length) p.set('container', vulnContainerFilter.join(','));
		if (vulnStackFilter.length) p.set('stack', vulnStackFilter.join(','));
		return p;
	}

	function vulnQueryParams(offset: number, limit: number): URLSearchParams {
		const p = vulnFilterParams();
		p.set('limit', String(limit));
		p.set('offset', String(offset));
		return p;
	}

	// Reset to the first window (env/filter/sort change). The windowed list owns
	// the window offset, abort/generation guarding, and centering on scroll.
	function fetchVulnerabilities() {
		// Drop the old visible range so a filter/env change that yields fewer (or
		// zero) rows doesn't briefly show a stale "380-400 of 0" until the grid
		// re-emits. The grid only re-emits when it has rows, so an empty result
		// would otherwise keep the last non-zero range.
		vulnVisibleStart = 1;
		vulnVisibleEnd = 0;
		if (envId === null) { vulnList.clear(); vulnFetched = false; return; }
		vulnList.reset();
	}

	// Refresh meta + findings — used by the Refresh button and after a scan completes.
	function refreshVulnerabilities() {
		fetchVulnMeta();
		fetchVulnerabilities();
	}

	// Build an export URL that mirrors the active view (same filters/sort as the
	// grid), then trigger a download. Shares vulnFilterParams() with the grid fetch.
	function exportVulnerabilities(format: 'json' | 'csv' | 'sarif') {
		const params = vulnFilterParams();
		params.set('format', format);
		window.location.href = `/api/vulnerabilities/export?${params.toString()}`;
	}

	const vulnSeverityOptions = [
		{ value: 'critical', label: 'Critical', color: 'text-red-500', icon: ShieldAlert },
		{ value: 'high', label: 'High', color: 'text-orange-500', icon: ShieldAlert },
		{ value: 'medium', label: 'Medium', color: 'text-yellow-600', icon: Shield },
		{ value: 'low', label: 'Low', color: 'text-blue-500', icon: Shield },
		{ value: 'negligible', label: 'Negligible', color: 'text-gray-500', icon: ShieldCheck },
		{ value: 'unknown', label: 'Unknown', color: 'text-gray-500', icon: ShieldQuestion }
	];

	// Tab state (persisted in the URL: /images?tab=vulnerabilities)
	let activeTab = $derived($page.url.searchParams.get('tab') || 'images');
	function handleTabChange(tab: string) {
		goto(`/images?tab=${tab}`, { replaceState: true, noScroll: true });
	}

	// Vulnerabilities header count: on the vuln tab with rows visible → "X-Y of N";
	// otherwise the plain badge total (from the cheap count endpoint).
	const showVulnRange = $derived(activeTab === 'vulnerabilities' && vulnFetched && vulnVisibleEnd > 0);
	const vulnCount = $derived(
		showVulnRange ? `${vulnVisibleStart}-${vulnVisibleEnd}` : (vulnBadgeTotal ?? undefined)
	);
	const vulnCountTotal = $derived(showVulnRange ? vulnList.total : undefined);

	// Search and sort state
	let searchQuery = $state('');
	let sortField = $state<SortField>('created');
	let sortDirection = $state<SortDirection>('desc');

	// Filter state
	type UsageFilter = 'all' | 'in-use' | 'unused' | 'some-unused';
	let usageFilter = $state<UsageFilter>('all');

	// Expanded rows state
	let expandedRepos = $state<Set<string>>(new Set());

	// Confirmation popover state
	let confirmDeleteId = $state<string | null>(null);

	// Delete error state
	let deleteError = $state<{ id: string; message: string } | null>(null);

	// Timeout tracking for cleanup
	let pendingTimeouts: ReturnType<typeof setTimeout>[] = [];

	// Tag modal state
	let showTagModal = $state(false);
	let tagImageId = $state('');
	let tagImageCurrentName = $state('');
	let tagNewRepo = $state('');
	let tagNewTag = $state('latest');
	let tagging = $state(false);

	// Prune state
	let confirmPrune = $state(false);
	let pruneStatus = $state<'idle' | 'pruning' | 'success' | 'error'>('idle');
	let confirmPruneUnused = $state(false);
	let pruneUnusedStatus = $state<'idle' | 'pruning' | 'success' | 'error'>('idle');

	// Multi-select state
	let selectedImages = $state<Set<string>>(new Set());

	// Batch operation modal state
	let showBatchOpModal = $state(false);
	let batchOpTitle = $state('');
	let batchOpOperation = $state('');
	let batchOpItems = $state<Array<{ id: string; name: string }>>([]);
	let batchOpTotalSize = $state<number | undefined>(undefined);

	// Copy ID state
	let copiedId = $state<string | null>(null);
	let copyIdFailed = $state(false);

	async function copyImageId(imageId: string) {
		const ok = await copyToClipboard(imageId);
		if (ok) {
			copiedId = imageId;
			pendingTimeouts.push(setTimeout(() => copiedId = null, 2000));
		} else {
			copyIdFailed = true;
			pendingTimeouts.push(setTimeout(() => copyIdFailed = false, 2000));
		}
	}

	// Copy digest-pinned reference (repo:tag@sha256:...).
	let copiedPinned = $state<string | null>(null);
	async function copyPinnedRef(pinnedRef: string) {
		const ok = await copyToClipboard(pinnedRef);
		if (ok) {
			copiedPinned = pinnedRef;
			pendingTimeouts.push(setTimeout(() => copiedPinned = null, 2000));
		}
	}

	// Export state
	let exportingId = $state<string | null>(null);

	async function exportImage(imageRef: string, imageName: string) {
		exportingId = imageRef;
		try {
			const compress = $appSettings.downloadFormat === 'tar.gz';
			const url = appendEnvParam(`/api/images/${encodeURIComponent(imageName)}/export?compress=${compress}`, envId);

			const link = document.createElement('a');
			link.href = url;
			link.download = '';
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);

			toast.success(`Exporting ${imageName}...`);
		} catch (err) {
			console.error('Failed to export image:', err);
			toast.error(`Failed to export ${imageName}`);
		} finally {
			pendingTimeouts.push(setTimeout(() => {
				if (exportingId === imageRef) exportingId = null;
			}, 2000));
		}
	}

	// Group images by repository name
	const groupedImages = $derived.by(() => {
		const groups = new Map<string, GroupedImage>();

		for (const image of images) {
			if (image.tags.length === 0) {
				// Handle untagged images - try to extract repo name from RepoDigests
				let repoName = '<none>';
				if (image.repoDigests && image.repoDigests.length > 0) {
					// RepoDigests format: "nginx@sha256:abc123" or "registry.example.com/myapp@sha256:abc123"
					const digest = image.repoDigests[0];
					const atIndex = digest.indexOf('@');
					if (atIndex > 0) {
						repoName = digest.slice(0, atIndex);
					}
				}

				const key = repoName;
				if (!groups.has(key)) {
					groups.set(key, {
						repoName,
						tags: [],
						totalSize: 0,
						latestCreated: 0,
						imageIds: new Set(),
						containers: 0
					});
				}
				const group = groups.get(key)!;
				group.tags.push({
					tag: repoName === '<none>' ? image.id.slice(7, 19) : '<none>',
					fullRef: image.id,
					imageId: image.id,
					pinnedRef: buildPinnedRef(repoName, image.repoDigests),
					digestShort: shortDigest(repoName, image.repoDigests),
					size: image.size,
					created: image.created,
					containers: image.containers
				});
				group.totalSize = Math.max(group.totalSize, image.size);
				group.latestCreated = Math.max(group.latestCreated, image.created);
				group.imageIds.add(image.id);
				group.containers += image.containers;
			} else {
				for (const fullTag of image.tags) {
					const colonIndex = fullTag.lastIndexOf(':');
					const repoName = colonIndex > 0 ? fullTag.slice(0, colonIndex) : fullTag;
					const tagPart = colonIndex > 0 ? fullTag.slice(colonIndex + 1) : 'latest';

					if (!groups.has(repoName)) {
						groups.set(repoName, {
							repoName,
							tags: [],
							totalSize: 0,
							latestCreated: 0,
							imageIds: new Set(),
							containers: 0
						});
					}

					const group = groups.get(repoName)!;
					// Avoid duplicate tags
					if (!group.tags.some(t => t.fullRef === fullTag)) {
						group.tags.push({
							tag: tagPart,
							fullRef: fullTag,
							imageId: image.id,
							pinnedRef: buildPinnedRef(fullTag, image.repoDigests),
							digestShort: shortDigest(fullTag, image.repoDigests),
							size: image.size,
							created: image.created,
							containers: image.containers
						});
					}
					group.totalSize = Math.max(group.totalSize, image.size);
					group.latestCreated = Math.max(group.latestCreated, image.created);
					// Only add containers count once per unique image ID
					if (!group.imageIds.has(image.id)) {
						group.containers += image.containers;
					}
					group.imageIds.add(image.id);
				}
			}
		}

		// Sort tags within each group by created date (newest first), with tag name as tiebreaker
		for (const group of groups.values()) {
			group.tags.sort((a, b) => {
				const cmp = b.created - a.created;
				return cmp !== 0 ? cmp : a.tag.localeCompare(b.tag);
			});
		}

		return Array.from(groups.values());
	});

	// Filtered and sorted groups
	const sortedGroups = $derived.by(() => {
		const query = searchQuery.toLowerCase().trim();

		let filtered = groupedImages;

		// Apply usage filter
		if (usageFilter !== 'all') {
			filtered = filtered.filter(group => {
				if (usageFilter === 'in-use') {
					return group.containers > 0;
				}
				if (usageFilter === 'some-unused') {
					// Only images that have BOTH used and unused tags
					return group.containers > 0 && group.tags.some(t => t.containers === 0);
				}
				// 'unused' includes fully unused AND images with some unused tags
				const fullyUnused = group.containers === 0;
				const someUnused = group.tags.length > 1 && group.tags.some(t => t.containers === 0);
				return fullyUnused || someUnused;
			});
		}

		// Apply search filter
		if (query) {
			filtered = filtered.filter(group => {
				if (group.repoName.toLowerCase().includes(query)) return true;
				if (group.tags.some(t => t.tag.toLowerCase().includes(query))) return true;
				if (group.tags.some(t => t.imageId.toLowerCase().includes(query))) return true;
				return false;
			});
		}

		return [...filtered].sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case 'name':
					cmp = a.repoName.localeCompare(b.repoName);
					break;
				case 'size':
					cmp = a.totalSize - b.totalSize;
					break;
				case 'created':
					cmp = a.latestCreated - b.latestCreated;
					break;
				case 'tags':
					cmp = a.tags.length - b.tags.length;
					break;
			}
			// Secondary sort by name for stability when primary values are equal
			if (cmp === 0 && sortField !== 'name') {
				cmp = a.repoName.localeCompare(b.repoName);
			}
			return sortDirection === 'asc' ? cmp : -cmp;
		});
	});

	// Get all unique image IDs in current filter
	const allFilteredImageIds = $derived(
		new Set(sortedGroups.flatMap(g => Array.from(g.imageIds)))
	);

	// Check if all filtered images are selected
	const allFilteredSelected = $derived(
		allFilteredImageIds.size > 0 && Array.from(allFilteredImageIds).every(id => selectedImages.has(id))
	);

	const someFilteredSelected = $derived(
		Array.from(allFilteredImageIds).some(id => selectedImages.has(id)) && !allFilteredSelected
	);

	const selectedInFilter = $derived(
		images.filter(img => selectedImages.has(img.id) && allFilteredImageIds.has(img.id))
	);

	function toggleSelectAll() {
		if (allFilteredSelected) {
			allFilteredImageIds.forEach(id => selectedImages.delete(id));
		} else {
			allFilteredImageIds.forEach(id => selectedImages.add(id));
		}
		selectedImages = new Set(selectedImages);
	}

	function selectNone() {
		selectedImages = new Set();
	}

	function toggleImageSelection(imageId: string) {
		if (selectedImages.has(imageId)) {
			selectedImages.delete(imageId);
		} else {
			selectedImages.add(imageId);
		}
		selectedImages = new Set(selectedImages);
	}

	function toggleRepo(repoName: string) {
		if (expandedRepos.has(repoName)) {
			expandedRepos.delete(repoName);
		} else {
			expandedRepos.add(repoName);
		}
		expandedRepos = new Set(expandedRepos);
	}

	// Filter registries to exclude Docker Hub
	const pushableRegistries = $derived(registries.filter(r => {
		const url = r.url.toLowerCase();
		return !url.includes('docker.io') &&
			   !url.includes('hub.docker.com') &&
			   !url.includes('registry.hub.docker.com');
	}));

	async function fetchImages() {
		// Only show loading skeleton on initial load
		const isInitialLoad = images.length === 0;
		if (isInitialLoad) loading = true;
		try {
			const url = appendEnvParam('/api/images', envId);
			const response = await fetch(url);
			if (!response.ok) {
				// Handle stale environment ID (e.g., after database reset)
				if (response.status === 404 && envId) {
					clearStaleEnvironment(envId);
					environments.refresh();
					return;
				}
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			images = await response.json();
		} catch (error) {
			console.error('Failed to fetch images:', error);
			toast.error('Failed to load images');
		} finally {
			if (isInitialLoad) loading = false;
		}
	}

	async function fetchRegistries() {
		try {
			const response = await fetch('/api/registries');
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			registries = await response.json();
		} catch (error) {
			console.error('Failed to fetch registries:', error);
		}
	}

	async function fetchScannerSettings() {
		if (envId === null) {
			scannerEnabled = false;
			return;
		}
		try {
			const response = await fetch(`/api/settings/scanner?settingsOnly=true&env=${envId}`);
			if (response.ok) {
				const data = await response.json();
				scannerEnabled = data.settings.scanner !== 'none';
			}
		} catch (error) {
			console.error('Failed to fetch scanner settings:', error);
			scannerEnabled = false;
		}
	}

	// Track if initial fetch has been done
	let initialFetchDone = $state(false);

	$effect(() => {
		const env = $currentEnvironment;
		const newEnvId = env?.id ?? null;

		// Only fetch if environment actually changed or this is initial load
		if (env && (newEnvId !== envId || !initialFetchDone)) {
			envId = newEnvId;
			initialFetchDone = true;
			fetchImages();
			fetchScannerSettings();
			fetchVulnMeta(); // badge total + filter options; findings load lazily on tab open
			vulnFetched = false; // env changed → the lazy-load effect below re-fetches if the vuln tab is active
		} else if (!env) {
			// No environment - clear data and stop loading
			envId = null;
			images = [];
			loading = false;
		}
	});

	// Lazy-load the first page the first time the Vulnerabilities tab is opened
	// (or re-opened after an env change), so the Images page stays light otherwise.
	$effect(() => {
		if (activeTab === 'vulnerabilities' && envId !== null && !vulnFetched && !vulnList.loading) {
			fetchVulnerabilities();
		}
	});

	// When filters/search/sort change (while the vuln tab is active), refetch from
	// offset 0 — the server applies them and returns the new first page + total.
	// Debounced so typing in the search box fires one request when the user pauses,
	// not one per keystroke (reset() forces through the in-flight dedupe, so an
	// un-debounced burst would abort+refetch on every character).
	let vulnFilterReady = false;
	let vulnFilterTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		// Track all filter/sort inputs.
		vulnSearch; vulnSeverityFilter; vulnImageFilter; vulnContainerFilter; vulnStackFilter; vulnSort; vulnDir;
		if (!vulnFilterReady) { vulnFilterReady = true; return; }
		if (activeTab === 'vulnerabilities' && envId !== null && vulnFetched) {
			if (vulnFilterTimer) clearTimeout(vulnFilterTimer);
			vulnFilterTimer = setTimeout(() => { vulnFilterTimer = null; fetchVulnerabilities(); }, 200);
		}
	});

	function bulkRemove() {
		batchOpTitle = `Removing ${selectedInFilter.length} image${selectedInFilter.length !== 1 ? 's' : ''}`;
		batchOpOperation = 'remove';
		batchOpItems = selectedInFilter.map(img => {
			const displayName = img.tags.length > 0
				? img.tags[0]
				: img.id.slice(7, 19);
			return { id: img.id, name: displayName };
		});
		batchOpTotalSize = selectedInFilter.reduce((sum, img) => sum + img.size, 0);
		showBatchOpModal = true;
	}

	function handleBatchComplete() {
		selectedImages = new Set();
		fetchImages();
	}

	async function pruneImages() {
		pruneStatus = 'pruning';
		confirmPrune = false;
		try {
			const response = await fetch(appendEnvParam('/api/prune/images', envId), { method: 'POST' });
			const data = await readJobResponse(response);
			if (data.success) {
				pruneStatus = 'success';
				const deleted = data.result?.ImagesDeleted;
				const spaceReclaimed = data.result?.SpaceReclaimed ?? 0;
				const count = deleted?.length ?? 0;
				if (count > 0) {
					toast.success(`Pruned ${count} image${count !== 1 ? 's' : ''}, freed ${formatBytes(spaceReclaimed)}`);
				} else {
					toast.success('No dangling images to prune');
				}
				await fetchImages();
			} else {
				pruneStatus = 'error';
				toast.error(data.error || 'Failed to prune images');
			}
		} catch (error) {
			pruneStatus = 'error';
			toast.error('Failed to prune images');
		}
		pendingTimeouts.push(setTimeout(() => { pruneStatus = 'idle'; }, 3000));
	}

	async function pruneUnusedImages() {
		pruneUnusedStatus = 'pruning';
		confirmPruneUnused = false;
		try {
			const response = await fetch(appendEnvParam('/api/prune/images?dangling=false', envId), { method: 'POST' });
			const data = await readJobResponse(response);
			if (data.success) {
				pruneUnusedStatus = 'success';
				const deleted = data.result?.ImagesDeleted;
				const spaceReclaimed = data.result?.SpaceReclaimed ?? 0;
				const count = deleted?.length ?? 0;
				if (count > 0) {
					toast.success(`Pruned ${count} image${count !== 1 ? 's' : ''}, freed ${formatBytes(spaceReclaimed)}`);
				} else {
					toast.success('No unused images to prune');
				}
				await fetchImages();
			} else {
				pruneUnusedStatus = 'error';
				toast.error(data.error || 'Failed to prune unused images');
			}
		} catch (error) {
			pruneUnusedStatus = 'error';
			toast.error('Failed to prune unused images');
		}
		pendingTimeouts.push(setTimeout(() => { pruneUnusedStatus = 'idle'; }, 3000));
	}

	async function removeImage(id: string, tagName: string) {
		deleteError = null;
		const imageSize = images.find(img => img.id === id)?.size;
		try {
			const response = await fetch(appendEnvParam(`/api/images/${encodeURIComponent(id)}?force=true`, envId), { method: 'DELETE' });
			if (!response.ok) {
				const data = await response.json();
				deleteError = { id, message: data.error || 'Failed to delete image' };
				toast.error(`Failed to delete ${tagName}`);
				pendingTimeouts.push(setTimeout(() => {
					if (deleteError?.id === id) deleteError = null;
				}, 5000));
				return;
			}
			const sizeStr = imageSize ? ` (${formatBytes(imageSize)})` : '';
			toast.success(`Deleted ${tagName}${sizeStr}`);
			await fetchImages();
		} catch (error) {
			console.error('Failed to remove image:', error);
			deleteError = { id, message: 'Failed to delete image' };
			toast.error(`Failed to delete ${tagName}`);
			pendingTimeouts.push(setTimeout(() => {
				if (deleteError?.id === id) deleteError = null;
			}, 5000));
		}
	}

	function openTagModal(imageId: string, currentName: string) {
		tagImageId = imageId;
		tagImageCurrentName = currentName;
		if (currentName.includes(':')) {
			const parts = currentName.split(':');
			tagNewRepo = parts.slice(0, -1).join(':');
			tagNewTag = parts[parts.length - 1];
		} else {
			tagNewRepo = currentName;
			tagNewTag = 'latest';
		}
		showTagModal = true;
	}

	async function tagImage() {
		if (!tagNewRepo.trim() || !tagNewTag.trim()) return;
		tagging = true;
		const newTag = `${tagNewRepo.trim()}:${tagNewTag.trim()}`;
		try {
			const response = await fetch(appendEnvParam(`/api/images/${encodeURIComponent(tagImageId)}/tag`, envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repo: tagNewRepo.trim(), tag: tagNewTag.trim() })
			});
			if (response.ok) {
				toast.success(`Tagged as ${newTag}`);
				showTagModal = false;
				await fetchImages();
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to tag image');
			}
		} catch (error) {
			toast.error('Failed to tag image');
		} finally {
			tagging = false;
		}
	}

	function openPushModal(imageId: string, tagName: string) {
		pushingImage = { id: imageId, tag: tagName };
		showPushModal = true;
	}

	function openRunModal(tagName: string) {
		prefilledImage = tagName;
		showRunModal = true;
	}

	function openHistoryModal(imageId: string, imageName: string) {
		historyImageId = imageId;
		historyImageName = imageName;
		showHistoryModal = true;
	}

	function openScanModal(tagName: string) {
		scanImageName = tagName;
		showScanModal = true;
	}


	function formatSize(bytes: number): string {
		const mb = bytes / (1024 * 1024);
		if (mb < 1024) {
			return `${mb.toFixed(1)} MB`;
		}
		return `${(mb / 1024).toFixed(2)} GB`;
	}

	function formatImageDate(timestamp: number): string {
		return formatDate(new Date(timestamp * 1000));
	}

	function toggleSort(field: SortField) {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = field === 'created' ? 'desc' : 'asc';
		}
	}

	// Handle tab visibility changes (e.g., user switches back from another tab)
	function handleVisibilityChange() {
		if (document.visibilityState === 'visible' && envId) {
			fetchImages();
		}
	}

	onMount(() => {
		// Initial fetch is handled by $effect - no need to duplicate here

		// Only fetch registries if user has permission
		if ($canAccess('registries', 'view')) {
			fetchRegistries();
		}

		// Listen for tab visibility changes to refresh when user returns
		document.addEventListener('visibilitychange', handleVisibilityChange);
		document.addEventListener('resume', handleVisibilityChange);

		unsubscribeDockerEvent = onDockerEvent((event) => {
			if (envId && isImageListChange(event)) {
				fetchImages();
			}
		});

		refreshInterval = setInterval(() => {
			if (envId) fetchImages();
		}, 30000);

		// Note: In Svelte 5, cleanup must be in onDestroy, not returned from onMount
	});

	// Cleanup on component destroy
	onDestroy(() => {
		// Clear polling interval
		if (refreshInterval) {
			clearInterval(refreshInterval);
			refreshInterval = null;
		}

		// Unsubscribe from Docker events
		if (unsubscribeDockerEvent) {
			unsubscribeDockerEvent();
			unsubscribeDockerEvent = null;
		}

		document.removeEventListener('visibilitychange', handleVisibilityChange);
		document.removeEventListener('resume', handleVisibilityChange);
		pendingTimeouts.forEach(id => clearTimeout(id));
		pendingTimeouts = [];

		// Abort any in-flight vuln window fetch and drop its ~400-row buffer, and
		// cancel a pending debounced refetch, so nothing lingers after unmount.
		if (vulnFilterTimer) { clearTimeout(vulnFilterTimer); vulnFilterTimer = null; }
		vulnList.clear();
	});
</script>

<div class="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<TabbedPageHeader
			tabs={[
				{
					id: 'images',
					label: 'Images',
					icon: Images,
					count: activeTab === 'images' ? sortedGroups.length : groupedImages.length,
					total: activeTab === 'images' && (searchQuery || usageFilter !== 'all') && sortedGroups.length !== groupedImages.length ? groupedImages.length : undefined,
					showConnection: true
				},
				{
					id: 'vulnerabilities',
					label: 'Vulnerabilities',
					icon: ShieldCheck,
					count: vulnCount,
					total: vulnCountTotal
				}
			]}
			{activeTab}
			onTabChange={handleTabChange}
		/>

		{#if activeTab === 'images'}
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative">
				<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				<Input
					type="text"
					placeholder="Search images..."
					bind:value={searchQuery}
					onkeydown={(e) => e.key === 'Escape' && (searchQuery = '')}
					class="pl-8 h-8 w-48 text-sm"
				/>
			</div>
			<Select.Root type="single" bind:value={usageFilter}>
				<Select.Trigger size="sm" class="w-36 text-sm">
					{#if usageFilter === 'all'}
						<Filter class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
						<span class="text-muted-foreground">All</span>
					{:else if usageFilter === 'in-use'}
						<CircleDot class="w-3.5 h-3.5 mr-1.5 text-emerald-500 shrink-0" />
						<span>In use</span>
					{:else if usageFilter === 'some-unused'}
						<CircleDot class="w-3.5 h-3.5 mr-1.5 text-amber-500 shrink-0" />
						<span>Some unused</span>
					{:else}
						<Circle class="w-3.5 h-3.5 mr-1.5 text-muted-foreground shrink-0" />
						<span>Unused</span>
					{/if}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="all">
						<Filter class="w-4 h-4 mr-2 text-muted-foreground" />
						All
					</Select.Item>
					<Select.Item value="in-use">
						<CircleDot class="w-4 h-4 mr-2 text-emerald-500" />
						In use
					</Select.Item>
					<Select.Item value="some-unused">
						<CircleDot class="w-4 h-4 mr-2 text-amber-500" />
						Some unused
					</Select.Item>
					<Select.Item value="unused">
						<Circle class="w-4 h-4 mr-2 text-muted-foreground" />
						Unused
					</Select.Item>
				</Select.Content>
			</Select.Root>
			{#if $canAccess('images', 'remove')}
			<ConfirmPopover
				open={confirmPrune}
				action="Prune"
				itemType="dangling images"
				title="Prune dangling images"
				position="left"
				onConfirm={pruneImages}
				onOpenChange={(open) => confirmPrune = open}
				unstyled
			>
				{#snippet children({ open })}
					<span
						class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm bg-background shadow-xs border hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 {pruneStatus === 'pruning' ? 'opacity-50 pointer-events-none' : ''}"
						title="Remove untagged intermediate layers (dangling images)"
					>
						{#if pruneStatus === 'pruning'}
							<RefreshCw class="w-3.5 h-3.5 animate-spin" />
						{:else if pruneStatus === 'success'}
							<Check class="w-3.5 h-3.5 text-green-600" />
						{:else if pruneStatus === 'error'}
							<XCircle class="w-3.5 h-3.5 text-destructive" />
						{:else}
							<Icon iconNode={broom} class="w-3.5 h-3.5" />
						{/if}
						Prune
					</span>
				{/snippet}
			</ConfirmPopover>
			<ConfirmPopover
				open={confirmPruneUnused}
				action="Prune"
				itemType="all unused images"
				title="Prune unused images"
				position="left"
				onConfirm={pruneUnusedImages}
				onOpenChange={(open) => confirmPruneUnused = open}
				unstyled
			>
				{#snippet children({ open })}
					<span
						class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm bg-background shadow-xs border hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 {pruneUnusedStatus === 'pruning' ? 'opacity-50 pointer-events-none' : ''}"
						title="Remove ALL images not used by any container (including tagged images)"
					>
						{#if pruneUnusedStatus === 'pruning'}
							<RefreshCw class="w-3.5 h-3.5 animate-spin" />
						{:else if pruneUnusedStatus === 'success'}
							<Check class="w-3.5 h-3.5 text-green-600" />
						{:else if pruneUnusedStatus === 'error'}
							<XCircle class="w-3.5 h-3.5 text-destructive" />
						{:else}
							<Icon iconNode={broom} class="w-3.5 h-3.5 text-amber-600" />
						{/if}
						Prune unused
					</span>
				{/snippet}
			</ConfirmPopover>
			{/if}
			{#if $canAccess('images', 'pull')}
			<Button size="sm" variant="default" onclick={() => showPullModal = true}>
				<Download class="w-3.5 h-3.5 mr-1.5" />
				Pull
			</Button>
			{/if}
			{#if $canAccess('images', 'load')}
			<Button size="sm" variant="outline" onclick={() => loadFileInput?.click()} disabled={loadingImage}>
				<Upload class="w-3.5 h-3.5 mr-1.5" />
				{loadingImage ? 'Loading...' : 'Load from tar'}
			</Button>
			<input
				bind:this={loadFileInput}
				type="file"
				accept=".tar,application/x-tar"
				class="hidden"
				onchange={handleLoadTar}
			/>
			{/if}
			<Button size="sm" variant="outline" onclick={fetchImages}>Refresh</Button>
		</div>
		{/if}

		{#if activeTab === 'vulnerabilities'}
		<div class="flex flex-wrap items-center gap-2 w-full">
			<div class="relative">
				<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
				<Input
					type="text"
					placeholder="Search CVE, package, image, container, stack..."
					bind:value={vulnSearch}
					onkeydown={(e) => e.key === 'Escape' && (vulnSearch = '')}
					class="pl-8 h-8 w-80 text-sm"
				/>
			</div>
			<MultiSelectFilter
				bind:value={vulnSeverityFilter}
				options={vulnSeverityOptions}
				placeholder="All severities"
				pluralLabel="severities"
				width="w-40"
				defaultIcon={ShieldCheck}
			/>
			<MultiSelectFilter
				bind:value={vulnImageFilter}
				options={vulnImageOptions}
				placeholder="All images"
				pluralLabel="images"
				width="w-48"
			/>
			<MultiSelectFilter
				bind:value={vulnContainerFilter}
				options={vulnContainerOptions}
				placeholder="All containers"
				pluralLabel="containers"
				width="w-44"
			/>
			<MultiSelectFilter
				bind:value={vulnStackFilter}
				options={vulnStackOptions}
				placeholder="All stacks"
				pluralLabel="stacks"
				width="w-40"
			/>
			<div class="flex items-center gap-2 ml-auto">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button size="sm" variant="outline" title="Export findings" {...props}>
								<Download class="w-3.5 h-3.5" />
								Export
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start">
						<DropdownMenu.Item onclick={() => exportVulnerabilities('json')}>
							<FileJson class="w-4 h-4 mr-2 text-amber-500" />
							JSON
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => exportVulnerabilities('csv')}>
							<FileSpreadsheet class="w-4 h-4 mr-2 text-green-500" />
							CSV
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => exportVulnerabilities('sarif')}>
							<ShieldPlus class="w-4 h-4 mr-2 text-blue-500" />
							SARIF
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				<Button size="sm" variant="outline" onclick={refreshVulnerabilities} disabled={vulnList.loading}>
					<RefreshCw class="w-3.5 h-3.5 {vulnList.loading ? 'animate-spin' : ''}" />
					Refresh
				</Button>
				{#if scannerEnabled}
					<Button size="sm" variant="secondary" onclick={() => showVulnScanModal = true}>
						<ShieldCheck class="w-3.5 h-3.5" />
						Scan all images
					</Button>
				{/if}
			</div>
		</div>
		{/if}
	</div>

	<Tabs.Root value={activeTab} onValueChange={handleTabChange} class="w-full flex-1 min-h-0 flex flex-col gap-2">
		<Tabs.Content value="images" class="flex-1 min-h-0 flex flex-col gap-2">
		{#if activeTab === 'images'}

	<!-- Selection bar - only occupies space when something is selected -->
	{#if selectedImages.size > 0}
	<div class="shrink-0">
		{#if selectedImages.size > 0}
			<div class="flex items-center gap-1 text-xs text-muted-foreground h-full">
			<span>{selectedInFilter.length} selected</span>
			<button
				type="button"
				class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:border-foreground/30 hover:shadow transition-all"
				onclick={selectNone}
			>
				Clear
			</button>
			{#if $canAccess('images', 'remove')}
			<button
				type="button"
				class="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border hover:text-destructive hover:border-destructive/40 hover:shadow transition-all disabled:opacity-50 cursor-pointer"
				onclick={bulkRemove}
				disabled={selectedInFilter.length === 0}
			>
				<Trash2 class="w-3 h-3" />
				Delete
			</button>
			{/if}
			</div>
		{/if}
	</div>
	{/if}

	{#if !loading && ($environments.length === 0 || !$currentEnvironment)}
		<NoEnvironment />
	{:else if !loading && images.length === 0}
		<EmptyState
			icon={Images}
			title="No images found"
			description="Pull an image from a registry to get started"
		/>
	{:else}
		<DataGrid
			data={sortedGroups}
			keyField="repoName"
			gridId="images"
			loading={loading}
			expandable
			bind:expandedKeys={expandedRepos}
			sortState={{ field: sortField, direction: sortDirection }}
			onSortChange={(state) => {
				sortField = state.field as SortField;
				sortDirection = state.direction;
			}}
			onRowClick={(group) => toggleRepo(group.repoName)}
			rowClass={(group) => {
				const isExp = expandedRepos.has(group.repoName);
				return isExp ? 'bg-muted/40' : '';
			}}
		>
			{#snippet headerCell(column, sortState)}
				{#if column.id === 'select'}
					{@const allImageIds = sortedGroups.flatMap(g => Array.from(g.imageIds))}
					{@const allSelected = allImageIds.length > 0 && allImageIds.every(id => selectedImages.has(id))}
					{@const someSelected = allImageIds.some(id => selectedImages.has(id)) && !allSelected}
					<button
						type="button"
						onclick={() => {
							if (allSelected) {
								selectedImages = new Set();
							} else {
								selectedImages = new Set(allImageIds);
							}
						}}
						class="flex items-center justify-center transition-colors opacity-40 hover:opacity-100 cursor-pointer"
						title={allSelected ? 'Deselect all' : 'Select all'}
					>
						{#if allSelected}
							<CheckSquare class="w-3.5 h-3.5 text-muted-foreground" />
						{:else if someSelected}
							<CheckSquare class="w-3.5 h-3.5 text-muted-foreground" />
						{:else}
							<Square class="w-3.5 h-3.5 text-muted-foreground" />
						{/if}
					</button>
				{:else if column.sortable}
					<button
						type="button"
						onclick={() => toggleSort(column.sortField ?? column.id)}
						class="flex items-center gap-1 hover:text-foreground transition-colors w-full"
					>
						{column.label}
						{#if sortState?.field === (column.sortField ?? column.id)}
							{#if sortState.direction === 'asc'}
								<ArrowUp class="w-3 h-3" />
							{:else}
								<ArrowDown class="w-3 h-3" />
							{/if}
						{:else}
							<ArrowUpDown class="w-3 h-3 opacity-30" />
						{/if}
					</button>
				{:else if column.id !== 'expand' && column.id !== 'actions'}
					{column.label}
				{/if}
			{/snippet}
			{#snippet cell(column, group, rowState)}
				{#if column.id === 'select'}
					<!-- Custom selection on image IDs -->
					<button
						type="button"
						onclick={(e) => {
							e.stopPropagation();
							const allSelected = Array.from(group.imageIds).every(id => selectedImages.has(id));
							if (allSelected) {
								group.imageIds.forEach(id => selectedImages.delete(id));
							} else {
								group.imageIds.forEach(id => selectedImages.add(id));
							}
							selectedImages = new Set(selectedImages);
						}}
						class="flex items-center justify-center transition-colors cursor-pointer {Array.from(group.imageIds).some(id => selectedImages.has(id)) ? 'opacity-100' : 'opacity-0 group-hover:opacity-40 hover:!opacity-100'}"
					>
						{#if Array.from(group.imageIds).every(id => selectedImages.has(id))}
							<CheckSquare class="w-3.5 h-3.5 text-muted-foreground" />
						{:else if Array.from(group.imageIds).some(id => selectedImages.has(id))}
							<CheckSquare class="w-3.5 h-3.5 text-muted-foreground opacity-50" />
						{:else}
							<Square class="w-3.5 h-3.5 text-muted-foreground" />
						{/if}
					</button>
				{:else if column.id === 'expand'}
					{@const hasMultipleTags = group.tags.length > 1}
					{#if hasMultipleTags}
						{#if rowState.isExpanded}
							<ChevronDown class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
						{:else}
							<ChevronRight class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
						{/if}
					{/if}
				{:else if column.id === 'image'}
					<div class="flex items-center gap-1.5">
						<span class="text-xs truncate" title={group.repoName}>
							{group.repoName === '<none>' ? '<untagged>' : group.repoName}
						</span>
						{#if group.tags.length === 1}
							<span class="text-2xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
								{group.tags[0].tag}
							</span>
						{/if}
						{#if group.containers === 0}
							<Badge variant="outline" class="text-2xs px-1.5 py-0 border-amber-500/50 text-amber-600 dark:text-amber-400 shadow-[0_0_4px_rgba(245,158,11,0.4)]">
								Unused
							</Badge>
						{:else if group.tags.length > 1 && group.tags.some(t => t.containers === 0)}
							<Badge variant="outline" class="text-2xs px-1.5 py-0 border-amber-500/30 text-amber-600/70 dark:text-amber-400/70 shadow-[0_0_3px_rgba(245,158,11,0.25)]" title="Some tags are unused">
								<CircleDashed class="w-2.5 h-2.5 mr-0.5" />
								Some unused
							</Badge>
						{/if}
					</div>
				{:else if column.id === 'tags'}
					<Badge variant="secondary" class="text-xs">
						{group.tags.length}
					</Badge>
				{:else if column.id === 'size'}
					<span class="text-xs">{formatSize(group.totalSize)}</span>
				{:else if column.id === 'updated'}
					<span class="text-xs text-muted-foreground">{formatImageDate(group.latestCreated)}</span>
				{:else if column.id === 'actions'}
					<!-- Quick actions for first tag only when collapsed -->
					{#if !rowState.isExpanded && group.tags.length > 0}
						{@const firstTag = group.tags[0]}
						<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
						<div class="flex items-center justify-end gap-0.5" onclick={(e) => e.stopPropagation()}>
							{#if $canAccess('containers', 'create')}
							<button
								type="button"
								onclick={() => openRunModal(firstTag.fullRef)}
								title="Run container"
								class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
							>
								<Play class="grid-action-icon grid-action-start text-muted-foreground hover:text-green-600" />
							</button>
							{/if}
							{#if scannerEnabled && $canAccess('images', 'inspect')}
							<button
								type="button"
								onclick={() => openScanModal(firstTag.fullRef)}
								title="Scan for vulnerabilities"
								class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
							>
								<ShieldCheck class="grid-action-icon grid-action-info text-muted-foreground hover:text-blue-500" />
							</button>
							{/if}
							{#if $canAccess('images', 'push')}
							<button
								type="button"
								onclick={() => openPushModal(firstTag.imageId, firstTag.fullRef)}
								title="Push to registry"
								class="p-1 rounded hover:bg-muted transition-colors opacity-70 hover:opacity-100 cursor-pointer"
							>
								<Upload class="grid-action-icon grid-action-transfer text-muted-foreground hover:text-foreground" />
							</button>
							{/if}
						</div>
					{/if}
				{/if}
			{/snippet}
			{#snippet expandedRow(group, rowState)}
				<div class="p-4 pl-12 shadow-inner bg-muted/30">
					<DataGrid
						gridId="imageTags"
						data={group.tags}
						keyField="fullRef"
						selectable={false}
						expandable={false}
						loading={false}
						class="nested-grid"
					>
						{#snippet cell(column, tagInfo, rowState)}
							{#if column.id === 'tag'}
								<div class="flex items-center gap-1.5">
									<Tag class="w-3 h-3 text-muted-foreground shrink-0" />
									<span class="{tagInfo.tag === 'latest' ? 'text-blue-600 dark:text-blue-400' : ''}">{tagInfo.tag}</span>
									{#if tagInfo.digestShort && tagInfo.pinnedRef}
										<button
											type="button"
											onclick={() => copyPinnedRef(tagInfo.pinnedRef!)}
											class="inline-flex items-center gap-1 hover:bg-muted px-1 py-0.5 rounded transition-colors cursor-pointer text-muted-foreground hover:text-foreground"
											title={copiedPinned === tagInfo.pinnedRef ? 'Copied!' : 'Copy digest-pinned reference (tag@sha256)'}
										>
											<ShieldCheck class="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
											<code class="text-2xs">{tagInfo.digestShort}</code>
											{#if copiedPinned === tagInfo.pinnedRef}
												<Check class="w-3 h-3 text-green-500" />
											{:else}
												<Copy class="w-3 h-3" />
											{/if}
										</button>
									{/if}
								</div>
							{:else if column.id === 'id'}
								<button
									type="button"
									onclick={() => copyImageId(tagInfo.imageId)}
									class="inline-flex items-center gap-1 hover:bg-muted px-1 py-0.5 rounded transition-colors cursor-pointer"
									title={copiedId === tagInfo.imageId ? 'Copied!' : 'Click to copy full ID'}
								>
									<code class="text-2xs text-muted-foreground">{tagInfo.imageId.slice(7, 19)}</code>
									{#if copiedId === tagInfo.imageId}
										<Check class="w-3 h-3 text-green-500" />
									{/if}
								</button>
							{:else if column.id === 'size'}
								<span class="text-muted-foreground">{formatSize(tagInfo.size)}</span>
							{:else if column.id === 'created'}
								<span class="text-muted-foreground">{formatImageDate(tagInfo.created)}</span>
							{:else if column.id === 'used'}
								{#if tagInfo.containers > 0}
									<a
										href="/containers?search={encodeURIComponent(tagInfo.fullRef)}"
										class="text-muted-foreground hover:text-foreground hover:underline"
										title="View containers using this image"
									>
										{tagInfo.containers} container{tagInfo.containers === 1 ? '' : 's'}
									</a>
								{:else if tagInfo.containers === 0}
									<Badge variant="outline" class="text-2xs px-1.5 py-0 border-amber-500/50 text-amber-600 dark:text-amber-400 shadow-[0_0_4px_rgba(245,158,11,0.4)]">
										Unused
									</Badge>
								{:else}
									<span class="text-muted-foreground/50">—</span>
								{/if}
							{:else if column.id === 'actions'}
								<div class="flex items-center gap-1">
									{#if $canAccess('images', 'inspect')}
									<button
										type="button"
										onclick={() => openHistoryModal(tagInfo.imageId, tagInfo.fullRef)}
										title="View layers"
										class="p-1 rounded hover:bg-muted transition-colors cursor-pointer"
									>
										<Layers class="grid-action-icon grid-action-info text-muted-foreground hover:text-foreground" />
									</button>
									{/if}
									{#if $canAccess('containers', 'create')}
									<button
										type="button"
										onclick={() => openRunModal(tagInfo.fullRef)}
										title="Run container"
										class="p-1 rounded hover:bg-muted transition-colors cursor-pointer"
									>
										<Play class="grid-action-icon grid-action-start text-muted-foreground hover:text-green-600" />
									</button>
									{/if}
									{#if scannerEnabled && $canAccess('images', 'inspect')}
									<button
										type="button"
										onclick={() => openScanModal(tagInfo.fullRef)}
										title="Scan for vulnerabilities"
										class="p-1 rounded hover:bg-muted transition-colors cursor-pointer"
									>
										<ShieldCheck class="grid-action-icon grid-action-info text-muted-foreground hover:text-blue-500" />
									</button>
									{/if}
									{#if $canAccess('images', 'push')}
									<button
										type="button"
										onclick={() => openPushModal(tagInfo.imageId, tagInfo.fullRef)}
										title="Push to registry"
										class="p-1 rounded hover:bg-muted transition-colors cursor-pointer"
									>
										<Upload class="grid-action-icon grid-action-transfer text-muted-foreground hover:text-foreground" />
									</button>
									{/if}
									{#if $canAccess('images', 'inspect')}
									<button
										type="button"
										onclick={() => exportImage(tagInfo.fullRef, tagInfo.fullRef)}
										title="Export image as {$appSettings.downloadFormat}"
										class="p-1 rounded hover:bg-muted transition-colors cursor-pointer {exportingId === tagInfo.fullRef ? 'animate-pulse' : ''}"
										disabled={exportingId === tagInfo.fullRef}
									>
										<Download class="grid-action-icon grid-action-transfer text-muted-foreground hover:text-foreground" />
									</button>
									{/if}
									{#if $canAccess('images', 'build')}
									<button
										type="button"
										onclick={() => openTagModal(tagInfo.imageId, tagInfo.fullRef)}
										title="Tag image"
										class="p-1 rounded hover:bg-muted transition-colors cursor-pointer"
									>
										<Tag class="grid-action-icon grid-action-edit text-muted-foreground hover:text-foreground" />
									</button>
									{/if}
									{#if $canAccess('images', 'remove') && tagInfo.containers === 0}
									<div class="relative">
										<ConfirmPopover
											open={confirmDeleteId === tagInfo.fullRef}
											action="Delete"
											itemType="image"
											itemName={tagInfo.fullRef}
											title="Remove"
											onConfirm={() => removeImage(tagInfo.imageId, tagInfo.fullRef)}
											onOpenChange={(open) => confirmDeleteId = open ? tagInfo.fullRef : null}
										>
											{#snippet children({ open })}
												<Trash2 class="grid-action-icon grid-action-delete {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
											{/snippet}
										</ConfirmPopover>
									</div>
									{/if}
								</div>
							{/if}
						{/snippet}
					</DataGrid>
				</div>
			{/snippet}
		</DataGrid>
	{/if}
	{/if}
	</Tabs.Content>

	<Tabs.Content value="vulnerabilities" class="flex-1 min-h-0 flex flex-col">
		{#if activeTab === 'vulnerabilities'}
			<VulnerabilitiesTab
				{envId}
				{scannerEnabled}
				findings={vulnList.items}
				summary={vulnSummary}
				loading={vulnList.loading}
				dataOffset={vulnList.offset}
				virtualTotal={vulnList.total}
				onWindowShift={vulnList.shiftTo}
				sortField={vulnSort}
				sortDirection={vulnDir}
				onSortChange={(field, dir) => { vulnSort = field; vulnDir = dir; }}
				onRangeChange={handleVulnRange}
			/>
		{/if}
	</Tabs.Content>
	</Tabs.Root>
</div>

<!-- Vulnerability Scan-all Modal -->
<VulnerabilityScanModal bind:open={showVulnScanModal} {envId} envName={$currentEnvironment?.name} onComplete={refreshVulnerabilities} />

<!-- Pull Image Modal -->
<ImagePullModal
	bind:open={showPullModal}
	{registries}
	{envId}
	envHasScanning={scannerEnabled}
	showDeleteButton={true}
	onComplete={fetchImages}
/>

<!-- Push to Registry Modal -->
{#if pushingImage}
	<PushToRegistryModal
		bind:open={showPushModal}
		imageId={pushingImage.id}
		imageName={pushingImage.tag}
		{registries}
		{envId}
		onComplete={fetchImages}
	/>
{/if}

<!-- Image History Modal -->
<ImageHistoryModal
	bind:open={showHistoryModal}
	imageId={historyImageId}
	imageName={historyImageName}
/>

<!-- Create Container Modal -->
<CreateContainerModal
	bind:open={showRunModal}
	onClose={() => showRunModal = false}
	onSuccess={() => showRunModal = false}
	{prefilledImage}
	skipPullTab={true}
/>

<!-- Vulnerability Scan Modal -->
<ImageScanModal
	bind:open={showScanModal}
	imageName={scanImageName}
	mode="scan"
	{envId}
	onComplete={refreshVulnerabilities}
/>

<!-- Batch Operation Modal -->
<BatchOperationModal
	bind:open={showBatchOpModal}
	title={batchOpTitle}
	operation={batchOpOperation}
	entityType="images"
	items={batchOpItems}
	envId={envId ?? undefined}
	options={{ force: true }}
	totalSize={batchOpTotalSize}
	onClose={() => showBatchOpModal = false}
	onComplete={handleBatchComplete}
/>

<!-- Tag Image Dialog -->
<Dialog.Root bind:open={showTagModal}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Tag class="w-5 h-5" />
				Tag image
			</Dialog.Title>
			<Dialog.Description>
				Add a new tag to <span class="font-mono text-foreground truncate" title={tagImageCurrentName}>{tagImageCurrentName.startsWith('sha256:') ? tagImageCurrentName.slice(0, 19) : tagImageCurrentName}</span>
			</Dialog.Description>
		</Dialog.Header>
		<div class="py-4 space-y-4">
			<div>
				<Label for="tagRepo">Repository name</Label>
				<Input
					id="tagRepo"
					bind:value={tagNewRepo}
					placeholder="e.g., myregistry/myimage"
					class="mt-2"
				/>
			</div>
			<div>
				<Label for="tagTag">Tag</Label>
				<Input
					id="tagTag"
					bind:value={tagNewTag}
					placeholder="e.g., latest, v1.0.0"
					class="mt-2"
					onkeydown={(e: KeyboardEvent) => {
						if (e.key === 'Enter' && !tagging && tagNewRepo.trim() && tagNewTag.trim()) {
							tagImage();
						}
					}}
				/>
			</div>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showTagModal = false} disabled={tagging}>
				Cancel
			</Button>
			<Button
				onclick={tagImage}
				disabled={tagging || !tagNewRepo.trim() || !tagNewTag.trim()}
			>
				{#if tagging}
					<RefreshCw class="w-4 h-4 mr-2 animate-spin" />
					Tagging...
				{:else}
					Tag
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
