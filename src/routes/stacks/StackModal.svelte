<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
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
	import { Layers, Save, Play, Code, GitGraph, GitBranch, GitCommitHorizontal, Github, Loader2, AlertCircle, X, Sun, Moon, TriangleAlert, GripVertical, GripHorizontal, FolderOpen, Copy, Check, XCircle, MapPin, ArrowRight, ArrowUp, ArrowDown, Info, Box, FolderSync, Archive, Lock, FileText, ListChecks, History, ChevronDown } from 'lucide-svelte';
	import ComposeValidatePanel from './ComposeValidatePanel.svelte';

	import BackupPanel from '../containers/BackupPanel.svelte';
	import DeploysPanel from './DeploysPanel.svelte';
	import DeployOutputHeader from './DeployOutputHeader.svelte';
	import { deployTallyFromRuns } from '$lib/utils/deploy-run-view';
	import { volumesForStack, type VolumeInfo } from '$lib/utils/mounts';
	import { fetchBackupExecutions } from '$lib/utils/backup';
	import type { Component } from 'svelte';
	import FilesystemBrowser from './FilesystemBrowser.svelte';
	import IconPickerModal from './IconPickerModal.svelte';
import StackIcon from '$lib/components/StackIcon.svelte';
import * as Tooltip from '$lib/components/ui/tooltip';
import * as Tabs from '$lib/components/ui/tabs';
	import { Badge } from '$lib/components/ui/badge';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { persistStackIcon } from '$lib/utils/stack-icon';
	import { appSettings } from '$lib/stores/settings';
	import { page } from '$app/stores'; // BETA GATE: backups feature flag
	import { focusFirstInput } from '$lib/utils';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { detectedComposeOverridePaths } from '$lib/compose-overrides';
	import * as Alert from '$lib/components/ui/alert';
	import { ErrorDialog } from '$lib/components/ui/error-dialog';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import { saveCloseTiming } from '$lib/utils/save-close-policy';
	import { clampNumber } from '$lib/utils/clamp-number';
	import LogViewer from '$lib/components/LogViewer.svelte';
	import { formatRunStatus } from '$lib/utils/run-status';
	import { toast } from 'svelte-sonner';
	import ComposeGraphViewer from './ComposeGraphViewer.svelte';
	import RedeployPopover from './RedeployPopover.svelte';
	import { hasBuildSection as detectBuildSection } from '$lib/utils/compose-build-detect';


	// localStorage key for persisted split ratio
	const STORAGE_KEY_SPLIT = 'dockhand-stack-modal-split';
	// Own key: this ratio has nothing to do with the compose/env split ratio above --
	// reusing STORAGE_KEY_SPLIT would mean resizing the editor/env divider also resizes
	// the unrelated output panel on the next load.
	const STORAGE_KEY_OUTPUT_SPLIT = 'dockhand-stack-modal-output-split';

	// How long a successful deploy leaves the modal open before auto-closing, so the
	// operator still glimpses the success and the compose output before it goes away
	// (operator decision, 30.08.2026 -- see save-close-policy.ts). The plain-save flash-
	// then-close delay (500ms, below) predates this and is left as it was.
	const DEPLOY_SUCCESS_CLOSE_DELAY_MS = 1500;

	// Options picked in the RedeployPopover next to "Save & redeploy" / "Create & Start"
	// (see the pull/build/forceRecreate contract RedeployPopover.svelte already uses for
	// the stack-grid redeploy actions).
	type DeployOptions = { pull: boolean; build: boolean; forceRecreate: boolean };

	interface Props {
		open: boolean;
		mode: 'create' | 'edit';
		stackName?: string; // Required for edit mode, optional for create
		initialCompose?: string; // Pre-fill compose content (for library deploy)
		initialStackName?: string; // Pre-fill stack name (for library deploy)
		readonly?: boolean; // View compose content without allowing local changes
		gitInfo?: { commit?: string; url?: string; branch?: string } | null; // Git provenance for read-only git stacks
		onClose: () => void;
		onSuccess: () => void; // Called after create or save
	}

	let { open = $bindable(), mode: propMode, stackName: propStackName = '', initialCompose, initialStackName, readonly = false, gitInfo = null, onClose, onSuccess }: Props = $props();

	let gitCommitCopied = $state<'ok' | 'error' | null>(null);

	// Local effective state - can transition from create → edit after failed deploy
	let mode = $state(propMode);
	let stackName = $state(propStackName);
	let formIcon = $state<string | null>(null);
	let showIconPicker = $state(false);
	// Create mode has no stack to POST to yet - stash the pending upload data URL and
	// send it once the stack is created (see persistPendingIcon after handleCreate).
	let pendingUploadImage = $state<string | null>(null);

	// The picker value is one of: '' (clear), 'upload:<dataUrl>' (custom upload), or a
	// lucide name / 'selfhst:<ref>'. In edit mode it persists immediately via the /icon
	// endpoint; in create mode it is held locally until the stack exists.
	async function onIconSelect(value: string) {
		if (mode !== 'edit' || !stackName) {
			// Create mode: hold locally, persist after the stack is created.
			if (!value) {
				formIcon = null;
				pendingUploadImage = null;
			} else if (value.startsWith('upload:')) {
				pendingUploadImage = value.slice('upload:'.length);
				formIcon = 'custom:stack';
			} else {
				pendingUploadImage = null;
				formIcon = value;
			}
			return;
		}
		const envId = $currentEnvironment?.id ?? null;
		const target = appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/icon`, envId);
		try {
			const next = await persistStackIcon(target, value);
			if (next !== undefined) formIcon = next; // undefined = POST failed, keep current
			onSuccess?.();
		} catch (e) {
			console.error('Failed to set stack icon:', e);
		}
	}

	// After a stack is created, persist the icon picked in create mode to the new stack.
	async function persistPendingIcon(name: string, envId: number | null) {
		if (!formIcon) return;
		const target = appendEnvParam(`/api/stacks/${encodeURIComponent(name)}/icon`, envId);
		const body = pendingUploadImage ? { image: pendingUploadImage } : { icon: formIcon };
		try {
			await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		} catch (e) {
			console.error('Failed to set stack icon:', e);
		}
	}

	// Form state
	let newStackName = $state('');
	let loading = $state(false);
	let saving = $state(false);
	let savingWithRestart = $state(false); // Track which save action is in progress
	let error = $state<string | null>(null);
	let loadError = $state<string | null>(null);
	let errors = $state<{ stackName?: string; compose?: string }>({});
	let composeContent = $state('');
	// Whether the current compose content declares a build: section for any service --
	// pre-checks "Build images" in the Save & redeploy / Create & Start popover
	// (RedeployPopover's defaultBuild). Logic lives in compose-build-detect.ts, not
	// inline, so it has its own unit test independent of mounting this component.
	let hasBuildSection = $derived(detectBuildSection(composeContent));
	// Single source of truth for "what does a direct click on the main button do",
	// shared between the button's own onclick AND the split-button popover's
	// defaultPull/defaultBuild/defaultForceRecreate props next to it -- so the two
	// paths (one-click vs pick-then-Deploy) can never drift into deploying with
	// different options for what looks like the same defaults.
	//
	// pull is always false on both: Save/Create already run against whatever images
	// are already local, pulling is an explicit extra step the operator reaches for
	// via the popover, not something either main button does silently.
	//
	// forceRecreate differs: Save & redeploy defaults to true, preserving the
	// endpoint's prior always-on behavior (env var changes need --force-recreate to
	// take effect) now that it's a real choice instead of hardcoded. Create & Start
	// defaults to false -- there is nothing to recreate on a stack that doesn't exist
	// yet.
	let saveRedeployDefaults = $derived<DeployOptions>({ pull: false, build: hasBuildSection, forceRecreate: true });
	let createStartDefaults = $derived<DeployOptions>({ pull: false, build: hasBuildSection, forceRecreate: false });
	let activeTab = $state<'editor' | 'graph' | 'backups' | 'deploys'>('editor');
	let composeContents = $state<Record<string, string>>({});   // path → content map for multi-file
	let activeComposePath = $state('');                           // currently viewed file path
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
	// Whether a provider is currently bound AND still exists (a deleted provider leaves
	// formSecretProviderId pointing at a gone id) - drives the historical banner (#1522).
	const selectedProviderBound = $derived(
		formSecretProviderId != null && secretProviders.some((p) => p.id === formSecretProviderId)
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

	// Live compose output for deploying operations (Create & Start, Save & redeploy),
	// rendered inline below the editor instead of in a separate window -- the modal
	// stays open while it runs, and afterwards for exactly as long as saveCloseTiming
	// (see save-close-policy.ts) says it should, so the output stays visible where the
	// result or the error it might explain also lives.
	let outputTitle = $state('');
	let outputLines = $state<string[]>([]);
	let outputRunning = $state(false);
	let outputOk = $state<boolean | undefined>(undefined);
	let outputMs = $state<number | undefined>(undefined);
	let outputExitCode = $state<number | undefined>(undefined);
	let outputStartedAt = 0;

	function startOutput(title: string) {
		outputTitle = title;
		outputLines = [];
		outputRunning = true;
		outputStartedAt = Date.now();
		outputOk = undefined;
		outputMs = undefined;
		outputExitCode = undefined;
	}

	function appendOutputLine(line: string) {
		outputLines = [...outputLines, line];
	}

	// Bumped after a deploy finishes so the Deploys tab re-fetches and shows the new run.
	let deploysReloadKey = $state(0);
	// Deploys tab badge tally (total + ok/failed). Fetched cheaply when the modal
	// opens so the badge shows immediately (not only once the tab is first viewed);
	// DeploysPanel's onTally then keeps it fresh once the tab is open.
	let deploysTally = $state<{ total: number; ok: number; failed: number }>({ total: 0, ok: 0, failed: 0 });
	// Whether run history exists at all -- gates the Deploys tab for a read-only /
	// not-yet-synced stack. Set ONLY by the parent's own fetch below, never by the
	// panel's live onTally, so opening the tab (which briefly reports total 0 while
	// loading) can't make the tab hide itself out from under the user.
	let deploysHistoryExists = $state(false);

	async function loadDeploysCount() {
		// Deploy history is keyed by stackName+env (schedule_executions), independent of
		// whether a local compose file exists -- so load it even for a read-only /
		// not-yet-synced stack (needsFileLocation), letting the Deploys tab appear when
		// there ARE runs to show.
		if (mode !== 'edit' || !stackName) {
			deploysTally = { total: 0, ok: 0, failed: 0 };
			deploysHistoryExists = false;
			return;
		}
		try {
			const envId = $currentEnvironment?.id ?? null;
			const res = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/deploys`, envId));
			if (!res.ok) return;
			const data = await res.json();
			deploysTally = deployTallyFromRuns(Array.isArray(data?.runs) ? data.runs : []);
			deploysHistoryExists = deploysTally.total > 0;
		} catch {
			// Non-fatal: the badge just stays at its current value.
		}
	}

	// Refresh the badge count when the modal opens (and after a deploy bumps the key).
	$effect(() => {
		if (open) {
			void deploysReloadKey; // re-count after a deploy finishes
			void loadDeploysCount();
		}
	});

	function finishOutput(output: string | undefined, ok: boolean, exitCode?: number) {
		outputRunning = false;
		outputOk = ok;
		outputMs = Date.now() - outputStartedAt;
		outputExitCode = exitCode;
		if (outputLines.length === 0 && output) {
			outputLines = output.split('\n');
		}
		deploysReloadKey++;
	}

	// Dismiss the output panel (only allowed once the run has finished; the run
	// keeps going regardless - this just hides its log).
	function closeOutput() {
		outputLines = [];
		outputTitle = '';
		outputOk = undefined;
		outputMs = undefined;
		outputExitCode = undefined;
	}

	const outputStatusLine = $derived(
		formatRunStatus({ running: outputRunning, ok: outputOk, ms: outputMs, exitCode: outputExitCode })
	);
	// DeployOutputHeader takes a verb + state (not the old title/running/ok): split the
	// stackName off the title and map running/ok to the shared state enum.
	const outputVerb = $derived(
		stackName && outputTitle.endsWith(stackName) ? outputTitle.slice(0, -stackName.length).trim() : outputTitle
	);
	const outputState = $derived<'running' | 'complete' | 'error'>(
		outputRunning ? 'running' : outputOk === false ? 'error' : 'complete'
	);

	// Stack exists warning dialog state
	let showExistsWarning = $state(false);


	// ─── Path State (Simplified) ─────────────────────────────────────────────────
	// Working paths: what we're currently editing (always strings, never null)
	let workingComposePath = $state('');
	let workingEnvPath = $state('');

	// Multi compose paths (ordered list)
	let workingComposePaths = $state<string[]>([]);

	// The composeContents payload sent to validate/save endpoints: every buffered
	// file plus the current editor content under the active path.
	function composeContentsPayload(): Record<string, string> {
		return Object.fromEntries(
			Object.entries({ ...composeContents, ...(activeComposePath ? { [activeComposePath]: composeContent } : {}) })
				.filter(([p]) => p.trim())
		);
	}

	function primaryComposeContent(): string {
		const primaryPath = workingComposePaths[0] || workingComposePath;
		if (!primaryPath || primaryPath === activeComposePath) return composeContent;
		return composeContents[primaryPath] ?? '';
	}

	// Shared tail of the create/update request bodies: ordered paths, multi-file
	// contents, and an explicit primary content so the server can't persist a
	// stale copy of the file being edited. `key` is 'compose' (POST /stacks) or
	// 'content' (PUT /compose).
	function applyComposePayload(requestBody: Record<string, unknown>, key: 'compose' | 'content'): void {
		if (workingComposePath.trim()) {
			requestBody.composePath = workingComposePath.trim();
		}
		const composePathsToSave = workingComposePaths.map((p) => p.trim()).filter((p) => p.length > 0);
		if (composePathsToSave.length > 0) {
			requestBody.composePaths = composePathsToSave;
		}
		const contentsToSave = composeContentsPayload();
		if (Object.keys(contentsToSave).length > 0) {
			requestBody.composeContents = contentsToSave;
			// Prevent data loss: explicitly set primary compose content
			const primaryPath = workingComposePath || workingComposePaths[0] || activeComposePath;
			if (primaryPath && contentsToSave[primaryPath] !== undefined) {
				requestBody[key] = contentsToSave[primaryPath];
			}
		}
	}

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
			.filter((f) => typeof f.line === 'number' && (!f.source || f.source === activeComposePath || f.source === 'compose'))
			.map((f) => ({ line: f.line!, severity: f.severity, ruleId: f.ruleId, message: f.message }))
	);

	async function runComposeValidate(opts: { silent?: boolean } = {}) {
		const primaryContent = primaryComposeContent();
		if (!primaryContent.trim()) return;
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
						compose: primaryContent,
						// Validate the SAME ordered set deploy uses — validating only the
						// active file rejects overrides that are valid only when merged.
						composePaths: workingComposePaths.filter((p) => p.trim()),
						composeContents: composeContentsPayload(),
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
	// Pull/build/forceRecreate chosen in the "Save & redeploy" RedeployPopover (see
	// handleSave below) -- carried across the path-change confirmation dialog the same
	// way pendingSaveRestart is, so re-entering handleSave() after the user confirms a
	// path move still deploys with the options they actually picked.
	let pendingSaveOptions = $state<DeployOptions | undefined>(undefined);

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

/**
	 * Single mutation point for the multi-file compose state. Keeps the path
	 * list, primary path (workingComposePath), active tab, and content map
	 * consistent:
	 *  - the editor buffer is flushed into the content map first (unless an
	 *    explicit `content` seeds the new active file, e.g. after a load)
	 *  - a renamed/re-pointed path moves its content entry with it
	 *  - paths that left the list lose their content entries
	 *  - the active tab falls back to the primary when it left the list
	 */
	function setComposePathList(
		newPaths: string[],
		opts: { active?: string; content?: string; rename?: { from: string; to: string } } = {}
	) {
		const currentActive = activeComposePath || workingComposePath;
		const contents: Record<string, string> = { ...composeContents };
		if (currentActive && opts.content === undefined) {
			contents[currentActive] = composeContent;
		}

		if (opts.rename && opts.rename.from !== opts.rename.to) {
			const { from, to } = opts.rename;
			if (from in contents) {
				contents[to] = contents[from];
				delete contents[from];
			}
		}

		const keep = new Set(newPaths);
		for (const key of Object.keys(contents)) {
			if (!keep.has(key) && contents[key] !== '') delete contents[key];
		}

		let nextActive = opts.active ?? currentActive;
		if (opts.rename && nextActive === opts.rename.from) nextActive = opts.rename.to;
		if (!nextActive || !newPaths.includes(nextActive)) nextActive = newPaths[0] ?? '';

		const nextContent = opts.content ?? contents[nextActive] ?? '';
		composeContents = nextActive ? { ...contents, [nextActive]: nextContent } : contents;
		workingComposePaths = newPaths;
		workingComposePath = newPaths[0] ?? '';
		activeComposePath = nextActive;
		composeContent = nextContent;
	}

	async function addDetectedComposeOverrides(primaryPath: string) {
		const slash = primaryPath.lastIndexOf('/');
		const composeDir = slash <= 0 ? '/' : primaryPath.slice(0, slash);
		try {
			const response = await fetch(`/api/system/files?path=${encodeURIComponent(composeDir)}`);
			if (!response.ok) return;
			const data = await response.json();
			const entries = Array.isArray(data.entries) ? data.entries : [];
			const overrides = detectedComposeOverridePaths(
				primaryPath,
				entries.filter((entry: any) => entry.type !== 'directory').map((entry: any) => entry.name)
			);
			if (overrides.length === 0 || workingComposePaths[0] !== primaryPath) return;

			const loaded = await Promise.all(overrides.map(async (path) => {
				const fileResponse = await fetch(`/api/system/files/content?path=${encodeURIComponent(path)}`);
				if (!fileResponse.ok) return null;
				const file = await fileResponse.json();
				return [path, file.content || ''] as const;
			}));
			if (workingComposePaths[0] !== primaryPath) return;
			composeContents = {
				...composeContents,
				...Object.fromEntries(loaded.filter((entry) => entry !== null))
			};
			const rest = workingComposePaths.slice(1).filter((path) => !overrides.includes(path));
			setComposePathList([primaryPath, ...overrides, ...rest], { active: primaryPath });
		} catch (e) {
			console.warn('Failed to detect compose overrides:', e);
		}
	}

	function browseForRow(index: number) {
		fileBrowserConfig = {
			title: 'Select compose file',
			selectFilter: /\.ya?ml$/,
			selectMode: 'file',
			onSelect: async (path: string) => {
				const oldPath = workingComposePaths[index];
				const newPaths = [...workingComposePaths];
				newPaths[index] = path;
				setComposePathList(newPaths, {
					rename: oldPath && oldPath !== path ? { from: oldPath, to: path } : undefined,
					active: path
				});
				showFileBrowser = false;
				isDirty = true;
				if (index === 0) {
					if (mode === 'create') maybeDeriveStackNameFromCompose(path);
					await addDetectedComposeOverrides(path);
				}
			},
		};
		showFileBrowser = true;
	}

	function addComposePath() {
		setComposePathList([...workingComposePaths, '']);
		isDirty = true;
	}

	function renameComposePathAt(index: number, newPath: string) {
		const oldPath = workingComposePaths[index];
		if (oldPath === newPath) return;
		const newPaths = [...workingComposePaths];
		newPaths[index] = newPath;
		setComposePathList(newPaths, { rename: { from: oldPath, to: newPath } });
		isDirty = true;
	}

	function removeComposePath(index: number) {
		if (workingComposePaths.length <= 1) return;
		const removedPath = workingComposePaths[index];
		setComposePathList(workingComposePaths.filter((_, i) => i !== index));
		// Keep a tombstone so the server truncates a removed file instead of leaving
		// stale override settings on disk.
		if (removedPath) composeContents = { ...composeContents, [removedPath]: '' };
		isDirty = true;
	}

	function movePathUp(index: number) {
		if (index <= 0) return;
		const newPaths = [...workingComposePaths];
		[newPaths[index - 1], newPaths[index]] = [newPaths[index], newPaths[index - 1]];
		setComposePathList(newPaths);
		isDirty = true;
	}

	function movePathDown(index: number) {
		if (index >= workingComposePaths.length - 1) return;
		const newPaths = [...workingComposePaths];
		[newPaths[index], newPaths[index + 1]] = [newPaths[index + 1], newPaths[index]];
		setComposePathList(newPaths);
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
		setComposePathList(newPaths);
		dragIndex = insertAt;
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
	// Persistence warning: the chosen compose path is not under a Dockhand mount, so it
	// would vanish on a container recreate (#1524). Shown as a confirm before committing.
	let showPersistenceWarn = $state(false);
	let persistenceWarnText = $state('');
	let pendingHasFilesToMove = $state(false);
	// Continuation run when the user accepts the persistence warning ("Use it anyway").
	// Lets create / save / relocate share one dialog: each stashes what to do next.
	let persistenceWarnProceed: (() => void) | null = null;

	/**
	 * Pre-flight a compose path: if it is not under a Dockhand mount (would be lost on
	 * recreate, #1524), show the warning dialog and defer `proceed` until the user accepts;
	 * otherwise run `proceed` immediately. On any check failure, proceed (never block on the
	 * guard itself). Only meaningful for an absolute custom path.
	 */
	async function guardComposePersistence(composePath: string, proceed: () => void) {
		const envId = $currentEnvironment?.id ?? null;
		const probeName = mode === 'edit' ? stackName : (newStackName.trim() || 'new-stack');
		try {
			const res = await fetch(
				appendEnvParam(`/api/stacks/${encodeURIComponent(probeName)}/check-path-change`, envId),
				{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newComposePath: composePath }) }
			);
			if (res.ok) {
				const data = await res.json();
				if (data.persistenceWarning) {
					persistenceWarnText = data.persistenceWarning;
					persistenceWarnProceed = proceed;
					showPersistenceWarn = true;
					return;
				}
			}
		} catch (e) {
			console.warn('Persistence pre-flight failed:', e);
		}
		proceed();
	}

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
				// Stash the target so a follow-up confirm (persistence and/or move) can act on it.
				pendingNewLocation = newDir;
				pendingNewComposePath = newComposePath;
				pendingNewEnvPath = newEnvPath;
				changeLocationOldDir = data.oldDir ?? null;
				changeLocationFileCount = data.fileCount ?? 0;
				pendingHasFilesToMove = !!(data.hasChanges && data.oldDir && data.fileCount > 0);

				// A non-persisted path is the more serious warning - confirm it FIRST; on
				// confirm we fall through to the move dialog (if any) or commit (#1524).
				if (data.persistenceWarning) {
					persistenceWarnText = data.persistenceWarning;
					showPersistenceWarn = true;
					return;
				}
				if (pendingHasFilesToMove) {
					showChangeLocationConfirm = true;
					return;
				}
			}
		} catch (e) {
			console.warn('Failed to check path changes:', e);
		}

		// No files to move, just update paths
		remapComposePathsDir(currentComposePath, newComposePath);
		workingEnvPath = newEnvPath;
		isDirty = true;
	}

	// "Use it anyway". A continuation (create/save) runs first; otherwise this is the
	// change-location flow, so continue to the move dialog or commit the new path.
	function confirmPersistenceWarn() {
		showPersistenceWarn = false;
		if (persistenceWarnProceed) {
			const go = persistenceWarnProceed;
			persistenceWarnProceed = null;
			go();
			return;
		}
		if (pendingHasFilesToMove) {
			showChangeLocationConfirm = true;
			return;
		}
		if (pendingNewComposePath) workingComposePath = pendingNewComposePath;
		if (pendingNewEnvPath !== null) workingEnvPath = pendingNewEnvPath;
		isDirty = true;
		clearPendingLocation();
	}

	function cancelPersistenceWarn() {
		showPersistenceWarn = false;
		persistenceWarnProceed = null;
		clearPendingLocation();
	}

	function clearPendingLocation() {
		pendingNewLocation = null;
		pendingNewComposePath = null;
		pendingNewEnvPath = null;
		changeLocationOldDir = null;
		changeLocationFileCount = 0;
		pendingHasFilesToMove = false;
	}

	/**
	 * Re-point the path list after the primary compose file moves from
	 * `oldPath` to `newPath`: the primary entry is renamed, other entries
	 * under the same directory follow, and content entries move with them.
	 */
	function remapComposePathsDir(oldPath: string, newPath: string) {
		const oldDir = oldPath ? oldPath.replace(/\/[^/]+$/, '') : '';
		const newDir = newPath.replace(/\/[^/]+$/, '');
		const renamed = workingComposePaths.map((p) => {
			if (p === oldPath) return newPath;
			if (oldDir && p.startsWith(oldDir + '/')) return newDir + p.slice(oldDir.length);
			return p;
		});
		if (!renamed.includes(newPath)) renamed.unshift(newPath);
		setComposePathList(renamed, { rename: oldPath ? { from: oldPath, to: newPath } : undefined });
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
			remapComposePathsDir(workingComposePath, pendingNewComposePath);
			workingEnvPath = pendingNewEnvPath || '';
			originalComposePath = pendingNewComposePath;
			originalEnvPath = pendingNewEnvPath || null;

			// Reload content from new location
			if (result.composeContent) {
				composeContent = result.composeContent;
				composeContents = { ...composeContents, [activeComposePath || workingComposePath]: composeContent };
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
				// Use the selected file's path directly, as the new primary
				const rest = workingComposePaths.slice(1).filter((p) => p !== finalPath);
				setComposePathList([finalPath, ...rest], { active: finalPath, content: composeContent });
				await addDetectedComposeOverrides(finalPath);
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
		if (!isDirectory) {
			await loadFilesFromLocalFilesystem(finalPath, workingEnvPath || suggestedEnvPath || '');
		}
		const rest = workingComposePaths.slice(1).filter((p) => p !== finalPath);
		setComposePathList([finalPath, ...rest], {
			active: isDirectory ? undefined : finalPath,
			content: isDirectory ? undefined : composeContent
		});
		if (!isDirectory) await addDetectedComposeOverrides(finalPath);
		pathSource = 'browsed';
		showFileBrowser = false;

		// Auto-suggest .env in the same directory
		const dir = finalPath.replace(/\/[^/]+$/, '');
		if (!workingEnvPath) {
			workingEnvPath = `${dir}/.env`;
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

	// Resizable output-panel split state -- height (not width) of the live output
	// panel below the editor, as a percentage of the combined editor+output area.
	// Bounds (15/70, default 30): the editor must stay usable even at the output
	// panel's largest size (30% left for the editor is several lines, not one), and
	// the output panel must stay usable even at its smallest (15% is enough for the
	// status line plus a handful of log lines).
	const OUTPUT_SPLIT_MIN = 15;
	const OUTPUT_SPLIT_MAX = 70;
	let outputSplitRatio = $state(30); // percentage of the editor+output area given to output
	let isDraggingOutputSplit = $state(false);
	let outputAreaRef: HTMLDivElement | null = $state(null);

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
		setComposePathList(workingComposePaths, { active: path });
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

		// Load saved output-panel split ratio
		const savedOutputSplit = localStorage.getItem(STORAGE_KEY_OUTPUT_SPLIT);
		if (savedOutputSplit) {
			const ratio = parseFloat(savedOutputSplit);
			if (!isNaN(ratio) && ratio >= OUTPUT_SPLIT_MIN && ratio <= OUTPUT_SPLIT_MAX) {
				outputSplitRatio = ratio;
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

	// Output-panel split drag handler (vertical drag -- resizes height, not width).
	function startOutputSplitDrag(e: MouseEvent) {
		e.preventDefault();
		isDraggingOutputSplit = true;
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
			splitRatio = clampNumber(newRatio, 30, 80);
		}
		if (isDraggingValidate && editorRowRef) {
			const rect = editorRowRef.getBoundingClientRect();
			// panel is on the right: width = distance from cursor to the row's right edge.
			const w = rect.right - e.clientX;
			// Floor at 320px: below that the header's title + count chips + re-check button
			// no longer fit on one line and start clipping.
			validatePanelWidth = clampNumber(w, 320, 560);
		}
		if (isDraggingOutputSplit && outputAreaRef) {
			const rect = outputAreaRef.getBoundingClientRect();
			// output panel is on the bottom: its height = distance from cursor to the
			// area's bottom edge, as a percentage of the whole editor+output area.
			const newRatio = ((rect.bottom - e.clientY) / rect.height) * 100;
			outputSplitRatio = clampNumber(newRatio, OUTPUT_SPLIT_MIN, OUTPUT_SPLIT_MAX);
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
		if (isDraggingOutputSplit) {
			isDraggingOutputSplit = false;
			localStorage.setItem(STORAGE_KEY_OUTPUT_SPLIT, outputSplitRatio.toString());
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
					workingComposePaths = workingComposePath ? [workingComposePath] : [];
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

					// Load the stack's icon even when the compose isn't local (read-only git
					// stack): the icon is Dockhand metadata, not repo content, so the header
					// must still show a custom icon the user set.
					try {
						const sourcesRes = await fetch(appendEnvParam('/api/stacks/sources', envId));
						if (sourcesRes.ok) {
							const sourceMap = await sourcesRes.json();
							formIcon = sourceMap?.[stackName]?.icon ?? null;
						}
					} catch (e) {
						console.warn('Failed to load stack icon:', e);
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
			// The primary file is always list[0]; keep list and primary in sync.
			if (workingComposePath && workingComposePaths[0] !== workingComposePath) {
				workingComposePaths = [workingComposePath, ...workingComposePaths.filter((p) => p !== workingComposePath)];
			}
			if (!activeComposePath && workingComposePaths.length > 0) {
				activeComposePath = workingComposePath || workingComposePaths[0];
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
					formIcon = source?.icon ?? null;
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
		const content = primaryComposeContent() || defaultCompose;
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
				body: JSON.stringify({
					compose: content,
					// Same ordered set deploy uses — an override file can define or
					// consume variables the primary never mentions.
					composePaths: workingComposePaths.filter((p) => p.trim()),
					composeContents: composeContentsPayload(),
					variables: currentVars
				})
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

	async function handleCreate(start: boolean = false, persistenceAcked = false, deployOptions?: DeployOptions) {
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

		// Warn if the chosen compose path won't survive a recreate (#1524) - before creating.
		if (!persistenceAcked && workingComposePath.trim()) {
			return guardComposePersistence(workingComposePath.trim(), () => handleCreate(start, true, deployOptions));
		}

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

			// Include custom paths if specified (skip rows still being typed)
			applyComposePayload(requestBody, 'compose');
			// Use working env path or suggested path
			const envPathToSave = workingEnvPath.trim() || suggestedEnvPath || '';
			if (envPathToSave) {
				requestBody.envPath = envPathToSave;
			}

			requestBody.secretProviderId = formSecretProviderId;

			// Only meaningful when start is true -- deployOptions is undefined for the
			// plain "Create" button, which never reaches deployStack server-side anyway.
			if (start && deployOptions) {
				requestBody.pull = deployOptions.pull;
				requestBody.build = deployOptions.build;
				requestBody.forceRecreate = deployOptions.forceRecreate;
			}

			if (start) startOutput(`Starting ${newStackName.trim()}`);

			// Create the stack
			response = await fetch(appendEnvParam('/api/stacks', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody)
			});

			// When start=true, response is a job or JSON; when start=false, it's plain JSON
			const data = start
				? await readJobResponse(response, (line) => appendOutputLine(line))
				: await response.json();
			if (start) finishOutput(
				typeof data.output === 'string' ? data.output : undefined,
				Boolean(data.success),
				typeof data.exitCode === 'number' ? data.exitCode : undefined
			);

			if (!response.ok && !data.success) {
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to create stack');
			}
			if (data.success === false) {
				throw new Error(data.error || 'Failed to create stack');
			}

			await persistPendingIcon(newStackName.trim(), envId);

			toast.success(`Created stack "${newStackName.trim()}"`);
			onSuccess();
			switch (saveCloseTiming(start, Boolean(data.success))) {
				case 'close':
					handleClose();
					break;
				case 'close-delayed':
					setTimeout(() => handleClose(), DEPLOY_SUCCESS_CLOSE_DELAY_MS);
					break;
				case 'stay-open':
					// Reachable only if a future change to the create/deploy endpoint ever
					// resolves without throwing on failure -- today both throw checks above
					// always catch a failed deploy first, so this case is currently dead code
					// at this exact call site. Kept so the switch stays exhaustive and this
					// call site doesn't silently start closing on failure if that changes.
					break;
			}
		} catch (e: any) {
			// The success path above already calls finishOutput with the server's real
			// ok/exitCode before it throws (a deploy that ran but reported failure).
			// Only mark the run failed here if it never got that far -- overwriting a
			// real exit code with `undefined` would erase the very thing the docked
			// output panel exists to show.
			if (start && outputRunning) finishOutput(undefined, false);
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

	async function handleSave(restart = false, moveFromDir: string | null | undefined = undefined, persistenceAcked = false, deployOptions?: DeployOptions) {
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
						// Non-persisted path is the more serious warning - surface it first (#1524).
						if (checkData.persistenceWarning && !persistenceAcked) {
							persistenceWarnText = checkData.persistenceWarning;
							persistenceWarnProceed = () => handleSave(restart, moveFromDir, true, deployOptions);
							showPersistenceWarn = true;
							return;
						}
						if (checkData.hasChanges && checkData.oldDir && checkData.fileCount > 0) {
							// Show confirmation dialog
							pathChangeOldDir = checkData.oldDir;
							pathChangeFileCount = checkData.fileCount;
							pendingSaveRestart = restart;
							pendingSaveOptions = deployOptions;
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
			applyComposePayload(requestBody, 'content');

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

			// Only meaningful when restart is true -- deployOptions is undefined for the
			// plain "Save" button, which never reaches deployStack server-side anyway.
			if (restart && deployOptions) {
				requestBody.pull = deployOptions.pull;
				requestBody.build = deployOptions.build;
				requestBody.forceRecreate = deployOptions.forceRecreate;
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

			if (restart) startOutput(`Redeploying ${stackName}`);

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
			const data = restart
				? await readJobResponse(response, (line) => appendOutputLine(line))
				: await response.json();
			if (restart) finishOutput(
				typeof data.output === 'string' ? data.output : undefined,
				Boolean(data.success),
				typeof data.exitCode === 'number' ? data.exitCode : undefined
			);

			if (!response.ok && !data.success) {
				throw new Error((typeof data.error === 'string' ? data.error : data.message) || 'Failed to save compose file');
			}
			if (data.success === false) {
				// On the restart path the server persists the compose+env BEFORE deploying,
				// so a success:false here is a failed DEPLOY, not a failed save -- the content
				// is already on disk. Clear the dirty flag so the footer doesn't claim
				// "Unsaved changes" for edits that were in fact saved; the deploy error still
				// surfaces via the throw below. (Plain save keeps isDirty on a real save fail.)
				if (restart) isDirty = false;
				throw new Error(data.error || 'Failed to save compose file');
			}

			isDirty = false; // Reset dirty flag after successful save
			toast.success(restart ? 'Stack applied' : 'Stack saved');
			onSuccess();

			switch (saveCloseTiming(restart, Boolean(data.success))) {
				case 'close':
					// Show success briefly then close.
					setTimeout(() => handleClose(), 500);
					break;
				case 'close-delayed':
					setTimeout(() => handleClose(), DEPLOY_SUCCESS_CLOSE_DELAY_MS);
					break;
				case 'stay-open':
					// Reachable only if a future change to the compose/deploy endpoint ever
					// resolves without throwing on failure -- today both throw checks above
					// always catch a failed deploy first, so this case is currently dead code
					// at this exact call site. Kept so the switch stays exhaustive and this
					// call site doesn't silently start closing on failure if that changes.
					break;
			}
		} catch (e: any) {
			// Same reasoning as handleCreate's catch block: don't clobber a real
			// ok/exitCode that finishOutput already recorded before this throw.
			if (restart && outputRunning) finishOutput(undefined, false);
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
		handleSave(pendingSaveRestart, pathChangeOldDir, false, pendingSaveOptions);
	}

	// Handle path change - keep old files and proceed (just save without moving)
	function confirmPathChangeKeepFiles() {
		showPathChangeConfirm = false;
		// Pass empty string to skip move check (undefined means "not checked yet")
		handleSave(pendingSaveRestart, '', false, pendingSaveOptions);
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
		formIcon = null;
		pendingUploadImage = null;
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
		pendingSaveOptions = undefined;
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
			// Same reasoning for the docked deploy output: without this, reopening the
			// modal for a *different* stack would still show the previous stack's title,
			// lines and status ("Redeploying A" / "Succeeded" while looking at stack B).
			// A reopen of the *same* stack while its own deploy is still running loses the
			// lines accumulated so far, but only until the next line arrives (the poll loop
			// in sse-fetch.ts keeps running regardless of this modal's open state, same as
			// ComposeOutputModal) or the job finishes -- finishOutput's `outputLines.length
			// === 0 && output` fallback then refills the whole transcript from the job's
			// final output. That brief, self-correcting gap is preferable to a stale result
			// silently misattributed to the wrong stack.
			outputTitle = '';
			outputLines = [];
			outputRunning = false;
			outputOk = undefined;
			outputMs = undefined;
			outputExitCode = undefined;
			outputStartedAt = 0;
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

		// No name entered yet - clear paths but preserve the editor content
		if (!name) {
			workingComposePaths = [];
			workingComposePath = '';
			activeComposePath = '';
			composeContents = {};
			workingEnvPath = '';
			autoComputedComposePath = '';
			if (!browsedBaseDirectory) {
				pathSource = null;
			}
			return;
		}

		// User browsed and selected a directory - build path from that base
		if (browsedBaseDirectory) {
			const composePath = `${browsedBaseDirectory}/${name}/compose.yaml`;
			untrack(() => remapGeneratedPrimaryPath(composePath));
			workingEnvPath = `${browsedBaseDirectory}/${name}/.env`;
			pathSource = 'browsed';
			return;
		}

		// Use pre-fetched default base directory
		if (defaultStackDir) {
			const dir = `${defaultStackDir}/${name}`;
			autoComputedComposePath = `${dir}/compose.yaml`;
			untrack(() => remapGeneratedPrimaryPath(`${dir}/compose.yaml`));
			workingEnvPath = `${dir}/.env`;
			pathSource = 'default';
		}
	});

	// The generated primary path changed (stack name typed/edited). Remap ONLY
	// the primary entry and preserve any additional paths + their buffered
	// content — rebuilding the list from scratch would silently drop them.
	function remapGeneratedPrimaryPath(newPrimary: string) {
		const prevPrimary = workingComposePaths[0] ?? '';
		setComposePathList(
			[newPrimary, ...workingComposePaths.slice(1)],
			{
				rename: prevPrimary && prevPrimary !== newPrimary ? { from: prevPrimary, to: newPrimary } : undefined,
				content: composeContent
			}
		);
	}
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
		<Dialog.Header class="px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2">
						<!-- The stack icon is Dockhand metadata (stored via the /icon API), not
						     repo content, so it stays editable even for a read-only git stack. -->
						<button
							type="button"
							title="Change stack icon"
							onclick={() => (showIconPicker = true)}
							class="p-1.5 rounded-md bg-zinc-200 dark:bg-zinc-700 hover:ring-2 hover:ring-primary transition-shadow"
						>
							{#if pendingUploadImage}
								<img src={pendingUploadImage} alt="" class="w-4 h-4 rounded object-cover" />
							{:else if formIcon}
								<StackIcon icon={formIcon} {stackName} envId={$currentEnvironment?.id ?? null} class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
							{:else}
								<Layers class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
							{/if}
						</button>
						<div>
							<Dialog.Title class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
								{#if mode === 'create'}
									Create compose stack
								{:else}
									{stackName}
								{/if}
								{#if $currentEnvironment}
									<span class="font-semibold">on <span class="text-amber-600 dark:text-amber-400">{$currentEnvironment.name}</span></span>
								{/if}
							</Dialog.Title>
							<Dialog.Description class="text-xs text-zinc-500 dark:text-zinc-400">
								{#if mode === 'create'}
									Create a new Docker Compose stack
								{:else if readonly}
									View compose file and dependency graph
								{:else}
									Edit compose file and environment variables
								{/if}
							</Dialog.Description>
						</div>
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
			<!-- Deploys tab: recorded run history (keyed by stackName+env, independent of
			     the local compose file). Shown with a synced compose, OR -- for a
			     read-only / not-yet-synced git stack with no local compose -- only when
			     there is history to show, so an empty tab never appears. Edit mode only,
			     where stackName/envId are known. -->
			{#if mode === 'edit' && (!needsFileLocation || deploysHistoryExists)}
				<button
					type="button"
					class="relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors {activeTab === 'deploys' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => activeTab = 'deploys'}
				>
					<History class="h-3.5 w-3.5" /> Deploys
					{#if deploysTally.ok > 0}
						<span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-500"><Check class="h-2.5 w-2.5" />{deploysTally.ok}</span>
					{/if}
					{#if deploysTally.failed > 0}
						<span class="inline-flex items-center gap-0.5 rounded-full bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-500"><X class="h-2.5 w-2.5" />{deploysTally.failed}</span>
					{/if}
					{#if deploysTally.total > 0 && deploysTally.ok === 0 && deploysTally.failed === 0}
						<Badge variant="secondary" class="ml-0.5 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums">{deploysTally.total}</Badge>
					{/if}
				</button>
			{/if}
		</div>

		<!-- Wrapper spanning the editor area + the live output panel below it, so the
		     output panel's height can be a percentage of THIS combined space rather than
		     of the whole dialog (which also includes the fixed header/tabs/footer). -->
		<div
			bind:this={outputAreaRef}
			class="flex-1 min-h-0 flex flex-col {isDraggingOutputSplit ? 'select-none' : ''}"
		>
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
														value={workingComposePaths[i]}
														placeholder={i === 0 ? '/path/to/compose.yaml' : 'compose.override.yaml'}
														class="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs"
														oninput={(e) => renameComposePathAt(i, e.currentTarget.value)}
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

									{#if workingComposePaths.filter((p) => p.trim()).length > 0}
										<Tabs.Root
											value={activeComposePath || workingComposePaths[0]}
											onValueChange={(v) => switchComposeFile(v)}
											class="flex-wrap border-b border-zinc-200 dark:border-zinc-700"
										>
											<Tabs.List class="flex w-full flex-wrap justify-start gap-0.5 rounded-none bg-transparent p-0">
												{#each workingComposePaths.filter((p) => p.trim()) as path, i (path)}
													<div class="group flex min-w-0 items-center">
														<Tabs.Trigger
															value={path}
															class="min-w-0 cursor-pointer break-all rounded-t-md border-b-2 px-3.5 py-2.5 font-mono text-xs rounded-none border-x-0 border-t-0 shadow-none transition-colors data-[state=active]:rounded-none data-[state=active]:border-primary data-[state=active]:bg-zinc-50 data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:dark:bg-zinc-800/50"
														>
															{composeFileName(path)}
														</Tabs.Trigger>
														<button
															type="button"
															class="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 {path === (activeComposePath || workingComposePaths[0]) ? 'opacity-100' : ''}"
															title="Copy path"
															onclick={() => copyComposePathAtIndex(path, i)}
														>
															{#if composePathCopied === 'ok' && composePathCopiedIndex === i}
																<Check class="h-3 w-3 text-green-500" />
															{:else}
																<Copy class="h-3 w-3" />
															{/if}
														</button>
													</div>
												{/each}
											</Tabs.List>
										</Tabs.Root>
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
					{:else if activeTab === 'deploys' && (!needsFileLocation || deploysHistoryExists)}
						<!-- Deploys tab: shown with a synced compose, or when a read-only /
						     not-yet-synced stack still has run history to show. -->
						<div class="flex h-full min-h-0 flex-1 flex-col p-4">
							<DeploysPanel {stackName} envId={$currentEnvironment?.id ?? null} theme={editorTheme} reloadKey={deploysReloadKey} onTally={(t) => (deploysTally = t)} />
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Live output for Create & Start / Save & redeploy, rendered below the editor instead
		     of handing the user off to a separate window (see save-close-policy.ts for how long
		     the dialog then stays open). Only takes up space once there is something to show,
		     and only then does its resize divider exist -- a handle that drags nothing is worse
		     than no handle. -->
		{#if outputRunning || outputLines.length > 0}
			<!-- Resizable divider (height, not width -- drag up/down to resize the output panel) -->
			<div
				class="h-1 shrink-0 bg-zinc-200 dark:bg-zinc-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-row-resize transition-colors flex items-center justify-center group {isDraggingOutputSplit ? 'bg-blue-500 dark:bg-blue-400' : ''}"
				onmousedown={startOutputSplitDrag}
				role="separator"
				aria-orientation="horizontal"
				tabindex="0"
			>
				<div class="w-8 h-4 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity {isDraggingOutputSplit ? 'opacity-100' : ''}">
					<GripHorizontal class="w-3 h-3 text-white" />
				</div>
			</div>
			<div class="shrink-0 flex flex-col min-h-0" style="height: {outputSplitRatio}%">
				<div class="px-5 py-1.5 text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2 flex-shrink-0">
					<DeployOutputHeader
						verb={outputVerb}
						{stackName}
						stackIcon={formIcon}
						envId={$currentEnvironment?.id ?? null}
						state={outputState}
						statusLine={outputStatusLine}
						iconClass="w-3.5 h-3.5"
					/>
					{#if !outputRunning}
						<button
							type="button"
							onclick={closeOutput}
							title="Close output"
							class="ml-auto p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
						>
							<X class="w-3.5 h-3.5" />
						</button>
					{/if}
				</div>
				<LogViewer
					logs={outputLines.join('\n')}
					title={outputTitle}
					autoRefresh={false}
					autoScroll={outputRunning}
					class="flex-1 min-h-0"
					theme={editorTheme}
				/>
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
					<!-- Split button: the label itself stays a direct, one-click action (the
					     common case) with the current defaults baked in; the chevron opens a
					     popover to override pull/build/forceRecreate before deploying. Two
					     separate <button> elements, both independently reachable by keyboard --
					     never one element whose behavior depends on click position. -->
					<div class="inline-flex">
						<Button
							class="rounded-r-none"
							onclick={() => handleCreate(true, false, createStartDefaults)}
							disabled={saving}
						>
							{#if saving}
								<Loader2 class="w-4 h-4 animate-spin" />
								Starting...
							{:else}
								<Play class="w-4 h-4" />
								Create & Start
							{/if}
						</Button>
						<RedeployPopover
							stackName={newStackName}
							envId={$currentEnvironment?.id ?? null}
							disabled={saving}
							triggerVariant="chevron"
							defaultPull={createStartDefaults.pull}
							defaultBuild={createStartDefaults.build}
							defaultForceRecreate={createStartDefaults.forceRecreate}
							reason={hasBuildSection ? 'Auto-checked: this compose file has a build: section' : undefined}
							onDeploy={(options) => handleCreate(true, false, options)}
						>
							{#snippet children()}
								<ChevronDown class="w-4 h-4" />
							{/snippet}
						</RedeployPopover>
					</div>
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
					<!-- Same split-button shape as Create & Start above. -->
					<div class="inline-flex">
						<Button
							class="w-36 rounded-r-none"
							onclick={() => handleSave(true, undefined, false, saveRedeployDefaults)}
							disabled={saving || loading || (needsFileLocation && !workingComposePath.trim())}
						>
							{#if saving && savingWithRestart}
								<Loader2 class="w-4 h-4 animate-spin" />
								Deploying...
							{:else}
								<Play class="w-4 h-4" />
								Save & redeploy
							{/if}
						</Button>
						<RedeployPopover
							{stackName}
							envId={$currentEnvironment?.id ?? null}
							disabled={saving || loading || (needsFileLocation && !workingComposePath.trim())}
							triggerVariant="chevron"
							defaultPull={saveRedeployDefaults.pull}
							defaultBuild={saveRedeployDefaults.build}
							defaultForceRecreate={saveRedeployDefaults.forceRecreate}
							reason={hasBuildSection ? 'Auto-checked: this compose file has a build: section' : undefined}
							onDeploy={(options) => handleSave(true, undefined, false, options)}
						>
							{#snippet children()}
								<ChevronDown class="w-4 h-4" />
							{/snippet}
						</RedeployPopover>
					</div>
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

<IconPickerModal bind:open={showIconPicker} value={formIcon} onselect={onIconSelect} title="Choose a stack icon" />

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

<!-- Persistence warning: chosen compose path is not under a Dockhand mount (#1524) -->
<Dialog.Root bind:open={showPersistenceWarn}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<TriangleAlert class="w-5 h-5 text-amber-500 shrink-0" />
				This location isn't persisted
			</Dialog.Title>
		</Dialog.Header>
		<p class="text-sm text-muted-foreground mt-1">
			{persistenceWarnText}
		</p>
		<div class="flex justify-end gap-1.5 mt-4">
			<Button variant="default" size="sm" onclick={cancelPersistenceWarn}>
				Pick another location
			</Button>
			<Button variant="outline" size="sm" onclick={confirmPersistenceWarn}>
				Use it anyway
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
