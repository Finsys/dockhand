<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import CodeEditor, { type VariableMarker } from '$lib/components/CodeEditor.svelte';
	import StackEnvVarsPanel from '$lib/components/StackEnvVarsPanel.svelte';
	import { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import SecretProviderPicker from '$lib/components/SecretProviderPicker.svelte';
	import { SELECTOR_VARS } from '$lib/utils/bulk-selector';
	import { classifyMarker, resolvedRefVarNames } from '$lib/utils/invault-markers';
	import { applyQuickFix, findingKey } from '$lib/utils/compose-quick-fix';
	import { Layers, Save, Play, Code, GitGraph, GitBranch, GitCommitHorizontal, Github, Loader2, AlertCircle, X, Sun, Moon, TriangleAlert, GripVertical, FolderOpen, Copy, Check, XCircle, MapPin, ArrowRight, ArrowUp, ArrowDown, Info, Box, FolderSync, Archive, Lock, FileText, FileCode, ExternalLink, ListChecks } from 'lucide-svelte';
	import ComposeValidatePanel from './ComposeValidatePanel.svelte';
	import GitSourceBadge from './GitSourceBadge.svelte';
	import BackupPanel from '../containers/BackupPanel.svelte';
	import { volumesForStack, type VolumeInfo } from '$lib/utils/mounts';
	import { fetchBackupExecutions } from '$lib/utils/backup';
	import type { Component } from 'svelte';
	import FilesystemBrowser from './FilesystemBrowser.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Badge } from '$lib/components/ui/badge';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { appSettings } from '$lib/stores/settings';
	import { page } from '$app/stores'; // BETA GATE: backups feature flag
	import { focusFirstInput } from '$lib/utils';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as Alert from '$lib/components/ui/alert';
	import { ErrorDialog } from '$lib/components/ui/error-dialog';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import { toast } from 'svelte-sonner';
	import ComposeGraphViewer from './ComposeGraphViewer.svelte';


	// localStorage key for persisted split ratio
	const STORAGE_KEY_SPLIT = 'dockhand-stack-modal-split';

	interface Props {
		open: boolean;
		mode: 'create' | 'edit';
		stackName?: string; // Required for edit mode, optional for create
		initialCompose?: string; // Pre-fill compose content (for library deploy)
		initialStackName?: string; // Pre-fill stack name (for library deploy)
		readonly?: boolean; // View compose content without allowing local changes
		gitInfo?: { commit?: string; url?: string; branch?: string } | null; // Git provenance for read-only git stacks
		stackSource?: { sourceType: string; repository?: { url?: string; branch?: string } | null; gitStack?: { lastCommit?: string | null } | null } | null;
		onClose: () => void;
		onSuccess: () => void; // Called after create or save
	}

	let { open = $bindable(), mode: propMode, stackName: propStackName = '', initialCompose, initialStackName, readonly = false, gitInfo = null, stackSource = null, onClose, onSuccess }: Props = $props();

	let gitCommitCopied = $state<'ok' | 'error' | null>(null);

	// Local effective state - can transition from create → edit after failed deploy
	let mode = $state(propMode);
	let stackName = $state(propStackName);

	// Form state
	let newStackName = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let savingWithRestart = $state(false); // Track which save action is in progress
	let error = $state<string | null>(null);
	let loadError = $state<string | null>(null);
	let errors = $state<{ stackName?: string; compose?: string }>({});
	let composeContent = $state('');
	let composeContents = $state<Record<string, string>>({});   // path → content map for multi-file
	let activeComposePath = $state('');                           // currently viewed file path
	let activeTab = $state<'editor' | 'graph' | 'backups'>('editor');
	let backupCount = $state(0);
	let backupTally = $state<{ ok: number; failed: number }>({ ok: 0, failed: 0 });
	let showConfirmClose = $state(false);
	let editorTheme = $state<'light' | 'dark'>('dark');
	// Ref to the embedded backup panel so close can check its inline form for unsaved edits.
	let backupPanelRef = $state<BackupPanel | undefined>(undefined);

	// Secret providers
	type SecretProviderOption = { id: number; name: string; type: string };
	let secretProviders = $state<SecretProviderOption[]>([]);
	let formSecretProviderId = $state<number | null>(null);
	// Provider-injected key NAMES from the last deploy (banner)
	let injectedSecretKeys = $state<string[]>([]);
	// Provider type/name for the injected-secrets banner in the env panel.
	const selectedProviderType = $derived(
		secretProviders.find((p) => p.id === formSecretProviderId)?.type ?? null
	);
	const selectedProviderName = $derived(
		secretProviders.find((p) => p.id === formSecretProviderId)?.name ?? null
	);
	// Live probe of the bound provider: key NAMES currently present (bulk + resolved
	// inline refs). Drives the editor's green IN VAULT marker. Empty when no provider
	// is bound or the probe failed; probeError holds the reason on failure.
	let providerKeySet = $state<Set<string>>(new Set());
	let probeError = $state<string | null>(null);
	let probeSeq = 0;

	// Environment variables state
	let envVars = $state<EnvVar[]>([]);
	let rawEnvContent = $state(''); // Raw .env file content (comments preserved)
	let envValidation = $state<ValidationResult | null>(null);
	let validating = $state(false);

	// SELECTOR_VARS (OP_ENVIRONMENT_ID / DOCKHAND_SECRET_SELECTOR) are consumed by the
	// secret provider, not the compose file, so they only count as "used" when a
	// provider is bound to the stack.
	const effectiveValidation = $derived.by<ValidationResult | null>(() => {
		if (!envValidation || formSecretProviderId === null) return envValidation;
		if (!envValidation.unused.some((v) => SELECTOR_VARS.includes(v))) return envValidation;
		return {
			...envValidation,
			unused: envValidation.unused.filter((v) => !SELECTOR_VARS.includes(v))
		};
	});
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

	// Multi compose paths (ordered list)
	let workingComposePaths = $state<string[]>([]);

	// Drag-and-drop state for compose paths reordering
	let dragIndex = $state<number | null>(null);

	// Original paths: loaded from server (for dirty/change detection in edit mode)
	let originalComposePath = $state<string | null>(null);
	let originalEnvPath = $state<string | null>(null);

	// Auto-computed path from API (for create mode - tracks what the default would be)
	let autoComputedComposePath = $state('');

	// Path source info (for hint display)
	let pathSource = $state<'default' | 'custom' | 'browsed' | null>(null);

	// Base directory when user browsed to a directory (without stack name yet)
	let browsedBaseDirectory = $state<string | null>(null);

	// True once the user types a stack name (vs auto-derived from compose file selection)
	let stackNameUserEdited = $state(false);


	// UI state
	let composePathCopied = $state<'ok' | 'error' | null>(null);
	let composePathCopiedIndex = $state<number | null>(null);
	let envPathCopied = $state<'ok' | 'error' | null>(null);
	let composeContentCopied = $state<'ok' | 'error' | null>(null);

	// --- Compose Validate (side panel) ------------------------------------------
	let validatePanelOpen = $state(false);
	let validateLoading = $state(false);
	let validateError = $state<string | null>(null);
	let validateActiveLine = $state<number | null>(null);
	let validateReport = $state<import('./ComposeValidatePanel.svelte').ValidateReport | null>(null);
	// Monotonic token: only the newest validate response is allowed to write the report,
	// so a slow silent re-validate can't overwrite a newer one (fix-spam race).
	let validateSeq = 0;
	// Findings mapped to editor lint markers (only those with a line).
	const validateMarkers = $derived(
		(validateReport?.findings ?? [])
			.filter((f) => typeof f.line === 'number')
			.map((f) => ({ line: f.line!, severity: f.severity, ruleId: f.ruleId, message: f.message }))
	);

	async function runComposeValidate(opts: { silent?: boolean } = {}) {
		if (!composeContent.trim()) return;
		// Silent re-validate (after a quick fix) keeps the current list visible so the
		// panel doesn't collapse to a spinner and lose the scroll position.
		if (!opts.silent) validateLoading = true;
		validateError = null;
		validatePanelOpen = true;
		const seq = ++validateSeq;
		try {
			const envId = $currentEnvironment?.id ?? null;
			const name = (mode === 'edit' ? stackName : newStackName) || 'stack';
			// Send the editor's current env vars (incl. secrets) so `docker compose config`
			// resolves ${VAR} the same way a deploy will, instead of flagging "VAR not set".
			const validateEnvVars: Record<string, string> = {};
			for (const v of envVars) {
				const k = v.key.trim();
				if (k) validateEnvVars[k] = v.value ?? '';
			}
			const res = await fetch(
				appendEnvParam(`/api/stacks/${encodeURIComponent(name)}/validate`, envId),
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
							compose: composeContent,
							envVars: validateEnvVars,
							// Only an EDIT of an existing stack has "own" containers to exclude from
							// collision checks. A NEW stack with a name that clashes with a running
							// stack must still be flagged, so never self-exclude in create mode.
							existing: mode === 'edit'
						})
				}
			);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `Validation failed (${res.status})`);
			}
			const fresh = await res.json();
			// Stale response (a newer validate started meanwhile): drop it entirely.
			if (seq !== validateSeq) return;
			// On a silent re-validate, only swap the report if the finding set actually
			// changed. When a fix succeeded the optimistic list already matches the fresh
			// one, so keeping the same object avoids re-rendering (and the flash) of the
			// surviving boxes.
			if (opts.silent && validateReport && sameFindingSet(validateReport.findings, fresh.findings)) {
				// no-op: current (optimistic) report is already correct
			} else {
				validateReport = fresh;
			}
		} catch (e) {
			if (seq !== validateSeq) return; // superseded - don't clobber a newer report
			validateError = e instanceof Error ? e.message : 'Validation failed';
			validateReport = null;
		} finally {
			if (seq === validateSeq) validateLoading = false;
		}
	}

	// Two finding lists are "the same" set (order-independent) by their stable keys.
	function sameFindingSet(
		a: { ruleId: string; line?: number; message: string }[],
		b: { ruleId: string; line?: number; message: string }[]
	): boolean {
		if (a.length !== b.length) return false;
		const bag = new Map<string, number>();
		for (const f of a) bag.set(findingKey(f), (bag.get(findingKey(f)) ?? 0) + 1);
		for (const f of b) {
			const k = findingKey(f);
			const n = bag.get(k);
			if (!n) return false;
			bag.set(k, n - 1);
		}
		return true;
	}

	// Remove a finding from the current report immediately (optimistic), so its box
	// animates out without waiting for the round-trip.
	function dropFinding(target: { ruleId: string; line?: number; message: string }) {
		if (!validateReport) return;
		const targetKey = findingKey(target);
		const remaining = validateReport.findings.filter((f) => findingKey(f) !== targetKey);
		const counts = { error: 0, warn: 0, info: 0 };
		for (const f of remaining) counts[f.severity]++;
		validateReport = { findings: remaining, counts };
	}

	// Closing the panel clears the findings so the editor markers disappear too
	// (validateMarkers is derived from validateReport).
	function closeValidatePanel() {
		validatePanelOpen = false;
		validateReport = null;
		validateError = null;
		validateActiveLine = null;
	}

	// Clicking a gutter marker opens the panel, highlights that line's finding, and
	// scrolls the panel to it (the editor->panel direction).
	function openValidateAtLine(line: number) {
		if (validateReport) validatePanelOpen = true;
		validateActiveLine = line;
		validatePanelRef?.scrollToFinding?.(line);
	}

	// Clicking a finding in the panel jumps the editor to its line (panel stays open).
	function jumpToComposeLine(line: number) {
		codeEditorRef?.scrollToLine?.(line);
		validateActiveLine = line;
	}

	// Apply a quick fix from the panel: rewrite the compose in place, drop the fixed
	// finding's box immediately (it animates out), then re-validate silently so the list
	// stays put - no spinner, no scroll reset.
	function applyValidateFix(finding: {
		ruleId: string;
		line?: number;
		message: string;
		fix?: import('$lib/utils/compose-quick-fix').QuickFix;
	}) {
		if (!finding.fix) return;
		const next = applyQuickFix(composeContent, finding.fix);
		if (next === composeContent) return; // stale fix (text moved) - re-validate re-anchors
		composeContent = next;
		// The reactive editor sync suppresses onchange, so mark dirty ourselves.
		isDirty = true;
		validateActiveLine = null;
		dropFinding(finding); // optimistic: the box animates out now
		runComposeValidate({ silent: true }); // reconcile against the daemon without a flash
	}
	let needsFileLocation = $state(false);

	// Container info for untracked stacks
	let stackContainers = $state<{ name: string; state: string; image: string }[]>([]);
	// Volumes/binds of this stack's containers, for the backup panel picker.
	let stackVolumes = $state<VolumeInfo[]>([]);

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
		multiSelect?: boolean;
		onSelectMany?: (entries: { path: string; name: string }[]) => void;
	}>({
		title: '',
		icon: undefined,
		selectFilter: /.*/,
		selectMode: 'file',
		onSelect: () => {}
	});

	function deriveStackNameFromComposePath(path: string): string {
		const parts = path.split('/');
		if (parts.length < 2) return '';
		const parentDir = parts[parts.length - 2];
		return parentDir
			.toLowerCase()
			.replace(/[\s_]+/g, '-')
			.replace(/[^a-z0-9-]/g, '')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '');
	}

	function maybeDeriveStackNameFromCompose(path: string) {
		if (!stackNameUserEdited) {
			const derived = deriveStackNameFromComposePath(path);
			if (derived) newStackName = derived;
		}
	}

	function openComposeBrowser() {
		const isUntracked = needsFileLocation;
		fileBrowserConfig = {
			title: isUntracked ? 'Select compose file' : 'Select compose file or directory',
			selectFilter: /\.ya?ml$/,
			selectMode: isUntracked ? 'file' : 'file_or_directory',
			onSelect: handleComposeSelect
		};
		showFileBrowser = true;
	}

	let browsingRowIndex = $state<number | null>(null);

	function browseForRow(index: number) {
		browsingRowIndex = index;
		fileBrowserConfig = {
			title: 'Select compose file',
			selectFilter: /\.ya?ml$/,
			selectMode: 'file',
			onSelect: (path: string) => {
				const newPaths = [...workingComposePaths];
				newPaths[index] = path;
				workingComposePaths = newPaths;
				if (index === 0) workingComposePath = path;
				showFileBrowser = false;
				browsingRowIndex = null;
				isDirty = true;
				if (index === 0 && mode === 'create') {
					maybeDeriveStackNameFromCompose(path);
				}
			},
		};
		showFileBrowser = true;
	}

	function addComposePath() {
		workingComposePaths = [...workingComposePaths, ''];
		isDirty = true;
	}

	function removeComposePath(index: number) {
		if (workingComposePaths.length <= 1) return;
		const newPaths = workingComposePaths.filter((_, i) => i !== index);
		workingComposePaths = newPaths;
		if (index === 0) {
			workingComposePath = newPaths[0] || '';
		}
		isDirty = true;
	}

	function movePathUp(index: number) {
		if (index <= 0) return;
		const newPaths = [...workingComposePaths];
		[newPaths[index - 1], newPaths[index]] = [newPaths[index], newPaths[index - 1]];
		workingComposePaths = newPaths;
		if (index === 0 || index - 1 === 0) workingComposePath = newPaths[0];
		isDirty = true;
	}

	function movePathDown(index: number) {
		if (index >= workingComposePaths.length - 1) return;
		const newPaths = [...workingComposePaths];
		[newPaths[index], newPaths[index + 1]] = [newPaths[index + 1], newPaths[index]];
		workingComposePaths = newPaths;
		if (index === 0) workingComposePath = newPaths[0];
		isDirty = true;
	}

	function dragStart(e: DragEvent, index: number) {
		dragIndex = index;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		}
	}

	function dragOver(e: DragEvent, index: number) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		if (dragIndex === null || dragIndex === index) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const before = e.clientY < rect.top + rect.height / 2;
		const targetIndex = before ? index : index + 1;
		const newPaths = [...workingComposePaths];
		const [moved] = newPaths.splice(dragIndex, 1);
		const insertAt = dragIndex < targetIndex ? targetIndex - 1 : targetIndex;
		newPaths.splice(insertAt, 0, moved);
		workingComposePaths = newPaths;
		dragIndex = insertAt;
		if (insertAt === 0) workingComposePath = newPaths[0];
		isDirty = true;
	}

	function dragEnd() {
		dragIndex = null;
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

	async function copyComposePathAtIndex(path: string, index: number) {
		if (!path) return;
		const ok = await copyToClipboard(path);
		composePathCopied = ok ? 'ok' : 'error';
		composePathCopiedIndex = index;
		setTimeout(() => {
			composePathCopied = null;
			composePathCopiedIndex = null;
		}, 2000);
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
				if (!workingComposePaths.includes(finalPath)) {
					workingComposePaths = [finalPath, ...workingComposePaths];
				}
				workingEnvPath = `${dir}/.env`;
				browsedBaseDirectory = null;
				// 'custom' prevents the path effect from overriding (it only acts on 'browsed')
				pathSource = 'custom';
				maybeDeriveStackNameFromCompose(finalPath);
			} else {
				pathSource = 'browsed';
			}
			isDirty = true;
			return;
		}

		// EDIT mode - store the selected path
		workingComposePath = finalPath;
		if (!workingComposePaths.includes(finalPath)) {
			workingComposePaths = [finalPath, ...workingComposePaths];
		}
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
				loadError = null;
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
	let validatePanelRef: ComposeValidatePanel | null = $state(null);

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

	const defaultCompose = $appSettings.defaultComposeTemplate;

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

		// Add missing required variables - but a var the bound provider currently has
		// (live probe) is 'invault' (green), not 'missing' (red). A failed probe forces
		// MISSING so we never show a false green.
		for (const name of envValidation.missing) {
			const env = envVarMap.get(name);
			markers.push({
				name,
				type: classifyMarker(name, true, providerKeySet, probeError !== null),
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
		if (activeComposePath) {
			composeContents = { ...composeContents, [activeComposePath]: value };
		}
		isDirty = true;
		debouncedValidate();
	}

	function switchComposeFile(path: string) {
		if (path === activeComposePath) return;
		// Save current content before switching
		if (activeComposePath) {
			composeContents = { ...composeContents, [activeComposePath]: composeContent };
		}
		activeComposePath = path;
		composeContent = composeContents[path] || '';
	}

	// Debounced validation to avoid too many API calls while typing. The live
	// provider probe rides the same cadence so it doesn't hammer the provider.
	function debouncedValidate() {
		if (validateTimer) clearTimeout(validateTimer);
		validateTimer = setTimeout(() => {
			validateEnvVars();
			runProbe();
		}, 1000);
	}

	// op://... inline references in the current env vars, mapped var -> ref, so a
	// resolved ref (the provider returns ref STRINGS) maps back to its var name.
	function inlineRefPairs(): { varName: string; ref: string }[] {
		const pairs: { varName: string; ref: string }[] = [];
		for (const v of envVars) {
			const key = v.key.trim();
			const val = (v.value ?? '').trim();
			if (key && val.startsWith('op://')) pairs.push({ varName: key, ref: val });
		}
		return pairs;
	}

	// Live-probe the bound provider for which required keys exist RIGHT NOW. Only
	// key NAMES cross the wire. Guardrails: a provider must be selected; on any
	// failure the key set is emptied and probeError is set (-> everything MISSING,
	// never a false green). Guarded by probeSeq to drop stale responses.
	async function runProbe() {
		if (formSecretProviderId === null) {
			providerKeySet = new Set();
			probeError = null;
			return;
		}
		const selector = (() => {
			for (const name of SELECTOR_VARS) {
				const hit = envVars.find((v) => v.key.trim() === name);
				if (hit && hit.value.trim()) return hit.value.trim();
			}
			return undefined;
		})();
		const refPairs = inlineRefPairs();
		if (!selector && refPairs.length === 0) {
			providerKeySet = new Set();
			probeError = null;
			updateEditorMarkers();
			return;
		}
		const seq = ++probeSeq;
		try {
			const response = await fetch(`/api/secret-providers/${formSecretProviderId}/probe`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ selector, refs: refPairs.map((p) => p.ref) })
			});
			if (seq !== probeSeq) return; // a newer probe superseded this one
			const data = await response.json();
			if (!response.ok || !data.ok) {
				providerKeySet = new Set();
				probeError = data.error || `Provider check failed (${response.status})`;
			} else {
				const names = [
					...(data.bulkKeys ?? []),
					...resolvedRefVarNames(refPairs, data.resolvedRefs ?? [])
				];
				providerKeySet = new Set(names);
				probeError = null;
			}
		} catch (e) {
			if (seq !== probeSeq) return;
			providerKeySet = new Set();
			probeError = e instanceof Error ? e.message : 'Provider check failed';
		}
		updateEditorMarkers();
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

	const composePathsLocked = $derived(readonly || (mode === 'edit' && !needsFileLocation));
	const activeComposeDisplayPath = $derived(activeComposePath || workingComposePaths[0] || workingComposePath || '');

	function shortGitUrl(url: string): string {
		return url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
	}

	function composeFileName(path: string): string {
		return path.split('/').pop() || path;
	}

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

		fetchSecretProviders();
	});

	async function fetchSecretProviders() {
		try {
			const response = await fetch('/api/secret-providers');
			if (!response.ok) return;
			const data = await response.json();
			secretProviders = (data ?? []).map((p: any) => ({ id: p.id, name: p.name, type: p.type }));
		} catch (e) {
			console.warn('Failed to load secret providers:', e);
		}
	}

	onDestroy(() => {
		window.removeEventListener('mousemove', handleMouseMove);
		window.removeEventListener('mouseup', handleMouseUp);
	});

	// Split panel drag handlers
	function startSplitDrag(e: MouseEvent) {
		e.preventDefault();
		isDraggingSplit = true;
	}

	// Validate side-panel width (px), drag-resizable, persisted.
	const STORAGE_KEY_VALIDATE_W = 'dockhand-validate-panel-width';
	let validatePanelWidth = $state(
		typeof localStorage !== 'undefined'
			? Math.max(320, Number(localStorage.getItem(STORAGE_KEY_VALIDATE_W)) || 320)
			: 320
	);
	let isDraggingValidate = $state(false);
	let editorRowRef = $state<HTMLDivElement | null>(null);
	function startValidateDrag(e: MouseEvent) {
		e.preventDefault();
		isDraggingValidate = true;
	}

	function handleMouseMove(e: MouseEvent) {
		if (isDraggingSplit && containerRef) {
			const rect = containerRef.getBoundingClientRect();
			const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
			splitRatio = Math.max(30, Math.min(80, newRatio));
		}
		if (isDraggingValidate && editorRowRef) {
			const rect = editorRowRef.getBoundingClientRect();
			// panel is on the right: width = distance from cursor to the row's right edge.
			const w = rect.right - e.clientX;
			// Floor at 320px: below that the header's title + count chips + re-check button
			// no longer fit on one line and start clipping.
			validatePanelWidth = Math.max(320, Math.min(560, w));
		}
	}

	function handleMouseUp() {
		if (isDraggingSplit) {
			isDraggingSplit = false;
			// Save split ratio
			localStorage.setItem(STORAGE_KEY_SPLIT, splitRatio.toString());
		}
		if (isDraggingValidate) {
			isDraggingValidate = false;
			localStorage.setItem(STORAGE_KEY_VALIDATE_W, String(validatePanelWidth));
		}
	}

	// Populate the backup picker's volume/bind list from this stack's containers'
	// mounts. Runs for BOTH the managed (internal) load path and the
	// needs-file-location path, so an internal stack's backup panel is never empty.
	async function loadStackVolumes(envId: number | null) {
		const contRes = await fetch(appendEnvParam('/api/containers', envId));
		if (contRes.ok) {
			stackVolumes = volumesForStack(await contRes.json(), stackName);
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
					composeContents = {};
					activeComposePath = workingComposePath || '';
					rawEnvContent = '';
					loadError = null;
					loading = false; // Important: stop loading spinner

					// Fetch backup schedule count (BETA GATE: only when backups enabled)
					if ($page.data.backupsEnabled) try {
						const bp = new URLSearchParams({ target: stackName, type: 'stack' });
						if (envId) bp.set('env', String(envId));
						const bRes = await fetch(`/api/backup/configs?${bp}`);
						if (bRes.ok) {
							const bData = await bRes.json();
							const cfgs = Array.isArray(bData) ? bData : bData?.id ? [bData] : [];
							backupCount = cfgs.length;
							if (cfgs.length > 0) {
								const t = await fetchBackupExecutions(cfgs.map((c: any) => c.id));
								backupTally = { ok: t.ok, failed: t.failed };
							}
						}
					} catch {}

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

						// Volumes/binds for the backup picker — derived from this stack's
						// containers' mounts (same normalizer used by the other backup surfaces).
						await loadStackVolumes(envId);
					} catch (e) {
						console.error('Failed to fetch stack containers:', e);
					}
					return;
				}
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to load compose file');
			}

			composeContent = data.content || '';
			activeComposePath = data.composePath || '';
			// Populate multi-file content map
			if (data.composeContents) {
				composeContents = data.composeContents;
			} else {
				composeContents = activeComposePath ? { [activeComposePath]: composeContent } : {};
			}
			// Set working paths
			workingComposePath = data.composePath || '';
			workingEnvPath = data.envPath || '';
			// The compose endpoint returns resolved paths as an array; retain support
			// for the persisted JSON string used by older responses.
			if (Array.isArray(data.composePaths)) {
				workingComposePaths = data.composePaths;
			} else {
				try {
					workingComposePaths = data.composePaths ? JSON.parse(data.composePaths) : (workingComposePath ? [workingComposePath] : []);
				} catch {
					workingComposePaths = workingComposePath ? [workingComposePath] : [];
				}
			}
			// Track original paths for detecting changes
			originalComposePath = data.composePath || null;
			originalEnvPath = data.envPath || null;

			// Load secret provider binding
			try {
				const sourcesRes = await fetch(appendEnvParam('/api/stacks/sources', envId));
				if (sourcesRes.ok) {
					const sourceMap = await sourcesRes.json();
					const source = sourceMap?.[stackName];
					formSecretProviderId = source?.secretProviderId ?? null;
				}
			} catch (e) {
				console.warn('Failed to load stack source for secret provider binding:', e);
			}

			// Volumes/binds for the backup picker (managed/internal stack path).
			try {
				await loadStackVolumes(envId);
			} catch (e) {
				console.error('Failed to load stack volumes:', e);
			}

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
				// Provider-injected key names from the last deploy (banner)
				injectedSecretKeys = envData.injectedSecretKeys ?? [];
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
		} else if (!/^[a-z0-9][a-z0-9_-]*$/.test(newStackName.trim())) {
			errors.stackName = 'Must be lowercase, start with a letter or number, and only contain letters, numbers, hyphens, and underscores';
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
		// If env panel is unmounted (e.g. graph tab active), use bound state directly
		const prepared = envVarsPanelRef?.prepareForSave() || { rawContent: rawEnvContent, variables: envVars };

		let response: Response | undefined;
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
			if (workingComposePaths.length > 0) {
				requestBody.composePaths = workingComposePaths;
			}
			// Use working env path or suggested path
			const envPathToSave = workingEnvPath.trim() || suggestedEnvPath || '';
			if (envPathToSave) {
				requestBody.envPath = envPathToSave;
			}

			requestBody.secretProviderId = formSecretProviderId;

			// Include multi-file compose contents if present
			if (Object.keys(composeContents).length > 0) {
				// Ensure current editor content is reflected before saving
				const contentsToSave = { ...composeContents };
				if (activeComposePath) {
					contentsToSave[activeComposePath] = composeContent;
				}
				requestBody.composeContents = contentsToSave;

				// Prevent data loss: explicitly set primary compose content
				const primaryPath = workingComposePath || (workingComposePaths && workingComposePaths.length > 0 ? workingComposePaths[0] : activeComposePath);
				if (primaryPath && contentsToSave[primaryPath]) {
					requestBody.compose = contentsToSave[primaryPath];
				}
			}

			// Create the stack
			response = await fetch(appendEnvParam('/api/stacks', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody)
			});

			// When start=true, response is a job or JSON; when start=false, it's plain JSON
			const data = start ? await readJobResponse(response) : await response.json();

			if (!response.ok && !data.success) {
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to create stack');
			}
			if (data.success === false) {
				throw new Error(data.error || 'Failed to create stack');
			}

			toast.success(`Created stack "${newStackName.trim()}"`);
			onSuccess();
			handleClose();
		} catch (e: any) {
			operationError = {
				title: 'Failed to create stack',
				message: e.message || 'An error occurred while creating the stack',
				details: e.details
			};
			// Only transition to edit mode if the stack was actually persisted (response was ok
			// but deploy failed). A 400 from validation means nothing was saved — stay in create
			// mode so the name field remains visible and the user can fix the error.
			if (start && response?.ok) {
				mode = 'edit';
				stackName = newStackName.trim();
				onSuccess(); // refresh stack list so the new stack appears
			}
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
		// If env panel is unmounted (e.g. graph tab active), use bound state directly
		const prepared = envVarsPanelRef?.prepareForSave() || { rawContent: rawEnvContent, variables: envVars };

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
			if (workingComposePaths.length > 0) {
				requestBody.composePaths = workingComposePaths;
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

			requestBody.secretProviderId = formSecretProviderId;

			// Include multi-file compose contents if present
			if (Object.keys(composeContents).length > 0) {
				// Ensure current editor content is reflected before saving
				const contentsToSave = { ...composeContents };
				if (activeComposePath) {
					contentsToSave[activeComposePath] = composeContent;
				}
				requestBody.composeContents = contentsToSave;

				// Prevent data loss: explicitly set primary compose content
				const primaryPath = workingComposePath || (workingComposePaths && workingComposePaths.length > 0 ? workingComposePaths[0] : activeComposePath);
				if (primaryPath && contentsToSave[primaryPath]) {
					requestBody.content = contentsToSave[primaryPath];
				}
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

			// When restart=true, response is a job or JSON; when restart=false, it's plain JSON
			const data = restart ? await readJobResponse(response) : await response.json();

			if (!response.ok && !data.success) {
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to save compose file');
			}
			if (data.success === false) {
				throw new Error(data.error || 'Failed to save compose file');
			}

			isDirty = false; // Reset dirty flag after successful save
			toast.success(restart ? 'Stack applied' : 'Stack saved');
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
		if (isDirty || backupPanelRef?.isDirty()) {
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
		// Reset mode back to prop values
		mode = propMode;
		stackName = propStackName;
		// Reset all state
		newStackName = '';
		error = null;
		loadError = null;
		rawEnvContent = '';
		errors = {};
		composeContent = '';
		composeContents = {};
		activeComposePath = '';
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
		workingComposePaths = [];
		workingEnvPath = '';
		originalComposePath = null;
		originalEnvPath = null;
		autoComputedComposePath = '';
		pathSource = null;
		browsedBaseDirectory = null;
		stackNameUserEdited = false;
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
			// Reset mode to prop values on each open
			mode = propMode;
			stackName = propStackName;
			// Clear any compose-validate panel state from a previous open (the modal is
			// persistently mounted, so $state survives close/reopen - even across envs).
			validatePanelOpen = false;
			validateReport = null;
			validateError = null;
			validateLoading = false;
			validateActiveLine = null;
			validateSeq++;
			if (mode === 'edit' && stackName) {
				loadComposeFile().then(() => {
					// Auto-validate after loading
					validateEnvVars();
					runProbe();
				});
			} else if (mode === 'create') {
				// Set default compose content for create mode (library templates override default)
				composeContent = initialCompose || defaultCompose;
				if (initialStackName) {
					newStackName = initialStackName;
					stackNameUserEdited = true;
				}
				isDirty = false; // Reset dirty flag for new modal
				loading = false;
				// Auto-validate default compose
				validateEnvVars();
				runProbe();
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
			runProbe();
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
			workingComposePaths = [];
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
			workingComposePaths = [workingComposePath];
			workingEnvPath = `${browsedBaseDirectory}/${name}/.env`;
			pathSource = 'browsed';
			return;
		}

		// Use pre-fetched default base directory
		if (defaultStackDir) {
			const dir = `${defaultStackDir}/${name}`;
			autoComputedComposePath = `${dir}/compose.yaml`;
			workingComposePath = `${dir}/compose.yaml`;
			workingComposePaths = [workingComposePath];
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
			// Prevent closing if there are unsaved changes (stack edits OR a half-edited
			// backup schedule in the embedded panel) - show confirmation instead
			if (isDirty || backupPanelRef?.isDirty()) {
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
		class="max-w-none w-[calc(100vw-4rem)] h-[95vh] flex flex-col p-0 gap-0 shadow-xl border-zinc-200 dark:border-zinc-700"
		showCloseButton={false}
	>
		<Dialog.Header class="px-8 py-5 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-start gap-3.5 min-w-0">
					<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-300 bg-zinc-100 text-primary dark:border-zinc-600 dark:bg-zinc-800">
						<Layers class="h-5 w-5" />
					</div>
					<div class="min-w-0">
						<Dialog.Title class="flex flex-wrap items-center gap-2 text-base font-semibold text-zinc-800 dark:text-zinc-100">
							{displayName}
							{#if mode === 'edit' && stackSource}
								{#if stackSource.sourceType === 'git'}
									<GitSourceBadge source={stackSource} showTooltip={false} />
								{:else if stackSource.sourceType === 'internal'}
									<span class="inline-flex items-center gap-1 rounded-sm bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-800 shadow-sm dark:bg-blue-900 dark:text-blue-200">
										<FileCode class="h-3 w-3" />
										Internal
									</span>
								{:else}
									<span class="inline-flex items-center gap-1 rounded-sm bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-800 shadow-sm dark:bg-gray-800 dark:text-gray-200">
										<ExternalLink class="h-3 w-3" />
										Untracked
									</span>
								{/if}
							{/if}
						</Dialog.Title>
						<Dialog.Description class="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
							{#if mode === 'create'}
								Create a new Docker Compose stack
							{:else if readonly}
								Compose file and dependency graph
							{:else}
								Edit compose file and environment variables
							{/if}
						</Dialog.Description>
						{#if readonly && gitInfo && (gitInfo.commit || gitInfo.url || gitInfo.branch)}
							<div class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
								{#if gitInfo.commit}
									<span class="group flex items-center gap-1.5 font-mono">
										<GitCommitHorizontal class="h-3.5 w-3.5 shrink-0 opacity-70" />
										<code>{gitInfo.commit}</code>
										<button
											type="button"
											class="rounded p-0.5 opacity-0 transition-opacity hover:bg-zinc-200 group-hover:opacity-100 dark:hover:bg-zinc-700"
											title="Copy commit hash"
											onclick={() => copyText(gitInfo.commit ?? null, (v) => gitCommitCopied = v)}
										>
											{#if gitCommitCopied === 'ok'}<Check class="h-3 w-3 text-green-500" />{:else}<Copy class="h-3 w-3" />{/if}
										</button>
									</span>
								{/if}
								{#if gitInfo.url}
									<span class="flex min-w-0 items-center gap-1.5">
										<Github class="h-3.5 w-3.5 shrink-0 opacity-70" />
										<a
											href={gitInfo.url}
											target="_blank"
											rel="noopener noreferrer"
											class="truncate hover:text-primary"
										>
											{shortGitUrl(gitInfo.url)}
										</a>
									</span>
								{/if}
								{#if gitInfo.branch}
									<span class="flex items-center gap-1.5">
										<GitBranch class="h-3.5 w-3.5 shrink-0 opacity-70" />
										{gitInfo.branch}
									</span>
								{/if}
							</div>
						{/if}
					</div>
				</div>

				<div class="flex shrink-0 items-center gap-2">
					{#if activeTab === 'editor'}
						<button
							type="button"
							onclick={toggleEditorTheme}
							class="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:text-zinc-300"
							title={editorTheme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
						>
							{#if editorTheme === 'light'}
								<Moon class="h-4 w-4" />
							{:else}
								<Sun class="h-4 w-4" />
							{/if}
						</button>
					{/if}
					<button
						type="button"
						onclick={tryClose}
						class="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:text-zinc-300"
						title="Close"
					>
						<X class="h-4 w-4" />
					</button>
				</div>
			</div>
		</Dialog.Header>

		<!-- View tabs — left-aligned underline bar under the header, matched to
		     GitStackModal for a consistent look across the stack modals. -->
		<div class="flex items-center gap-1 border-b border-zinc-200 px-5 dark:border-zinc-700 flex-shrink-0">
			<button
				type="button"
				class="relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors {activeTab === 'editor' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => activeTab = 'editor'}
			>
				<Code class="h-3.5 w-3.5" /> Editor
			</button>
			<button
				type="button"
				class="relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors {activeTab === 'graph' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => activeTab = 'graph'}
			>
				<GitGraph class="h-3.5 w-3.5" /> Graph
			</button>
			<!-- BETA GATE: Backups tab hidden unless FEAT_BACKUPS_ENABLED (see features.ts).
			     Also hidden for UNTRACKED stacks: with no known compose file the backup
			     would be incomplete (can't redeploy at restore), so the backend refuses
			     it (assertStackBackupable) — don't offer it in the UI either. -->
			{#if mode === 'edit' && $page.data.backupsEnabled && !needsFileLocation}
				<button
					type="button"
					class="relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors {activeTab === 'backups' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => activeTab = 'backups'}
				>
					<Archive class="h-3.5 w-3.5" /> Backups
					{#if backupCount > 0}<span class="bg-primary/15 text-primary text-[10px] px-1.5 rounded-full font-medium">{backupCount}</span>{/if}
					{#if backupTally.ok > 0}<span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-500"><Check class="w-2.5 h-2.5" />{backupTally.ok}</span>{/if}
					{#if backupTally.failed > 0}<span class="inline-flex items-center gap-0.5 rounded-full bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-500"><X class="w-2.5 h-2.5" />{backupTally.failed}</span>{/if}
				</button>
			{/if}
		</div>

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
									oninput={() => {
										stackNameUserEdited = true;
										errors.stackName = undefined;
									}}
								/>
								{#if errors.stackName}
									<p class="text-xs text-destructive">{errors.stackName}</p>
								{/if}
							</div>
						</div>
					</div>
				{/if}

				<!-- File location needed banner -->
				{#if mode === 'edit' && needsFileLocation && !readonly}
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
						<div class="flex flex-1 min-h-0">
							<!-- Compose panel -->
							<div class="flex min-h-0 min-w-0 flex-shrink-0 flex-col" style="width: {splitRatio}%">
								<div class="flex min-h-0 flex-1 flex-col px-8 py-6">
									<div class="mb-3.5 flex flex-wrap items-center justify-between gap-3">
										<div class="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
											<Code class="h-4 w-4 text-muted-foreground" />
											Compose files
											{#if workingComposePaths.length > 0}
												<span class="text-xs font-normal text-muted-foreground">({workingComposePaths.length})</span>
											{/if}
										</div>
									{#if mode === 'edit' && !readonly && !needsFileLocation}
										<button type="button" class="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground" onclick={openChangeLocationBrowser}>
											<FolderSync class="h-3.5 w-3.5" /> Relocate
										</button>
									{/if}
									</div>

									{#if !composePathsLocked}
										<div class="mb-3 space-y-1.5 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/40">
											{#each workingComposePaths as path, i}
												{@const total = workingComposePaths.length}
												{@const isDragging = dragIndex === i}
												<div
													class="flex min-w-0 items-center gap-1 overflow-hidden {isDragging ? 'opacity-40' : ''}"
													draggable={mode === 'create' || needsFileLocation}
													ondragstart={(e) => dragStart(e, i)}
													ondragover={(e) => dragOver(e, i)}
													ondrop={(e) => e.preventDefault()}
													ondragend={dragEnd}
												>
													{#if total > 1}
														<div class="flex shrink-0 flex-col -space-y-0.5">
															<button type="button" title="Move up" disabled={i === 0} onclick={() => movePathUp(i)} class="p-0 hover:text-muted-foreground disabled:cursor-default disabled:opacity-30">
																<ArrowUp class="h-3 w-3" />
															</button>
															<button type="button" title="Move down" disabled={i === total - 1} onclick={() => movePathDown(i)} class="p-0 hover:text-muted-foreground disabled:cursor-default disabled:opacity-30">
																<ArrowDown class="h-3 w-3" />
															</button>
														</div>
														<GripVertical class="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/40" />
													{/if}
													<input
														type="text"
														bind:value={workingComposePaths[i]}
														placeholder={i === 0 ? '/path/to/compose.yaml' : 'compose.override.yaml'}
														class="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
														oninput={() => { if (i === 0) { workingComposePath = workingComposePaths[i]; } isDirty = true; }}
													/>
													<button type="button" onclick={() => browseForRow(i)} class="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted" title="Browse for file">
														<FolderOpen class="h-3.5 w-3.5" />
													</button>
													{#if total > 1}
														<button type="button" onclick={() => removeComposePath(i)} class="shrink-0 rounded p-1 text-muted-foreground hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-900/30" title="Remove">
															<X class="h-3.5 w-3.5" />
														</button>
													{/if}
												</div>
											{:else}
												<div class="flex items-center gap-1">
													<input type="text" readonly placeholder={mode === 'create' ? 'Enter stack name above' : 'Not specified'} class="min-w-0 flex-1 rounded border bg-muted/50 px-2 py-1 text-xs text-muted-foreground" />
													<button type="button" onclick={openComposeBrowser} class="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted" title="Browse for file">
														<FolderOpen class="h-3.5 w-3.5" />
													</button>
												</div>
											{/each}
											{#if workingComposePaths.length > 0}
												<button type="button" onclick={() => addComposePath()} class="inline-flex items-center gap-1 rounded border bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/80">
													+ Add compose file
												</button>
											{/if}
										</div>
									{/if}

									{#if workingComposePaths.length > 0}
										<div class="flex gap-0.5 overflow-x-auto border-b border-zinc-200 dark:border-zinc-700" role="tablist" aria-label="Compose files">
											{#each workingComposePaths as path, i}
												<div
													role="tab"
													tabindex={path === (activeComposePath || workingComposePaths[0]) ? 0 : -1}
													aria-selected={path === (activeComposePath || workingComposePaths[0])}
													onclick={() => switchComposeFile(path)}
													onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchComposeFile(path); } }}
													class="group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md border-b-2 px-3.5 py-2.5 font-mono text-xs transition-colors {path === (activeComposePath || workingComposePaths[0]) ? 'border-primary bg-zinc-50 text-foreground dark:bg-zinc-800/50' : 'border-transparent text-muted-foreground hover:bg-zinc-50 hover:text-foreground dark:hover:bg-zinc-800/30'}"
												>
													{composeFileName(path)}
													<button
														type="button"
														class="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 {path === (activeComposePath || workingComposePaths[0]) ? 'opacity-100' : ''}"
														title="Copy path"
														onclick={(e) => { e.stopPropagation(); copyComposePathAtIndex(path, i); }}
													>
														{#if composePathCopied === 'ok' && composePathCopiedIndex === i}
															<Check class="h-3 w-3 text-green-500" />
														{:else}
															<Copy class="h-3 w-3" />
														{/if}
													</button>
												</div>
											{/each}
										</div>
									{/if}

									<div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/40 {workingComposePaths.length > 0 ? 'rounded-t-none border-t-0' : ''}">
										{#if open}
											{#if loadError}
												<div class="flex h-full flex-col items-center justify-center px-8 text-center">
													<TriangleAlert class="mb-4 h-12 w-12 text-red-400" />
													<h3 class="mb-2 text-sm font-medium text-red-700 dark:text-red-300">Failed to load compose file</h3>
													<p class="max-w-sm break-all text-xs text-red-600 dark:text-red-400">{loadError}</p>
												</div>
											{:else if readonly && needsFileLocation && !composeContent}
												<div class="flex h-full flex-col items-center justify-center px-8 text-center">
													<GitGraph class="mb-4 h-12 w-12 text-zinc-300 dark:text-zinc-600" />
													<h3 class="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">Compose file not available</h3>
													<p class="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
														Deploy or sync this Git stack first so Dockhand has a local copy of its compose file.
													</p>
												</div>
											{:else if needsFileLocation && !composeContent}
												<div class="flex h-full flex-col items-center justify-center px-8 text-center">
													<FolderOpen class="mb-4 h-12 w-12 text-zinc-300 dark:text-zinc-600" />
													<h3 class="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">No compose file selected</h3>
													<p class="mb-4 max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
														Browse to locate the compose file for this stack.
													</p>
													<Button variant="outline" size="sm" onclick={openComposeBrowser}>
														<FolderOpen class="h-4 w-4" />
														Browse for compose file
													</Button>
												</div>
											{:else}
												<div class="flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-100/80 px-3.5 py-2 dark:border-zinc-700 dark:bg-zinc-800/60">
													<span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={activeComposeDisplayPath}>
														{activeComposeDisplayPath || 'No file selected'}
													</span>
													<div class="flex items-center gap-1">
														<Button
															variant="ghost"
															size="sm"
															class="h-7 shrink-0 px-2 text-xs text-muted-foreground"
															onclick={runComposeValidate}
															disabled={!composeContent}
															title="Check this compose for problems before deploy"
														>
															{#if validateLoading}
																<Loader2 class="w-3 h-3 animate-spin" />
															{:else}
																<ListChecks class="w-3 h-3" />
															{/if}
															Validate
														</Button>
														<Button
															variant="ghost"
															size="sm"
															class="h-7 shrink-0 px-2 text-xs text-muted-foreground"
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
												</div>
												<div bind:this={editorRowRef} class="flex-1 min-h-0 flex">
													<CodeEditor
														bind:this={codeEditorRef}
														value={composeContent}
														language="yaml"
														{readonly}
														theme={editorTheme}
														onchange={readonly ? undefined : handleComposeChange}
														variableMarkers={variableMarkers}
														lintMarkers={validateMarkers}
														onLintClick={openValidateAtLine}
														class="min-h-0 flex-1 overflow-hidden"
													/>
													{#if validatePanelOpen}
														<!-- Resize handle -->
														<div
															class="w-1 mx-1 flex-shrink-0 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors flex items-center justify-center group {isDraggingValidate ? 'bg-blue-500 dark:bg-blue-400' : ''}"
															onmousedown={startValidateDrag}
															role="separator"
															aria-orientation="vertical"
															tabindex="0"
														>
															<div class="w-4 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity {isDraggingValidate ? 'opacity-100' : ''}">
																<GripVertical class="w-3 h-3 text-white" />
															</div>
														</div>
														<div class="shrink-0 min-h-0" style="width: {validatePanelWidth}px">
															<ComposeValidatePanel
																bind:this={validatePanelRef}
																report={validateReport}
																loading={validateLoading}
																error={validateError}
																activeLine={validateActiveLine}
																onClose={closeValidatePanel}
																onJumpToLine={jumpToComposeLine}
																onRevalidate={runComposeValidate}
																onApplyFix={applyValidateFix}
															/>
														</div>
													{/if}
												</div>
											{/if}
										{/if}
									</div>
								</div>
							</div>

							<!-- Resizable divider -->
							<div
								class="w-1 flex-shrink-0 bg-zinc-200 dark:bg-zinc-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors flex items-center justify-center group {isDraggingSplit ? 'bg-blue-500 dark:bg-blue-400' : ''}"
								onmousedown={startSplitDrag}
								role="separator"
								aria-orientation="vertical"
								tabindex="0"
							>
								<div class="flex h-8 w-4 items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 {isDraggingSplit ? 'opacity-100' : ''}">
									<GripVertical class="h-3 w-3 text-white" />
								</div>
							</div>

							<!-- Environment variables panel -->
							<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
								<div class="flex min-h-0 flex-1 flex-col px-8 py-6">
									<div class="mb-3.5 flex items-center justify-between gap-3">
										<div class="flex items-center gap-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
											<FileText class="h-4 w-4 text-muted-foreground" />
											Environment variables
										</div>
									</div>

									<SecretProviderPicker
										bind:secretProviderId={formSecretProviderId}
										bind:envVars
										providers={secretProviders}
										onchange={() => { markDirty(); debouncedValidate(); }}
									/>

									<div class="mb-5 flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3.5 py-3 dark:border-zinc-700 dark:bg-zinc-800/40">
										<FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
										<div class="min-w-0 flex-1">
											<div class="text-[11px] text-muted-foreground">Env file</div>
											<div class="truncate font-mono text-xs text-zinc-600 dark:text-zinc-300" title={displayEnvPath}>
												{displayEnvPath || (mode === 'create' ? 'Enter stack name above' : 'Not specified')}
											</div>
										</div>
										{#if !readonly}
											<button type="button" onclick={openEnvBrowser} class="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-zinc-200 dark:hover:bg-zinc-700" title="Browse for env file">
												<FolderOpen class="h-3.5 w-3.5" />
											</button>
										{/if}
										<button
											type="button"
											onclick={() => copyText(displayEnvPath, (v) => envPathCopied = v)}
											class="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-zinc-200 dark:hover:bg-zinc-700 {!displayEnvPath ? 'cursor-not-allowed opacity-40' : ''}"
											title="Copy path"
											disabled={!displayEnvPath}
										>
											{#if envPathCopied === 'ok'}
												<Check class="h-3.5 w-3.5 text-green-500" />
											{:else}
												<Copy class="h-3.5 w-3.5" />
											{/if}
										</button>
									</div>

									<StackEnvVarsPanel
										bind:this={envVarsPanelRef}
										bind:variables={envVars}
										bind:rawContent={rawEnvContent}
										validation={effectiveValidation}
										existingSecretKeys={mode === 'edit' ? existingSecretKeys : new Set()}
										injectedSecretKeys={mode === 'edit' ? injectedSecretKeys : []}
										providerType={selectedProviderType}
										providerName={selectedProviderName}
										{probeError}
										{providerKeySet}
										{readonly}
										hideHeader
										onchange={() => { markDirty(); debouncedValidate(); }}
										theme={editorTheme}
										infoText="These variables will be written to a .env file in the stack directory and passed to the compose command."
										class="min-h-0 flex-1"
									/>
								</div>
							</div>
						</div>
					{:else if activeTab === 'graph'}
						<!-- Graph tab: Full width -->
						<ComposeGraphViewer
							bind:this={graphViewerRef}
							composeContent={composeContent || (mode === 'create' ? defaultCompose : '')}
							class="h-full flex-1"
							onContentChange={readonly ? undefined : handleGraphContentChange}
							{readonly}
						/>
					{:else if activeTab === 'backups' && !needsFileLocation}
						<!-- Backups tab (never for untracked stacks — see the tab gate above) -->
						<div class="h-full flex-1 overflow-auto p-4">
							<BackupPanel
								bind:this={backupPanelRef}
								containerName={stackName}
								volumes={stackVolumes}
								type="stack"
								onTally={(t) => (backupTally = t)}
							/>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Footer -->
		<div class="flex flex-shrink-0 items-center justify-between border-t border-zinc-200 px-8 py-3 dark:border-zinc-700">
			<div class="flex min-w-0 items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
				{#if readonly}
					<Lock class="h-3.5 w-3.5 shrink-0" />
					<span>All files are synced from Git and read-only. Edit the compose files in your repository and redeploy to apply changes.</span>
				{:else if isDirty}
					<span class="text-amber-600 dark:text-amber-500">Unsaved changes</span>
				{:else}
					No changes
				{/if}
			</div>

			<div class="flex items-center gap-2">
				{#if readonly}
					<Button onclick={tryClose}>Close</Button>
				{:else}
					<Button variant="outline" onclick={tryClose} disabled={saving}>
						Cancel
					</Button>
				{/if}

				{#if !readonly && mode === 'create'}
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
				{:else if !readonly}
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
	multiSelect={fileBrowserConfig.multiSelect ?? false}
	onSelectMany={fileBrowserConfig.onSelectMany}
	onClose={() => showFileBrowser = false}
/>
