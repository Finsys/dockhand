<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import CodeEditor, { type VariableMarker } from '$lib/components/CodeEditor.svelte';
	import StackEnvVarsPanel from '$lib/components/StackEnvVarsPanel.svelte';
	import { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import { Layers, Save, Play, Code, GitGraph, Loader2, AlertCircle, X, Sun, Moon, TriangleAlert, GripVertical, FolderOpen, Copy, Check, XCircle, MapPin, ArrowRight, ArrowDown, Info, Box, FolderSync } from 'lucide-svelte';
	import type { Component } from 'svelte';
	import FilesystemBrowser from './FilesystemBrowser.svelte';
	import PathBarItem from './PathBarItem.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as Select from '$lib/components/ui/select';
	import { Badge } from '$lib/components/ui/badge';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { appSettings } from '$lib/stores/settings';
	import { focusFirstInput } from '$lib/utils';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as Alert from '$lib/components/ui/alert';
	import { ErrorDialog } from '$lib/components/ui/error-dialog';
	import ComposeGraphViewer from './ComposeGraphViewer.svelte';
	import { useSidebar } from '$lib/components/ui/sidebar/context.svelte';

	// Get sidebar state to adjust modal positioning
	const sidebar = useSidebar();

	// localStorage key for persisted split ratio
	const STORAGE_KEY_SPLIT = 'dockhand-stack-modal-split';

	interface Props {
		open: boolean;
		mode: 'create' | 'edit';
		stackName?: string; // Required for edit mode, optional for create
		onClose: () => void;
		onSuccess: () => void; // Called after create or save
	}

	let { open = $bindable(), mode, stackName = '', onClose, onSuccess }: Props = $props();

	// Form state
	let newStackName = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let savingWithRestart = $state(false); // Track which save action is in progress
	let error = $state<string | null>(null);
	let loadError = $state<string | null>(null);
	let errors = $state<{ stackName?: string; compose?: string }>({});
	let composeContent = $state('');
	let activeTab = $state<'editor' | 'graph'>('editor');
	let showConfirmClose = $state(false);
	let editorTheme = $state<'light' | 'dark'>('dark');

	// Environment variables state
	let envVars = $state<EnvVar[]>([]);
	let rawEnvContent = $state(''); // Raw .env file content (comments preserved)
	let envValidation = $state<ValidationResult | null>(null);
	let validating = $state(false);
	let existingSecretKeys = $state<Set<string>>(new Set());
	let hadExistingDbVars = $state(false); // Track if DB had any vars on load (for proper cleanup)

	// Simple dirty flag - only set when user touches something
	let isDirty = $state(false);

	// Error dialog state
	let operationError = $state<{ title: string; message: string; details?: string } | null>(null);

	// Stack exists warning dialog state
	let showExistsWarning = $state(false);


	// ─── Path State (Simplified) ─────────────────────────────────────────────────
	// Working paths: what we're currently editing (always strings, never null)
	let workingComposePath = $state('');
	let workingEnvPath = $state('');

	// Original paths: loaded from server (for dirty/change detection in edit mode)
	let originalComposePath = $state<string | null>(null);
	let originalEnvPath = $state<string | null>(null);

	// Auto-computed path from API (for create mode - tracks what the default would be)
	let autoComputedComposePath = $state('');

	// Path source info (for hint display)
	let pathSource = $state<'default' | 'custom' | 'browsed' | null>(null);

	// Base directory when user browsed to a directory (without stack name yet)
	let browsedBaseDirectory = $state<string | null>(null);


	// UI state
	let composePathCopied = $state<'ok' | 'error' | null>(null);
	let envPathCopied = $state<'ok' | 'error' | null>(null);
	let composeContentCopied = $state<'ok' | 'error' | null>(null);
	let needsFileLocation = $state(false);

	// Container info for untracked stacks
	let stackContainers = $state<{ name: string; state: string; image: string }[]>([]);

	// Derived: has user customized the compose path from auto-computed default?
	const isComposePathCustom = $derived(
		workingComposePath !== '' && workingComposePath !== autoComputedComposePath
	);

	// Derived: suggested env path when workingEnvPath is empty
	const suggestedEnvPath = $derived(
		!workingEnvPath && workingComposePath
			? workingComposePath.replace(/\/[^/]+$/, '/.env')
			: null
	);

	// Derived: display path for env (actual or suggested)
	const displayEnvPath = $derived(workingEnvPath || suggestedEnvPath || '');

	// Derived: is env path just a suggestion (not explicitly set)?
	const isEnvPathSuggested = $derived(!workingEnvPath && !!suggestedEnvPath);

	// Derived: source hint text for the path bar (only in create mode)
	const pathSourceHint = $derived.by(() => {
		if (mode !== 'create') return undefined;
		// Show hint when user selected a directory but hasn't entered stack name yet
		if (browsedBaseDirectory && !workingComposePath) {
			return `Will create in ${browsedBaseDirectory}/`;
		}
		if (!workingComposePath) return undefined;
		switch (pathSource) {
			case 'browsed':
			case 'custom':
				return 'Custom location';
			case 'default':
				return 'Using default location';
			default:
				return undefined;
		}
	});

	// Path change confirmation dialog state
	let showPathChangeConfirm = $state(false);
	let pathChangeOldDir = $state<string | null>(null); // Old directory to move files from
	let pathChangeFileCount = $state(0); // Number of files in old directory
	let pendingSaveRestart = $state(false); // Whether user clicked "Save & restart" vs "Save"

	// Browse confirmation dialog state (when selecting different file would replace content)
	let showBrowseConfirm = $state(false);
	let pendingBrowsePath = $state<string | null>(null);
	let pendingBrowseName = $state<string | null>(null);

	// Single file browser with dynamic config
	let showFileBrowser = $state(false);
	let fileBrowserConfig = $state<{
		title: string;
		icon?: Component<{ class?: string }>;
		selectFilter?: RegExp;
		selectMode: 'file' | 'directory' | 'file_or_directory';
		onSelect: (path: string, name: string) => void;
	}>({
		title: '',
		icon: undefined,
		selectFilter: /.*/,
		selectMode: 'file',
		onSelect: () => {}
	});

	function openComposeBrowser() {
		// For untracked stacks (needsFileLocation), only allow selecting files
		// For tracked stacks, allow both files and directories
		const isUntracked = needsFileLocation;
		fileBrowserConfig = {
			title: isUntracked ? 'Select compose file' : 'Select compose file or directory',
			selectFilter: /\.ya?ml$/,
			selectMode: isUntracked ? 'file' : 'file_or_directory',
			onSelect: handleComposeSelect
		};
		showFileBrowser = true;
	}

	function openEnvBrowser() {
		fileBrowserConfig = {
			title: 'Select environment file or directory',
			selectFilter: /\.env($|\.)/,  // matches .env, .env.local, app.env, etc.
			selectMode: 'file_or_directory',
			onSelect: handleEnvSelect
		};
		showFileBrowser = true;
	}

	function openChangeLocationBrowser() {
		const displayName = mode === 'edit' ? stackName : newStackName;
		fileBrowserConfig = {
			title: `Relocate ${displayName}`,
			icon: FolderSync,
			selectMode: 'directory',
			onSelect: handleChangeLocation
		};
		showFileBrowser = true;
	}

	// State for change location confirmation
	let pendingNewLocation = $state<string | null>(null);
	let pendingNewComposePath = $state<string | null>(null);
	let pendingNewEnvPath = $state<string | null>(null);
	let showChangeLocationConfirm = $state(false);
	let changeLocationFileCount = $state(0);
	let changeLocationOldDir = $state<string | null>(null);
	let movingLocation = $state(false);

	async function handleChangeLocation(selectedDir: string, _name: string) {
		showFileBrowser = false;

		// Get the current compose filename
		const currentComposePath = workingComposePath;
		const composeFilename = currentComposePath ? currentComposePath.split('/').pop() : 'compose.yaml';

		// Build new paths: create a subfolder with the stack name inside selected directory
		const displayName = mode === 'edit' ? stackName : newStackName;
		const newDir = `${selectedDir}/${displayName}`;
		const newComposePath = `${newDir}/${composeFilename}`;
		const newEnvPath = workingEnvPath ? `${newDir}/.env` : '';

		// Check if old directory has files to move
		const envId = $currentEnvironment?.id ?? null;
		try {
			const response = await fetch(
				appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/check-path-change`, envId),
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ newComposePath })
				}
			);

			if (response.ok) {
				const data = await response.json();
				if (data.hasChanges && data.oldDir && data.fileCount > 0) {
					// Show confirmation dialog
					pendingNewLocation = newDir;
					pendingNewComposePath = newComposePath;
					pendingNewEnvPath = newEnvPath;
					changeLocationOldDir = data.oldDir;
					changeLocationFileCount = data.fileCount;
					showChangeLocationConfirm = true;
					return;
				}
			}
		} catch (e) {
			console.warn('Failed to check path changes:', e);
		}

		// No files to move, just update paths
		workingComposePath = newComposePath;
		workingEnvPath = newEnvPath;
		isDirty = true;
	}

	function cancelChangeLocation() {
		showChangeLocationConfirm = false;
		pendingNewLocation = null;
		pendingNewComposePath = null;
		pendingNewEnvPath = null;
		changeLocationOldDir = null;
		changeLocationFileCount = 0;
	}

	async function confirmChangeLocation() {
		if (!pendingNewComposePath || !changeLocationOldDir) return;

		movingLocation = true;
		const envId = $currentEnvironment?.id ?? null;

		try {
			// Call API to move files
			const response = await fetch(
				appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/relocate`, envId),
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						oldDir: changeLocationOldDir,
						newComposePath: pendingNewComposePath,
						newEnvPath: pendingNewEnvPath || undefined
					})
				}
			);

			if (!response.ok) {
				const data = await response.json();
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to move files');
			}

			const result = await response.json();

			// Update paths
			workingComposePath = pendingNewComposePath;
			workingEnvPath = pendingNewEnvPath || '';
			originalComposePath = pendingNewComposePath;
			originalEnvPath = pendingNewEnvPath || null;

			// Reload content from new location
			if (result.composeContent) {
				composeContent = result.composeContent;
			}
			if (result.envVars) {
				envVars = result.envVars;
			}
			if (result.rawEnvContent !== undefined) {
				rawEnvContent = result.rawEnvContent;
			}

			// Reset dirty flag since we just reloaded
			isDirty = false;

		} catch (e: any) {
			operationError = {
				title: 'Failed to move files',
				message: e.message || 'An error occurred while moving files'
			};
		} finally {
			movingLocation = false;
			showChangeLocationConfirm = false;
			pendingNewLocation = null;
			pendingNewComposePath = null;
			pendingNewEnvPath = null;
			changeLocationOldDir = null;
			changeLocationFileCount = 0;
		}
	}

	// Generic copy function that returns a reset callback
	async function copyText(text: string | null, setCopied: (v: 'ok' | 'error' | null) => void) {
		if (text) {
			const ok = await copyToClipboard(text);
			setCopied(ok ? 'ok' : 'error');
			setTimeout(() => setCopied(null), 2000);
		}
	}

	// Parse env vars from raw content
	function parseEnvVarsFromRaw(content: string) {
		const vars: EnvVar[] = [];
		const lines = content.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const eqIndex = trimmed.indexOf('=');
			if (eqIndex > 0) {
				const key = trimmed.substring(0, eqIndex);
				const value = trimmed.substring(eqIndex + 1);
				vars.push({ key, value, isSecret: false });
			}
		}
		envVars = vars;
	}

	// Handle compose file selection from browser
	async function handleComposeSelect(path: string, name: string) {
		const isDirectory = !path.match(/\.ya?ml$/i);

		// If selecting a file in edit mode with existing content, show confirmation
		if (mode === 'edit' && !isDirectory && composeContent.trim()) {
			// Check if it's the same file (no confirmation needed)
			const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path;
			if (normalizedPath !== workingComposePath) {
				pendingBrowsePath = path;
				pendingBrowseName = name;
				showBrowseConfirm = true;
				showFileBrowser = false;
				return;
			}
		}

		// Continue with file selection
		await proceedWithComposeSelect(path, name);
	}

	// Proceed with compose file selection (after optional confirmation)
	async function proceedWithComposeSelect(path: string, name: string) {
		// Check if it's a directory (no extension or doesn't end with .yml/.yaml)
		const isDirectory = !path.match(/\.ya?ml$/i);
		const baseDir = path.endsWith('/') ? path.slice(0, -1) : path;
		let finalPath = path;

		if (isDirectory) {
			const stackName = newStackName.trim();
			// Store the base directory so effect can rebuild path if user changes stack name
			browsedBaseDirectory = baseDir;
			if (stackName) {
				// If we have a stack name, build the full path with subfolder
				finalPath = `${baseDir}/${stackName}/compose.yaml`;
			} else {
				// No stack name yet - path will be completed when stack name is entered
				finalPath = ''; // Don't set incomplete path
				pathSource = 'browsed';
				showFileBrowser = false;
				isDirty = true;
				return; // Exit early - path will be completed when stack name is entered
			}
		} else {
			browsedBaseDirectory = null; // Selected a file, not a directory
		}

		// In CREATE mode, we only want the content - don't store external paths
		// Files will be saved to the directory containing the selected compose file
		if (mode === 'create') {
			showFileBrowser = false;

			// Load compose file content when selecting a file (not directory)
			if (!isDirectory) {
				// Build potential env path in same directory as compose file
				const dir = finalPath.replace(/\/[^/]+$/, '');
				const potentialEnvPath = `${dir}/.env`;
				await loadFilesFromLocalFilesystem(finalPath, potentialEnvPath);
				// Use the selected file's path directly
				workingComposePath = finalPath;
				workingEnvPath = `${dir}/.env`;
				browsedBaseDirectory = null;
				// 'custom' prevents the path effect from overriding (it only acts on 'browsed')
				pathSource = 'custom';
			} else {
				pathSource = 'browsed';
			}
			isDirty = true;
			return;
		}

		// EDIT mode - store the selected path
		workingComposePath = finalPath;
		pathSource = 'browsed';
		showFileBrowser = false;

		// Auto-suggest .env in the same directory
		const dir = finalPath.replace(/\/[^/]+$/, '');
		if (!workingEnvPath) {
			workingEnvPath = `${dir}/.env`;
		}

		// Load compose file content when selecting a file (not directory)
		if (!isDirectory) {
			await loadFilesFromLocalFilesystem(finalPath, workingEnvPath || suggestedEnvPath || '');
		}
		isDirty = true;
	}

	// Cancel browse confirmation
	function cancelBrowseConfirm() {
		showBrowseConfirm = false;
		pendingBrowsePath = null;
		pendingBrowseName = null;
	}

	// Confirm browse and load the new file
	async function confirmBrowseAndLoad() {
		showBrowseConfirm = false;
		if (pendingBrowsePath && pendingBrowseName) {
			await proceedWithComposeSelect(pendingBrowsePath, pendingBrowseName);
		}
		pendingBrowsePath = null;
		pendingBrowseName = null;
	}

	// Handle env file selection from browser
	async function handleEnvSelect(path: string, name: string) {
		// Check if it's a directory (no extension or doesn't contain .env)
		const isDirectory = !path.match(/\.env($|\.)/i);
		let finalPath = path;
		if (isDirectory) {
			// Append default env filename
			finalPath = path.endsWith('/') ? `${path}.env` : `${path}/.env`;
		}

		showFileBrowser = false;

		// Load env content when selecting a file (not directory)
		if (!isDirectory) {
			try {
				const envResponse = await fetch(`/api/system/files/content?path=${encodeURIComponent(finalPath)}`);
				if (envResponse.ok) {
					const envData = await envResponse.json();
					rawEnvContent = envData.content || '';
					parseEnvVarsFromRaw(rawEnvContent);
				} else {
					rawEnvContent = '';
				}
			} catch (e) {
				console.error('Failed to load env file:', e);
			}
		}

		// Store the selected path:
		// - Always in EDIT mode
		// - In CREATE mode when user selected a custom compose location OR explicitly selected an env file
		if (mode !== 'create' || pathSource === 'custom' || pathSource === 'browsed' || !isDirectory) {
			workingEnvPath = finalPath;
		}
		// Otherwise CREATE mode with internal location uses default via suggestedEnvPath

		isDirty = true;
	}

	// Load files from local filesystem (when user selects paths)
	async function loadFilesFromLocalFilesystem(composeFilePath: string, envFilePath: string) {
		try {
			// Load compose file
			const composeResponse = await fetch(`/api/system/files/content?path=${encodeURIComponent(composeFilePath)}`);
			if (composeResponse.ok) {
				const composeData = await composeResponse.json();
				composeContent = composeData.content || '';
				// Only set workingComposePath in EDIT mode - CREATE mode uses internal defaults
				if (mode !== 'create') {
					workingComposePath = composeFilePath;
				}
				// Clear the needsFileLocation flag since we now have content
				needsFileLocation = false;
				stackContainers = [];
			} else {
				const err = await composeResponse.json();
				console.error('Failed to load compose file:', err.error);
			}

			// Try to load .env file (only set workingEnvPath if it exists AND we're in edit mode)
			if (envFilePath) {
				const envResponse = await fetch(`/api/system/files/content?path=${encodeURIComponent(envFilePath)}`);
				if (envResponse.ok) {
					const envData = await envResponse.json();
					rawEnvContent = envData.content || '';
					// Only set workingEnvPath in EDIT mode - CREATE mode uses internal defaults
					if (mode !== 'create') {
						workingEnvPath = envFilePath;
					}
					parseEnvVarsFromRaw(rawEnvContent);
				} else {
					// .env file not found - clear env path
					rawEnvContent = '';
					if (mode !== 'create') {
						workingEnvPath = '';
					}
				}
			}
		} catch (e) {
			console.error('Failed to load files:', e);
		}
	}

	// CodeEditor reference for explicit marker updates
	let codeEditorRef: CodeEditor | null = $state(null);

	// ComposeGraphViewer reference for resize on panel toggle
	let graphViewerRef: ComposeGraphViewer | null = $state(null);

	// EnvVarsPanel reference for sync before save
	let envVarsPanelRef: StackEnvVarsPanel | null = $state(null);

	// Resizable split panel state
	let splitRatio = $state(60); // percentage for compose panel
	let isDraggingSplit = $state(false);
	let containerRef: HTMLDivElement | null = $state(null);

	// Debounce timer for validation
	let validateTimer: ReturnType<typeof setTimeout> | null = null;

	const defaultCompose = `version: "3.8"

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

	// Count of defined environment variables (with non-empty keys)
	const envVarCount = $derived(envVars.filter(v => v.key.trim()).length);

	// Build a lookup map from envVars for quick access
	const envVarMap = $derived.by(() => {
		const map = new Map<string, { value: string; isSecret: boolean }>();
		for (const v of envVars) {
			if (v.key.trim()) {
				map.set(v.key.trim(), { value: v.value, isSecret: v.isSecret });
			}
		}
		return map;
	});

	// Compute variable markers for the code editor (with values for overlay)
	const variableMarkers = $derived.by<VariableMarker[]>(() => {
		if (!envValidation) return [];

		const markers: VariableMarker[] = [];

		// Add missing required variables
		for (const name of envValidation.missing) {
			const env = envVarMap.get(name);
			markers.push({
				name,
				type: 'missing',
				value: env?.value,
				isSecret: env?.isSecret
			});
		}

		// Add defined required variables
		for (const name of envValidation.required) {
			if (!envValidation.missing.includes(name)) {
				const env = envVarMap.get(name);
				markers.push({
					name,
					type: 'required',
					value: env?.value,
					isSecret: env?.isSecret
				});
			}
		}

		// Add optional variables
		for (const name of envValidation.optional) {
			const env = envVarMap.get(name);
			markers.push({
				name,
				type: 'optional',
				value: env?.value,
				isSecret: env?.isSecret
			});
		}

		return markers;
	});

	// Stable callback for compose content changes - avoids stale closure issues
	function handleComposeChange(value: string) {
		composeContent = value;
		isDirty = true;
		debouncedValidate();
	}

	// Debounced validation to avoid too many API calls while typing
	function debouncedValidate() {
		if (validateTimer) clearTimeout(validateTimer);
		validateTimer = setTimeout(() => {
			validateEnvVars();
		}, 1000);
	}

	// Explicitly push markers to the editor (immediate=true since this is called after validation)
	function updateEditorMarkers() {
		if (!codeEditorRef) return;
		codeEditorRef.updateVariableMarkers(variableMarkers, true);
	}

	// Mark dirty when env vars change
	function markDirty() {
		isDirty = true;
	}

	// Display title
	const displayName = $derived(mode === 'edit' ? stackName : (newStackName || 'New stack'));

	onMount(() => {
		// Load saved editor theme, or fall back to app theme / system preference
		const savedEditorTheme = localStorage.getItem('dockhand-editor-theme');
		if (savedEditorTheme === 'dark' || savedEditorTheme === 'light') {
			editorTheme = savedEditorTheme;
		} else {
			const appTheme = localStorage.getItem('theme');
			if (appTheme === 'dark' || appTheme === 'light') {
				editorTheme = appTheme;
			} else {
				// Fallback to system preference
				editorTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
			}
		}

		// Load saved split ratio
		const savedSplit = localStorage.getItem(STORAGE_KEY_SPLIT);
		if (savedSplit) {
			const ratio = parseFloat(savedSplit);
			if (!isNaN(ratio) && ratio >= 30 && ratio <= 80) {
				splitRatio = ratio;
			}
		}

		// Add global mouse event listeners for split dragging
		window.addEventListener('mousemove', handleMouseMove);
		window.addEventListener('mouseup', handleMouseUp);
	});

	onDestroy(() => {
		window.removeEventListener('mousemove', handleMouseMove);
		window.removeEventListener('mouseup', handleMouseUp);
	});

	// Split panel drag handlers
	function startSplitDrag(e: MouseEvent) {
		e.preventDefault();
		isDraggingSplit = true;
	}

	function handleMouseMove(e: MouseEvent) {
		if (isDraggingSplit && containerRef) {
			const rect = containerRef.getBoundingClientRect();
			const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
			splitRatio = Math.max(30, Math.min(80, newRatio));
		}
	}

	function handleMouseUp() {
		if (isDraggingSplit) {
			isDraggingSplit = false;
			// Save split ratio
			localStorage.setItem(STORAGE_KEY_SPLIT, splitRatio.toString());
		}
	}

	async function loadComposeFile() {
		if (mode !== 'edit' || !stackName) return;

		loading = true;
		loadError = null;
		error = null;
		needsFileLocation = false;

		try {
			const envId = $currentEnvironment?.id ?? null;

			// Load compose file
			const response = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/compose`, envId));
			const data = await response.json();

			if (!response.ok) {
				// Check if this stack needs file location selection
				if (data.needsFileLocation) {
					needsFileLocation = true;
					// Initialize paths from response (may have suggested paths)
					workingComposePath = data.composePath || '';
					workingEnvPath = data.envPath || '';
					// Show empty editors - user can browse for files
					composeContent = '';
					rawEnvContent = '';
					loadError = null;
					loading = false; // Important: stop loading spinner

					// Fetch containers for this stack to show what's running
					try {
						const stacksRes = await fetch(appendEnvParam('/api/stacks', envId));
						if (stacksRes.ok) {
							const stacks = await stacksRes.json();
							const thisStack = stacks.find((s: any) => s.name === stackName);
							if (thisStack?.containerDetails) {
								stackContainers = thisStack.containerDetails.map((c: any) => ({
									name: c.name || 'unknown',
									state: c.state || 'unknown',
									image: c.image || 'unknown'
								}));
							}
						}
					} catch (e) {
						console.error('Failed to fetch stack containers:', e);
					}
					return;
				}
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to load compose file');
			}

			composeContent = data.content;
			// Set working paths
			workingComposePath = data.composePath || '';
			workingEnvPath = data.envPath || '';
			// Track original paths for detecting changes
			originalComposePath = data.composePath || null;
			originalEnvPath = data.envPath || null;

			// Load both env endpoints in parallel, then process results together
			const [envResponse, rawEnvResponse] = await Promise.all([
				fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env`, envId)),
				fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env/raw`, envId))
			]);

			// Process env vars from DB
			let loadedVars: EnvVar[] = [];
			if (envResponse.ok) {
				const envData = await envResponse.json();
				loadedVars = envData.variables || [];
				hadExistingDbVars = loadedVars.length > 0;
				existingSecretKeys = new Set(
					loadedVars.filter(v => v.isSecret && v.key.trim()).map(v => v.key.trim())
				);
			}

			// Process raw .env file content
			let loadedRawContent = '';
			if (rawEnvResponse.ok) {
				const rawEnvData = await rawEnvResponse.json();
				loadedRawContent = rawEnvData.content || '';
			}

			// Pass data directly to syncAfterLoad - no tick() needed
			// This sets both envVars and rawEnvContent synchronously via the panel
			loading = false;
			await tick(); // Wait for panel ref to be available
			envVarsPanelRef?.syncAfterLoad(loadedVars, loadedRawContent);
			isDirty = false;

		} catch (e: any) {
			loadError = e.message;
			loading = false;
		}
	}

	async function validateEnvVars() {
		const content = composeContent || defaultCompose;
		if (!content.trim()) return;

		validating = true;
		try {
			const envId = $currentEnvironment?.id ?? null;
			// Use 'new' as placeholder stack name for new stacks
			const stackNameForValidation = mode === 'edit' ? stackName : (newStackName.trim() || 'new');
			// Pass current UI env vars for validation
			const currentVars = envVars.filter(v => v.key.trim()).map(v => v.key.trim());
			const response = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackNameForValidation)}/env/validate`, envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ compose: content, variables: currentVars })
			});

			if (response.ok) {
				envValidation = await response.json();
				// Explicitly update markers in the editor after validation
				// Use setTimeout to ensure derived variableMarkers has updated
				setTimeout(() => updateEditorMarkers(), 0);
			}
		} catch (e) {
			console.error('Failed to validate env vars:', e);
		} finally {
			validating = false;
		}
	}

	function toggleEditorTheme() {
		editorTheme = editorTheme === 'light' ? 'dark' : 'light';
		localStorage.setItem('dockhand-editor-theme', editorTheme);
	}

	function handleGraphContentChange(newContent: string) {
		composeContent = newContent;
	}

	async function handleCreate(start: boolean = false) {
		errors = {};
		let hasErrors = false;

		if (!newStackName.trim()) {
			errors.stackName = 'Stack name is required';
			hasErrors = true;
		}

		const content = composeContent || defaultCompose;
		if (!content.trim()) {
			errors.compose = 'Compose file content is required';
			hasErrors = true;
		}

		if (hasErrors) return;

		const envId = $currentEnvironment?.id ?? null;

		// Check if stack already exists
		try {
			const stacksResponse = await fetch(appendEnvParam('/api/stacks', envId));
			if (stacksResponse.ok) {
				const stacks = await stacksResponse.json();
				const existingStack = stacks.find((s: { name: string }) =>
					s.name.toLowerCase() === newStackName.trim().toLowerCase()
				);
				if (existingStack) {
					showExistsWarning = true;
					return;
				}
			}
		} catch (e) {
			console.warn('Failed to check for existing stacks:', e);
			// Continue with creation if check fails
		}

		saving = true;
		error = null;

		// Prepare env vars for creating - syncs variables and rawContent
		const prepared = envVarsPanelRef?.prepareForSave() || { rawContent: '', variables: [] };

		try {
			// Build request body
			const requestBody: Record<string, unknown> = {
				name: newStackName.trim(),
				compose: content,
				start,
				// Send raw env content (non-secrets only, preserves comments/formatting)
				rawEnvContent: prepared.rawContent.trim() ? prepared.rawContent : undefined,
				// Also send parsed vars for DB secret tracking (includes secrets)
				envVars: prepared.variables.length > 0 ? prepared.variables.map(v => ({
					key: v.key.trim(),
					value: v.value,
					isSecret: v.isSecret
				})) : undefined
			};

			// Include custom paths if specified
			if (workingComposePath.trim()) {
				requestBody.composePath = workingComposePath.trim();
			}
			// Use working env path or suggested path
			const envPathToSave = workingEnvPath.trim() || suggestedEnvPath || '';
			if (envPathToSave) {
				requestBody.envPath = envPathToSave;
			}

			// Create the stack
			const response = await fetch(appendEnvParam('/api/stacks', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody)
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to create stack');
			}

			onSuccess();
			handleClose();
		} catch (e: any) {
			operationError = {
				title: 'Failed to create stack',
				message: e.message || 'An error occurred while creating the stack',
				details: e.details
			};
		} finally {
			saving = false;
		}
	}

	async function handleSave(restart = false, moveFromDir: string | null | undefined = undefined) {
		errors = {};

		// Validate compose content (unless file location is needed and we have a path)
		if (!composeContent.trim() && !workingComposePath.trim()) {
			errors.compose = 'Compose file content or path is required';
			return;
		}

		// If file location is needed, require a compose path
		if (needsFileLocation && !workingComposePath.trim()) {
			errors.compose = 'Please select a compose file location';
			return;
		}

		const envId = $currentEnvironment?.id ?? null;

		// Check if directory has changed (edit mode only, and not already confirmed)
		// Use === undefined to distinguish "not checked yet" from "keep files" (empty string)
		if (mode === 'edit' && moveFromDir === undefined) {
			const newComposePath = workingComposePath.trim() || null;

			// Only check if compose path changed (which means directory changed)
			if (newComposePath && originalComposePath && newComposePath !== originalComposePath) {
				try {
					const checkResponse = await fetch(
						appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/check-path-change`, envId),
						{
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ newComposePath })
						}
					);
					if (checkResponse.ok) {
						const checkData = await checkResponse.json();
						if (checkData.hasChanges && checkData.oldDir && checkData.fileCount > 0) {
							// Show confirmation dialog
							pathChangeOldDir = checkData.oldDir;
							pathChangeFileCount = checkData.fileCount;
							pendingSaveRestart = restart;
							showPathChangeConfirm = true;
							return;
						}
					}
				} catch (e) {
					console.warn('Failed to check path changes:', e);
					// Continue with save even if check fails
				}
			}
		}

		saving = true;
		savingWithRestart = restart;
		error = null;

		// Prepare env vars for saving - syncs variables and rawContent
		const prepared = envVarsPanelRef?.prepareForSave() || { rawContent: '', variables: [] };

		// Resolve env path (use working or suggested)
		const envPathToSave = workingEnvPath.trim() || suggestedEnvPath || '';

		try {
			// Build request body - include paths if they've been set/changed
			const requestBody: Record<string, unknown> = {
				content: composeContent,
				restart
			};

			// Include compose path if set (either custom path or user selected)
			if (workingComposePath.trim()) {
				requestBody.composePath = workingComposePath.trim();
			}

			// Include env path - empty string means "no env file", null/undefined means "use default"
			if (envPathToSave) {
				requestBody.envPath = envPathToSave;
			}

			// Include old paths for file move/rename operations
			if (originalComposePath && workingComposePath.trim() && originalComposePath !== workingComposePath.trim()) {
				requestBody.oldComposePath = originalComposePath;
			}
			if (originalEnvPath && envPathToSave && originalEnvPath !== envPathToSave) {
				requestBody.oldEnvPath = originalEnvPath;
			}

			// Include old directory to move files from if user confirmed
			if (moveFromDir) {
				requestBody.moveFromDir = moveFromDir;
			}

			// Save env files BEFORE compose to ensure deploy reads fresh values
			// Save raw content to .env file (non-secrets only, comments preserved)
			const rawEnvResponse = await fetch(
				appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env/raw`, envId),
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content: prepared.rawContent })
				}
			);

			if (!rawEnvResponse.ok) {
				const rawEnvError = await rawEnvResponse.json().catch(() => ({ error: 'Failed to save environment file' }));
				throw new Error((typeof rawEnvError.error === 'string' ? rawEnvError.error : rawEnvError.message) || 'Failed to save environment file');
			}

			// Save only secrets to DB (non-secrets are in the .env file written above)
			const secretVars = prepared.variables.filter(v => v.isSecret);
			if (secretVars.length > 0 || hadExistingDbVars) {
				const envResponse = await fetch(
					appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env`, envId),
					{
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							variables: secretVars.map(v => ({
								key: v.key.trim(),
								value: v.value,
								isSecret: true
							}))
						})
					}
				);

				if (!envResponse.ok) {
					// Log but don't fail - DB stores secret values
					console.warn('Failed to save secret variables to database');
				}

				hadExistingDbVars = secretVars.length > 0;
				existingSecretKeys = new Set(
					secretVars.filter(v => v.key.trim()).map(v => v.key.trim())
				);
			}

			// Save compose file (with optional paths) - after env so deploy reads fresh .env
			const response = await fetch(
				appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/compose`, envId),
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(requestBody)
				}
			);

			const data = await response.json();

			if (!response.ok) {
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to save compose file');
			}

			isDirty = false; // Reset dirty flag after successful save
			onSuccess();

			if (!restart) {
				// Show success briefly then close
				setTimeout(() => handleClose(), 500);
			} else {
				handleClose();
			}
		} catch (e: any) {
			operationError = {
				title: restart ? 'Failed to apply stack' : 'Failed to save stack',
				message: e.message || (restart ? 'An error occurred while applying the stack' : 'An error occurred while saving the stack'),
				details: e.details
			};
		} finally {
			saving = false;
		}
	}

	// Handle path change confirmation - move files to new location and proceed
	function confirmPathChangeAndMove() {
		showPathChangeConfirm = false;
		handleSave(pendingSaveRestart, pathChangeOldDir);
	}

	// Handle path change - keep old files and proceed (just save without moving)
	function confirmPathChangeKeepFiles() {
		showPathChangeConfirm = false;
		// Pass empty string to skip move check (undefined means "not checked yet")
		handleSave(pendingSaveRestart, '');
	}

	function tryClose() {
		if (isDirty) {
			showConfirmClose = true;
		} else {
			handleClose();
		}
	}

	function handleClose() {
		// Clear any pending validation timer
		if (validateTimer) {
			clearTimeout(validateTimer);
			validateTimer = null;
		}
		// Reset all state
		newStackName = '';
		error = null;
		loadError = null;
		rawEnvContent = '';
		errors = {};
		composeContent = '';
		envVars = [];
		envValidation = null;
		isDirty = false;
		existingSecretKeys = new Set();
		hadExistingDbVars = false;
		activeTab = 'editor';
		showConfirmClose = false;
		codeEditorRef = null;
		operationError = null;
		// Reset path state
		workingComposePath = '';
		workingEnvPath = '';
		originalComposePath = null;
		originalEnvPath = null;
		autoComputedComposePath = '';
		pathSource = null;
		browsedBaseDirectory = null;
		needsFileLocation = false;
		stackContainers = [];
		showFileBrowser = false;
		// Reset path change confirmation state
		showPathChangeConfirm = false;
		pathChangeOldDir = null;
		pathChangeFileCount = 0;
		pendingSaveRestart = false;
		// Reset browse confirmation state
		showBrowseConfirm = false;
		pendingBrowsePath = null;
		pendingBrowseName = null;
		onClose();
	}

	function discardAndClose() {
		showConfirmClose = false;
		handleClose();
	}

	// Initialize when dialog opens - ONLY ONCE per open
	let hasInitialized = $state(false);
	$effect(() => {
		if (open && !hasInitialized) {
			hasInitialized = true;
			if (mode === 'edit' && stackName) {
				loadComposeFile().then(() => {
					// Auto-validate after loading
					validateEnvVars();
				});
			} else if (mode === 'create') {
				// Set default compose content for create mode
				composeContent = defaultCompose;
				isDirty = false; // Reset dirty flag for new modal
				loading = false;
				// Auto-validate default compose
				validateEnvVars();
			}
		} else if (!open) {
			hasInitialized = false; // Reset when modal closes
		}
	});

	// Re-validate when envVars change (adding/removing variables affects missing/defined status)
	$effect(() => {
		// Track envVars changes (this triggers on any modification to envVars array)
		const vars = envVars;
		if (!open || !envValidation) return;

		// Debounce to avoid too many API calls while typing
		const timeout = setTimeout(() => {
			validateEnvVars();
		}, 800);

		return () => clearTimeout(timeout);
	});

	// Pre-fetched default base directory for create mode (fetched once on open/env change)
	let defaultStackDir = $state<string | null>(null);

	async function fetchDefaultBasePath(envId: number | null, location: string | null) {
		const params = new URLSearchParams({ name: '__placeholder__' });
		if (envId) params.set('env', String(envId));
		if (location) params.set('location', location);
		try {
			const r = await fetch(`/api/stacks/default-path?${params}`);
			if (r.ok) {
				const data = await r.json();
				// Extract base dir by removing the placeholder name
				defaultStackDir = data.stackDir.replace('/__placeholder__', '');
			}
		} catch {
			// Ignore fetch errors
		}
	}

	// Fetch default base path when modal opens or environment changes
	$effect(() => {
		if (!open || mode !== 'create') return;
		const envId = $currentEnvironment?.id ?? null;
		const location = $appSettings.primaryStackLocation;
		fetchDefaultBasePath(envId, location);
	});

	// Auto-update default paths when stack name changes in create mode
	// This unified effect handles both default paths and browsed directory paths
	$effect(() => {
		if (mode !== 'create' || !open) return;

		const name = newStackName.trim();

		// User selected a specific file - paths are locked, don't touch them
		if (pathSource === 'custom') return;

		// No name entered yet - clear paths but preserve browsed state
		if (!name) {
			workingComposePath = '';
			workingEnvPath = '';
			autoComputedComposePath = '';
			if (!browsedBaseDirectory) {
				pathSource = null;
			}
			return;
		}

		// User browsed and selected a directory - build path from that base
		if (browsedBaseDirectory) {
			workingComposePath = `${browsedBaseDirectory}/${name}/compose.yaml`;
			workingEnvPath = `${browsedBaseDirectory}/${name}/.env`;
			pathSource = 'browsed';
			return;
		}

		// Use pre-fetched default base directory
		if (defaultStackDir) {
			const dir = `${defaultStackDir}/${name}`;
			autoComputedComposePath = `${dir}/compose.yaml`;
			workingComposePath = `${dir}/compose.yaml`;
			workingEnvPath = `${dir}/.env`;
			pathSource = 'default';
		}
	});
</script>

<Dialog.Root
	bind:open
	onOpenChange={(isOpen) => {
		if (isOpen) {
			focusFirstInput();
		} else {
			// Prevent closing if there are unsaved changes - show confirmation instead
			if (isDirty) {
				// Re-open the dialog and show confirmation
				open = true;
				showConfirmClose = true;
			} else {
				// No unsaved changes - reset state
				handleClose();
			}
		}
	}}
>
	<Dialog.Content
		class="max-w-none h-[95vh] flex flex-col p-0 gap-0 shadow-xl border-zinc-200 dark:border-zinc-700 {sidebar.state === 'collapsed' ? 'w-[calc(100vw-6rem)] ml-[1.5rem]' : 'w-[calc(100vw-12rem)] ml-[4.5rem]'}"
		showCloseButton={false}
	>
		<Dialog.Header class="px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2">
						<div class="p-1.5 rounded-md bg-zinc-200 dark:bg-zinc-700">
							<Layers class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
						</div>
						<div>
							<Dialog.Title class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
								{#if mode === 'create'}
									Create compose stack
								{:else}
									{stackName}
								{/if}
							</Dialog.Title>
							<Dialog.Description class="text-xs text-zinc-500 dark:text-zinc-400">
								{#if mode === 'create'}
									Create a new Docker Compose stack
								{:else}
									Edit compose file and environment variables
								{/if}
							</Dialog.Description>
						</div>
					</div>
				</div>

				<div class="flex items-center gap-2">
					<!-- View toggle -->
					<div class="flex items-center gap-0.5 bg-zinc-200 dark:bg-zinc-700 rounded-md p-0.5">
						<button
							class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors {activeTab === 'editor' ? 'bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}"
							onclick={() => activeTab = 'editor'}
						>
							<Code class="w-3.5 h-3.5" />
							Editor
						</button>
						<button
							class="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors {activeTab === 'graph' ? 'bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}"
							onclick={() => activeTab = 'graph'}
						>
							<GitGraph class="w-3.5 h-3.5" />
							Graph
						</button>
					</div>

					<!-- Theme toggle (only in editor mode) -->
					{#if activeTab === 'editor'}
						<button
							onclick={toggleEditorTheme}
							class="p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
							title={editorTheme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
						>
							{#if editorTheme === 'light'}
								<Moon class="w-4 h-4" />
							{:else}
								<Sun class="w-4 h-4" />
							{/if}
						</button>
					{/if}

					<!-- Close button -->
					<button
						onclick={tryClose}
						class="p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
					>
						<X class="w-4 h-4" />
					</button>
				</div>
			</div>
		</Dialog.Header>

		<div class="flex-1 overflow-hidden flex flex-col min-h-0">
			{#if errors.compose}
				<Alert.Root variant="destructive" class="mx-6 mt-4">
					<TriangleAlert class="h-4 w-4" />
					<Alert.Description>{errors.compose}</Alert.Description>
				</Alert.Root>
			{/if}

			{#if mode === 'edit' && loading}
				<div class="flex-1 flex items-center justify-center">
					<div class="flex items-center gap-3 text-zinc-400 dark:text-zinc-500">
						<Loader2 class="w-5 h-5 animate-spin" />
						<span>Loading compose file...</span>
					</div>
				</div>
			{:else}
				<!-- Stack name and location inputs (create mode only) -->
				{#if mode === 'create'}
					<div class="px-6 py-4 border-b border-zinc-200 dark:border-zinc-700">
						<div class="flex gap-4 items-start">
							<div class="flex-1 max-w-xs space-y-1">
								<Label for="stack-name">Stack name</Label>
								<Input
									id="stack-name"
									bind:value={newStackName}
									placeholder="my-stack"
									class={errors.stackName ? 'border-destructive focus-visible:ring-destructive' : ''}
									oninput={() => errors.stackName = undefined}
								/>
								{#if errors.stackName}
									<p class="text-xs text-destructive">{errors.stackName}</p>
								{/if}
							</div>
						</div>
					</div>
				{/if}

				<!-- File location needed banner -->
				{#if mode === 'edit' && needsFileLocation}
					<div class="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 bg-amber-50/50 dark:bg-amber-950/20">
						<div class="flex items-start gap-3">
							<AlertCircle class="w-4 h-4 shrink-0 text-amber-500 mt-0.5" />
							<div class="flex-1 min-w-0">
								<p class="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
									<span class="font-medium text-amber-800 dark:text-amber-300">Untracked stack</span> — this stack is running in Docker but Dockhand doesn't know where its compose file is stored on disk. Browse to locate the file to start editing and managing it.
								</p>
								{#if stackContainers.length > 0}
									<div class="text-xs text-zinc-500 dark:text-zinc-400">
										<span class="font-medium text-zinc-700 dark:text-zinc-300">Running containers:</span>
										<div class="mt-1.5 flex flex-wrap gap-1.5">
											{#each stackContainers as container}
												<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs {container.state === 'running' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'}">
													<Box class="w-3 h-3" />
													{container.name}
												</span>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						</div>
					</div>
				{/if}

				<!-- Content area -->
				<div bind:this={containerRef} class="flex-1 min-h-0 flex flex-col {isDraggingSplit ? 'select-none' : ''}">
					{#if activeTab === 'editor'}
						<!-- Path bars row -->
						<div class="flex border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/30">
							<!-- Compose path -->
							<div class="flex-shrink-0 px-4 py-2" style="width: {splitRatio}%">
								<PathBarItem
									label="Compose file"
									path={workingComposePath || null}
									placeholder="/path/to/compose.yaml"
									copied={composePathCopied}
									onCopy={() => copyText(workingComposePath, (v) => composePathCopied = v)}
									onBrowse={openComposeBrowser}
									onChangeLocation={mode === 'edit' && !needsFileLocation ? openChangeLocationBrowser : undefined}
									defaultText={mode === 'create' ? 'Enter stack name above' : 'Not specified'}
									sourceHint={pathSourceHint}
								/>
							</div>
							<!-- Divider spacer -->
							<div class="w-1 flex-shrink-0"></div>
							<!-- Env path -->
							<div class="flex-1 min-w-0 px-4 py-2 bg-zinc-100/50 dark:bg-zinc-800/50">
								<PathBarItem
									label="Env file"
									path={displayEnvPath || null}
									selectedPath={workingEnvPath || suggestedEnvPath || ''}
									placeholder="/path/to/.env (optional)"
									copied={envPathCopied}
									onCopy={() => copyText(displayEnvPath, (v) => envPathCopied = v)}
									onBrowse={openEnvBrowser}
									isEditable={true}
									isCustom={!!workingEnvPath}
									defaultText={mode === 'create' ? 'Enter stack name above' : 'Not specified'}
									isSuggested={isEnvPathSuggested}
									onPathChange={(value) => {
										workingEnvPath = value;
										isDirty = true;
									}}
								/>
							</div>
						</div>
						<!-- Editor panels row -->
						<div class="flex-1 min-h-0 flex">
							<!-- Compose editor panel -->
							<div class="flex-shrink-0 flex flex-col min-w-0" style="width: {splitRatio}%">
								{#if open}
									<div class="flex-1 p-3 min-h-0">
										{#if needsFileLocation && !composeContent}
											<!-- Empty state for untracked stacks -->
											<div class="h-full rounded-md border border-dashed border-zinc-300 dark:border-zinc-600 bg-zinc-50 dark:bg-zinc-800/30 flex flex-col items-center justify-center text-center px-8">
												<FolderOpen class="w-12 h-12 text-zinc-300 dark:text-zinc-600 mb-4" />
												<h3 class="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">No compose file selected</h3>
												<p class="text-xs text-zinc-500 dark:text-zinc-400 mb-4 max-w-sm">
													Browse to locate the compose file for this stack. The editor will load the file contents once selected.
												</p>
												<Button variant="outline" size="sm" onclick={openComposeBrowser}>
													<FolderOpen class="w-4 h-4" />
													Browse for compose file
												</Button>
												<!-- Info box explaining what happens -->
												<div class="mt-6 max-w-md flex items-start gap-2.5 text-xs bg-zinc-100 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2.5 text-left">
													<Info class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
													<span><span class="font-medium text-amber-600 dark:text-amber-400">What happens when you select a file:</span> <span class="text-zinc-600 dark:text-zinc-400">Dockhand will track this compose file, letting you edit, start, and stop the stack from the UI. Your files stay in their current location.</span></span>
												</div>
											</div>
										{:else}
											<div class="h-full flex flex-col">
												<!-- Copy button row -->
												<div class="flex justify-end mb-1">
													<Button
														variant="ghost"
														size="sm"
														class="h-6 px-2 text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
														onclick={() => copyText(composeContent, (v) => composeContentCopied = v)}
														disabled={!composeContent}
													>
														{#if composeContentCopied === 'error'}
															<Tooltip.Root open>
																<Tooltip.Trigger>
																	<XCircle class="w-3 h-3 text-red-500" />
																</Tooltip.Trigger>
																<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
															</Tooltip.Root>
															Failed
														{:else if composeContentCopied === 'ok'}
															<Check class="w-3 h-3 text-green-500" />
															Copied
														{:else}
															<Copy class="w-3 h-3" />
															Copy
														{/if}
													</Button>
												</div>
												<CodeEditor
													bind:this={codeEditorRef}
													value={composeContent}
													language="yaml"
													theme={editorTheme}
													onchange={handleComposeChange}
													variableMarkers={variableMarkers}
													class="flex-1 rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700"
												/>
											</div>
										{/if}
									</div>
								{/if}
							</div>
							<!-- Resizable divider -->
							<div
								class="w-1 flex-shrink-0 bg-zinc-200 dark:bg-zinc-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors flex items-center justify-center group {isDraggingSplit ? 'bg-blue-500 dark:bg-blue-400' : ''}"
								onmousedown={startSplitDrag}
								role="separator"
								aria-orientation="vertical"
								tabindex="0"
							>
								<div class="w-4 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity {isDraggingSplit ? 'opacity-100' : ''}">
									<GripVertical class="w-3 h-3 text-white" />
								</div>
							</div>
							<!-- Environment variables panel -->
							<div class="flex-1 min-w-0 flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-800/50">
								<StackEnvVarsPanel
									bind:this={envVarsPanelRef}
									bind:variables={envVars}
									bind:rawContent={rawEnvContent}
									validation={envValidation}
									existingSecretKeys={mode === 'edit' ? existingSecretKeys : new Set()}
									onchange={() => { markDirty(); debouncedValidate(); }}
									theme={editorTheme}
									infoText="These variables will be written to a .env file in the stack directory and passed to the compose command."
								/>
							</div>
						</div>
					{:else if activeTab === 'graph'}
						<!-- Graph tab: Full width -->
						<ComposeGraphViewer
							bind:this={graphViewerRef}
							composeContent={composeContent || defaultCompose}
							class="h-full flex-1"
							onContentChange={handleGraphContentChange}
						/>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div class="px-5 py-2.5 border-t border-zinc-200 dark:border-zinc-700 flex items-center justify-between flex-shrink-0">
			<div class="text-xs text-zinc-500 dark:text-zinc-400">
				{#if isDirty}
					<span class="text-amber-600 dark:text-amber-500">Unsaved changes</span>
				{:else}
					No changes
				{/if}
			</div>

			<div class="flex items-center gap-2">
				<Button variant="outline" onclick={tryClose} disabled={saving}>
					Cancel
				</Button>

				{#if mode === 'create'}
					<!-- Create mode buttons -->
					<Button variant="outline" onclick={() => handleCreate(false)} disabled={saving}>
						{#if saving}
							<Loader2 class="w-4 h-4 animate-spin" />
							Creating...
						{:else}
							<Save class="w-4 h-4" />
							Create
						{/if}
					</Button>
					<Button onclick={() => handleCreate(true)} disabled={saving}>
						{#if saving}
							<Loader2 class="w-4 h-4 animate-spin" />
							Starting...
						{:else}
							<Play class="w-4 h-4" />
							Create & Start
						{/if}
					</Button>
				{:else}
					<!-- Edit mode buttons -->
					<Button variant="outline" class="w-24" onclick={() => handleSave(false)} disabled={saving || loading || (needsFileLocation && !workingComposePath.trim())}>
						{#if saving && !savingWithRestart}
							<Loader2 class="w-4 h-4 animate-spin" />
							Saving...
						{:else}
							<Save class="w-4 h-4" />
							Save
						{/if}
					</Button>
					<Button class="w-36" onclick={() => handleSave(true)} disabled={saving || loading || (needsFileLocation && !workingComposePath.trim())}>
						{#if saving && savingWithRestart}
							<Loader2 class="w-4 h-4 animate-spin" />
							Deploying...
						{:else}
							<Play class="w-4 h-4" />
							Save & redeploy
						{/if}
					</Button>
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!-- Unsaved changes confirmation dialog -->
<Dialog.Root bind:open={showConfirmClose}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Unsaved changes</Dialog.Title>
			<Dialog.Description>
				You have unsaved changes. Are you sure you want to close without saving?
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex justify-end gap-1.5 mt-4">
			<Button variant="outline" size="sm" onclick={() => showConfirmClose = false}>
				Continue editing
			</Button>
			<Button variant="destructive" size="sm" onclick={discardAndClose}>
				Discard changes
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!-- Path change confirmation dialog -->
<Dialog.Root bind:open={showPathChangeConfirm}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Move stack files?</Dialog.Title>
			<Dialog.Description>
				You've changed the stack location. There {pathChangeFileCount === 1 ? 'is' : 'are'} {pathChangeFileCount} file{pathChangeFileCount === 1 ? '' : 's'} in the old location that can be moved to the new location.
			</Dialog.Description>
		</Dialog.Header>
		{#if pathChangeOldDir}
			<div class="my-3 text-sm">
				<div class="flex items-center gap-2 text-muted-foreground font-mono text-xs bg-muted/50 px-2 py-1 rounded">
					<FolderOpen class="w-3.5 h-3.5 shrink-0 text-amber-500" />
					{pathChangeOldDir}
				</div>
			</div>
		{/if}
		<p class="text-sm text-muted-foreground">
			Would you like to move all files to the new location, or leave them in place?
		</p>
		<div class="flex justify-end gap-1.5 mt-4">
			<Button variant="outline" size="sm" onclick={() => showPathChangeConfirm = false}>
				Cancel
			</Button>
			<Button variant="secondary" size="sm" onclick={confirmPathChangeKeepFiles}>
				Leave files
			</Button>
			<Button variant="default" size="sm" onclick={confirmPathChangeAndMove}>
				<ArrowRight class="w-3.5 h-3.5" />
				Move files
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!-- Browse confirmation dialog (when selecting different file would replace content) -->
<Dialog.Root bind:open={showBrowseConfirm}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Replace editor content?</Dialog.Title>
			<Dialog.Description>
				Loading a different compose file will replace the current editor content.
			</Dialog.Description>
		</Dialog.Header>
		<div class="my-3 space-y-2 text-sm">
			<div class="flex items-start gap-2 text-muted-foreground">
				<span class="text-xs font-medium text-zinc-500 shrink-0 pt-0.5">Current:</span>
				<code class="text-xs font-mono bg-muted px-1.5 py-0.5 rounded break-all">
					{workingComposePath || '(unsaved)'}
				</code>
			</div>
			<div class="flex items-start gap-2">
				<ArrowRight class="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
				<span class="text-xs font-medium text-zinc-500 shrink-0 pt-0.5">New:</span>
				<code class="text-xs font-mono bg-muted px-1.5 py-0.5 rounded break-all">
					{pendingBrowsePath}
				</code>
			</div>
		</div>
		<div class="flex justify-end gap-1.5 mt-4">
			<Button variant="outline" size="sm" onclick={cancelBrowseConfirm}>
				Cancel
			</Button>
			<Button variant="default" size="sm" onclick={confirmBrowseAndLoad}>
				Replace content
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!-- Change location confirmation dialog -->
<Dialog.Root bind:open={showChangeLocationConfirm}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<FolderSync class="w-5 h-5" />
				Relocate stack?
			</Dialog.Title>
			<Dialog.Description>
				All {changeLocationFileCount} file{changeLocationFileCount === 1 ? '' : 's'} in the stack folder will be moved.
			</Dialog.Description>
		</Dialog.Header>
		<div class="my-3 space-y-1 text-sm">
			<div class="flex items-start gap-2 text-muted-foreground">
				<span class="text-xs font-medium text-zinc-500 shrink-0 w-10">From</span>
				<code class="text-xs font-mono bg-muted px-1.5 py-0.5 rounded break-all">
					{changeLocationOldDir}
				</code>
			</div>
			<div class="flex justify-center py-3">
				<ArrowDown class="w-4 h-4 text-amber-500" />
			</div>
			<div class="flex items-start gap-2">
				<span class="text-xs font-medium text-zinc-500 shrink-0 w-10">To</span>
				<code class="text-xs font-mono bg-muted px-1.5 py-0.5 rounded break-all">
					{pendingNewLocation}
				</code>
			</div>
		</div>
		<div class="flex justify-end gap-1.5 mt-4">
			<Button variant="outline" size="sm" onclick={cancelChangeLocation} disabled={movingLocation}>
				Cancel
			</Button>
			<Button variant="default" size="sm" onclick={confirmChangeLocation} disabled={movingLocation}>
				{#if movingLocation}
					<Loader2 class="w-3.5 h-3.5 animate-spin" />
					Moving...
				{:else}
					<FolderSync class="w-3.5 h-3.5" />
					Move files
				{/if}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!-- Stack already exists warning dialog -->
<Dialog.Root bind:open={showExistsWarning}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<TriangleAlert class="w-5 h-5 text-amber-500" />
				Stack already exists
			</Dialog.Title>
			<Dialog.Description>
				A stack named "{newStackName}" already exists. Please choose a different name.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex justify-end mt-4">
			<Button size="sm" onclick={() => showExistsWarning = false}>
				OK
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!-- Error dialog for failed operations -->
{#if operationError}
	{@const errorDialogOpen = true}
	<ErrorDialog
		open={errorDialogOpen}
		title={operationError.title}
		message={operationError.message}
		details={operationError.details}
		onClose={() => operationError = null}
	/>
{/if}

<!-- File browser for compose/env/location selection -->
<FilesystemBrowser
	bind:open={showFileBrowser}
	title={fileBrowserConfig.title}
	icon={fileBrowserConfig.icon}
	selectFilter={fileBrowserConfig.selectFilter}
	selectMode={fileBrowserConfig.selectMode}
	onSelect={fileBrowserConfig.onSelect}
	onClose={() => showFileBrowser = false}
/>
