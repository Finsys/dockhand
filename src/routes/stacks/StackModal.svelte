<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import CodeEditor, { type VariableMarker } from '$lib/components/CodeEditor.svelte';
	import StackEnvVarsPanel from '$lib/components/StackEnvVarsPanel.svelte';
	import { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import { Layers, Save, Play, Code, GitGraph, Loader2, AlertCircle, X, Sun, Moon, TriangleAlert, ChevronsLeft, ChevronsRight, Variable, HelpCircle, GripVertical } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { focusFirstInput } from '$lib/utils';
	import * as Alert from '$lib/components/ui/alert';
	import ComposeGraphViewer from './ComposeGraphViewer.svelte';

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
	let error = $state<string | null>(null);
	let loadError = $state<string | null>(null);
	let errors = $state<{ stackName?: string; compose?: string }>({});
	let composeContent = $state('');
	let originalContent = $state('');
	let activeTab = $state<'editor' | 'graph'>('editor');
	let showConfirmClose = $state(false);
	let editorTheme = $state<'light' | 'dark'>('dark');

	// Environment variables state
	let envVars = $state<EnvVar[]>([]);
	let originalEnvVars = $state<EnvVar[]>([]);
	let rawEnvContent = $state('');
	let originalRawEnvContent = $state('');
	let envValidation = $state<ValidationResult | null>(null);
	let validating = $state(false);
	let existingSecretKeys = $state<Set<string>>(new Set());

	// CodeEditor reference for explicit marker updates
	let codeEditorRef: CodeEditor | null = $state(null);

	// ComposeGraphViewer reference for resize on panel toggle
	let graphViewerRef: ComposeGraphViewer | null = $state(null);

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

	// Check for compose changes
	const hasComposeChanges = $derived(composeContent !== originalContent);

	// Stable callback for compose content changes - avoids stale closure issues
	function handleComposeChange(value: string) {
		composeContent = value;
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

	// Check for env var changes (compare by serializing)
	const hasEnvVarChanges = $derived.by(() => {
		const currentVars = JSON.stringify(envVars.filter(v => v.key));
		const originalVars = JSON.stringify(originalEnvVars);
		const varsChanged = currentVars !== originalVars;
		const rawChanged = rawEnvContent !== originalRawEnvContent;
		return varsChanged || rawChanged;
	});

	const hasChanges = $derived(hasComposeChanges || hasEnvVarChanges);

	// Display title
	const displayName = $derived(mode === 'edit' ? stackName : (newStackName || 'New stack'));

	onMount(() => {
		// Follow app theme from localStorage
		const appTheme = localStorage.getItem('theme');
		if (appTheme === 'dark' || appTheme === 'light') {
			editorTheme = appTheme;
		} else {
			// Fallback to system preference
			editorTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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

		try {
			const envId = $currentEnvironment?.id ?? null;

			// Load compose file
			const response = await fetch(`/api/stacks/${encodeURIComponent(stackName)}/compose`);
			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to load compose file');
			}

			composeContent = data.content;
			originalContent = data.content;

			// Load environment variables (parsed)
			const envResponse = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env`, envId));
			if (envResponse.ok) {
				const envData = await envResponse.json();
				envVars = envData.variables || [];
				// Track existing secret keys (secrets loaded from DB cannot have visibility toggled)
				existingSecretKeys = new Set(
					envVars.filter(v => v.isSecret && v.key.trim()).map(v => v.key.trim())
				);
			}

			// Load raw .env file content
			const rawEnvResponse = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env/raw`, envId));
			if (rawEnvResponse.ok) {
				const rawEnvData = await rawEnvResponse.json();
				rawEnvContent = rawEnvData.content || '';
			}

			// Wait for $effects in StackEnvVarsPanel to settle (parses raw content, syncs variables)
			// Then set originals to the post-effect state to avoid false "unsaved changes"
			await tick();
			originalEnvVars = JSON.parse(JSON.stringify(envVars.filter(v => v.key.trim())));
			originalRawEnvContent = rawEnvContent;
		} catch (e: any) {
			loadError = e.message;
		} finally {
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

		saving = true;
		error = null;

		try {
			const envId = $currentEnvironment?.id ?? null;

			// Collect environment variables
			const definedVars = envVars.filter(v => v.key.trim());

			// Create the stack (include env vars so they're available before start)
			const response = await fetch(appendEnvParam('/api/stacks', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: newStackName.trim(),
					compose: content,
					start,
					envVars: definedVars.length > 0 ? definedVars.map(v => ({
						key: v.key.trim(),
						value: v.value,
						isSecret: v.isSecret
					})) : undefined
				})
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.error || 'Failed to create stack');
			}

			onSuccess();
			handleClose();
		} catch (e: any) {
			error = e.message;
		} finally {
			saving = false;
		}
	}

	async function handleSave(restart = false) {
		errors = {};

		if (!composeContent.trim()) {
			errors.compose = 'Compose file content cannot be empty';
			return;
		}

		saving = true;
		error = null;

		try {
			const envId = $currentEnvironment?.id ?? null;

			// Save compose file
			const response = await fetch(
				appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/compose`, envId),
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						content: composeContent,
						restart
					})
				}
			);

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to save compose file');
			}

			// Save environment variables
			// Always save to raw endpoint for consistency
			// If no raw content but has env vars, generate raw content from vars (backward compat)
			const definedVars = envVars.filter(v => v.key.trim());
			let contentToSave = rawEnvContent;

			// Backward compatibility: if no raw file but has DB envs, generate raw content
			if (!contentToSave.trim() && definedVars.length > 0) {
				contentToSave = definedVars.map(v => `${v.key.trim()}=${v.value}`).join('\n') + '\n';
			}

			// Save if there's any content OR if we need to clear an existing file
			if (contentToSave.trim() || originalRawEnvContent.trim() || definedVars.length > 0 || originalEnvVars.length > 0) {
				const rawEnvResponse = await fetch(
					appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env/raw`, envId),
					{
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ content: contentToSave })
					}
				);

				if (!rawEnvResponse.ok) {
					console.error('Failed to save environment file');
				}

				// Also save to DB for secret tracking
				if (definedVars.some(v => v.isSecret)) {
					const envResponse = await fetch(
						appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/env`, envId),
						{
							method: 'PUT',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								variables: definedVars.map(v => ({
									key: v.key.trim(),
									value: v.value,
									isSecret: v.isSecret
								}))
							})
						}
					);

					if (!envResponse.ok) {
						console.error('Failed to save secret markers to database');
					}
				}
			}

			originalContent = composeContent;
			originalEnvVars = JSON.parse(JSON.stringify(envVars.filter(v => v.key.trim())));
			originalRawEnvContent = contentToSave; // Use what was actually saved
			rawEnvContent = contentToSave; // Sync raw content if it was generated
			onSuccess();

			if (!restart) {
				// Show success briefly then close
				setTimeout(() => handleClose(), 500);
			} else {
				handleClose();
			}
		} catch (e: any) {
			error = e.message;
		} finally {
			saving = false;
		}
	}

	function tryClose() {
		if (hasChanges) {
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
		errors = {};
		composeContent = '';
		originalContent = '';
		envVars = [];
		originalEnvVars = [];
		rawEnvContent = '';
		originalRawEnvContent = '';
		envValidation = null;
		existingSecretKeys = new Set();
		activeTab = 'editor';
		showConfirmClose = false;
		codeEditorRef = null;
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
				originalContent = defaultCompose; // Track original for change detection
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
</script>

<Dialog.Root
	bind:open
	onOpenChange={(isOpen) => {
		if (isOpen) {
			focusFirstInput();
		} else {
			// Prevent closing if there are unsaved changes - show confirmation instead
			if (hasChanges) {
				// Re-open the dialog and show confirmation
				open = true;
				showConfirmClose = true;
			}
			// If no changes, let it close naturally
		}
	}}
>
	<Dialog.Content
		class="max-w-none w-[calc(100vw-12rem)] h-[95vh] ml-[4.5rem] flex flex-col p-0 gap-0 shadow-xl border-zinc-200 dark:border-zinc-700"
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
									Edit compose file and view stack structure
								{/if}
							</Dialog.Description>
						</div>
					</div>

					<!-- View toggle -->
					<div class="flex items-center gap-0.5 bg-zinc-200 dark:bg-zinc-700 rounded-md p-0.5 ml-3">
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
				</div>

				<div class="flex items-center gap-1">
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
			{#if error}
				<Alert.Root variant="destructive" class="mx-6 mt-4">
					<TriangleAlert class="h-4 w-4" />
					<Alert.Description>{error}</Alert.Description>
				</Alert.Root>
			{/if}

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
			{:else if mode === 'edit' && loadError}
				<div class="flex-1 flex items-center justify-center p-6">
					<div class="text-center max-w-md">
						<div class="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
							<AlertCircle class="w-6 h-6 text-amber-400" />
						</div>
						<h3 class="text-lg font-medium mb-2">Could not load compose file</h3>
						<p class="text-sm text-zinc-400 dark:text-zinc-500 mb-4">{loadError}</p>
						<p class="text-xs text-zinc-500 dark:text-zinc-400">
							This stack may have been created outside of Dockhand or the compose file may have been moved.
						</p>
					</div>
				</div>
			{:else}
				<!-- Stack name input (create mode only) -->
				{#if mode === 'create'}
					<div class="px-6 py-4 border-b border-zinc-200 dark:border-zinc-700">
						<div class="max-w-md space-y-1">
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
				{/if}

				<!-- Content area -->
				<div bind:this={containerRef} class="flex-1 min-h-0 flex {isDraggingSplit ? 'select-none' : ''}">
					{#if activeTab === 'editor'}
						<!-- Editor tab: Code editor + Env panel side by side -->
						<div class="flex-shrink-0 flex flex-col min-w-0" style="width: {splitRatio}%">
							{#if open}
								<div class="flex-1 p-3 min-h-0">
									<CodeEditor
										bind:this={codeEditorRef}
										value={composeContent}
										language="yaml"
										theme={editorTheme}
										onchange={handleComposeChange}
										variableMarkers={variableMarkers}
										class="h-full rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700"
									/>
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
							<div class="flex items-center gap-1.5 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-700 text-xs font-medium text-zinc-600 dark:text-zinc-300">
								<Variable class="w-3.5 h-3.5" />
								Environment variables
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
									</Tooltip.Trigger>
									<Tooltip.Content>
										<div class="w-64">
											<p class="text-xs">These variables will be written to a <code class="bg-muted px-1 rounded">.env</code> file in the stack directory.</p>
										</div>
									</Tooltip.Content>
								</Tooltip.Root>
								<!-- Validation status pills -->
								{#if envValidation}
									<div class="flex gap-1 ml-auto">
										{#if envValidation.missing.length > 0}
											<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
												{envValidation.missing.length} missing
											</span>
										{/if}
										{#if envValidation.required.length > 0}
											<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
												{envValidation.required.length - envValidation.missing.length} required
											</span>
										{/if}
										{#if envValidation.optional.length > 0}
											<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
												{envValidation.optional.length} optional
											</span>
										{/if}
										{#if envValidation.unused.length > 0}
											<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
												{envValidation.unused.length} unused
											</span>
										{/if}
									</div>
								{/if}
							</div>
							<div class="flex-1 min-h-0 overflow-hidden">
								<StackEnvVarsPanel
									bind:variables={envVars}
									bind:rawContent={rawEnvContent}
									validation={envValidation}
									existingSecretKeys={mode === 'edit' ? existingSecretKeys : new Set()}
									onchange={debouncedValidate}
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
				{#if hasChanges}
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
							<Loader2 class="w-4 h-4 mr-2 animate-spin" />
							Creating...
						{:else}
							<Save class="w-4 h-4 mr-2" />
							Create
						{/if}
					</Button>
					<Button onclick={() => handleCreate(true)} disabled={saving}>
						{#if saving}
							<Loader2 class="w-4 h-4 mr-2 animate-spin" />
							Starting...
						{:else}
							<Play class="w-4 h-4 mr-2" />
							Create & Start
						{/if}
					</Button>
				{:else}
					<!-- Edit mode buttons -->
					<Button variant="outline" onclick={() => handleSave(false)} disabled={saving || !hasChanges || loading || !!loadError}>
						{#if saving}
							<Loader2 class="w-4 h-4 mr-2 animate-spin" />
							Saving...
						{:else}
							<Save class="w-4 h-4 mr-2" />
							Save
						{/if}
					</Button>
					<Button onclick={() => handleSave(true)} disabled={saving || !hasChanges || loading || !!loadError}>
						{#if saving}
							<Loader2 class="w-4 h-4 mr-2 animate-spin" />
							Applying...
						{:else}
							<Play class="w-4 h-4 mr-2" />
							Save & apply
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
