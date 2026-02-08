<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import StackEnvVarsEditor, { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { Plus, Upload, Trash2, List, FileText, AlertTriangle, ShieldAlert, HelpCircle, Info } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

	interface Props {
		variables: EnvVar[]; // Bindable - ALL variables (secrets + non-secrets)
		rawContent?: string; // Bindable - raw .env file content (comments preserved, no secrets)
		validation?: ValidationResult | null;
		readonly?: boolean;
		showSource?: boolean;
		sources?: Record<string, 'file' | 'override'>;
		fileValues?: Record<string, string>;
		placeholder?: { key: string; value: string };
		infoText?: string;
		existingSecretKeys?: Set<string>;
		showInterpolationHint?: boolean;
		theme?: 'light' | 'dark';
		class?: string;
		onchange?: () => void;
		headerActions?: Snippet;
	}

	let {
		variables = $bindable([]),
		rawContent = $bindable(''),
		validation = null,
		readonly = false,
		showSource = false,
		sources = {},
		fileValues = {},
		placeholder = { key: 'VARIABLE_NAME', value: 'value' },
		infoText,
		existingSecretKeys = new Set<string>(),
		showInterpolationHint = false,
		theme = 'dark',
		class: className = '',
		onchange,
		headerActions
	}: Props = $props();

	const STORAGE_KEY_VIEW_MODE = 'dockhand-env-vars-view-mode';

	let fileInputRef: HTMLInputElement;
	let viewMode = $state<'form' | 'text'>(
		(typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY_VIEW_MODE) as 'form' | 'text') || 'form'
	);
	let confirmClearOpen = $state(false);
	let contentAreaRef: HTMLDivElement;
	let parseWarnings = $state<string[]>([]);

	// Count of secrets (for display in hint)
	const secretCount = $derived(variables.filter(v => v.isSecret && v.key.trim()).length);

	// Generate text representation from variables (non-secrets only)
	// This is used for text view display
	const generatedRawContent = $derived.by(() => {
		const nonSecrets = variables.filter(v => v.key.trim() && !v.isSecret);
		if (nonSecrets.length === 0) return '';
		return nonSecrets.map(v => `${v.key.trim()}=${v.value}`).join('\n') + '\n';
	});

	// Text editor content - either from file (rawContent prop) or generated from variables
	const textEditorContent = $derived(rawContent.trim() ? rawContent : generatedRawContent);

	/**
	 * Sync variables with rawContent after initial load.
	 * Pass the loaded data directly to avoid timing issues with bindable props.
	 * Merges: secrets from loadedVars (DB) + non-secrets from loadedRaw (file).
	 */
	export function syncAfterLoad(loadedVars: EnvVar[], loadedRaw: string) {
		if (!loadedRaw.trim()) {
			// No raw content from file - just set variables, text view will use generatedRawContent
			variables = loadedVars;
			rawContent = '';
			return;
		}

		const { vars: rawVars } = parseRawContent(loadedRaw);

		// Secrets come from loadedVars (DB), non-secrets come from loadedRaw (file)
		const secrets = loadedVars.filter(v => v.isSecret);

		// Also keep non-secrets from loadedVars that aren't in raw (new vars added before first save)
		const rawKeys = new Set(rawVars.map(v => v.key));
		const newNonSecrets = loadedVars.filter(v => !v.isSecret && v.key.trim() && !rawKeys.has(v.key));

		// Set both at once to avoid any intermediate states
		variables = [...rawVars, ...newNonSecrets, ...secrets];
		rawContent = loadedRaw;
	}

	/**
	 * Parse raw content to extract non-secret variables.
	 */
	function parseRawContent(content: string): { vars: EnvVar[], warnings: string[] } {
		const result: EnvVar[] = [];
		const warnings: string[] = [];
		let lineNum = 0;

		for (const line of content.split('\n')) {
			lineNum++;
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;

			const eqIndex = trimmed.indexOf('=');
			if (eqIndex === -1) {
				warnings.push(`Line ${lineNum}: "${trimmed.slice(0, 30)}${trimmed.length > 30 ? '...' : ''}" (no = found)`);
				continue;
			}

			const key = trimmed.slice(0, eqIndex).trim();
			let value = trimmed.slice(eqIndex + 1);

			if ((value.startsWith('"') && value.endsWith('"')) ||
			    (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			if (key) {
				if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
					warnings.push(`Line ${lineNum}: "${key}" (invalid variable name)`);
					continue;
				}
				result.push({ key, value, isSecret: false });
			}
		}

		return { vars: result, warnings };
	}

	/**
	 * Sync variables (non-secrets) TO rawContent.
	 * Preserves comments and formatting. Secrets are excluded.
	 */
	function syncVariablesToRaw() {
		const nonSecretVars = variables.filter(v => v.key.trim() && !v.isSecret);

		// If no raw content exists, generate fresh
		if (!rawContent.trim()) {
			if (nonSecretVars.length > 0) {
				rawContent = nonSecretVars.map(v => `${v.key.trim()}=${v.value}`).join('\n') + '\n';
			}
			return;
		}

		// Update existing raw content - preserve comments, update/add/remove variables
		const varMap = new Map(nonSecretVars.map(v => [v.key.trim(), v]));
		const usedKeys = new Set<string>();
		const lines = rawContent.split('\n');
		const resultLines: string[] = [];

		for (const line of lines) {
			const trimmed = line.trim();

			// Keep comments and blank lines
			if (!trimmed || trimmed.startsWith('#')) {
				resultLines.push(line);
				continue;
			}

			// Check if this is a variable line
			const eqIndex = trimmed.indexOf('=');
			if (eqIndex > 0) {
				const key = trimmed.slice(0, eqIndex).trim();
				if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
					const varData = varMap.get(key);
					if (varData) {
						// Update value
						resultLines.push(`${key}=${varData.value}`);
						usedKeys.add(key);
					}
					// If not in varMap, variable was deleted - skip line
					continue;
				}
			}

			resultLines.push(line);
		}

		// Append new variables
		for (const v of nonSecretVars) {
			if (!usedKeys.has(v.key.trim())) {
				resultLines.push(`${v.key.trim()}=${v.value}`);
			}
		}

		let result = resultLines.join('\n');
		if (result && !result.endsWith('\n')) {
			result += '\n';
		}
		rawContent = result;
	}

	/**
	 * Sync rawContent TO variables.
	 * Parses raw content for non-secrets, preserves existing secrets.
	 */
	function syncRawToVariables() {
		const { vars, warnings } = parseRawContent(rawContent);
		parseWarnings = warnings;

		// Preserve existing secrets (they're not in rawContent)
		const existingSecrets = variables.filter(v => v.isSecret);

		// Merge: non-secrets from raw + existing secrets
		variables = [...vars, ...existingSecrets];
	}

	/**
	 * Call before saving. Ensures variables and rawContent are in sync.
	 * Always syncs variables→raw to get proper .env content for disk.
	 */
	export function prepareForSave(): { rawContent: string; variables: EnvVar[] } {
		// If in text view, first sync raw→variables to capture edits
		if (viewMode === 'text') {
			syncRawToVariables();
		}
		// Then sync variables→raw to ensure rawContent is up to date
		syncVariablesToRaw();

		return {
			rawContent,
			variables: variables.filter(v => v.key.trim())
		};
	}

	function handleTextChange(value: string) {
		rawContent = value;
		syncRawToVariables(); // Sync to variables so parent's envVars updates (for compose decorations)
		onchange?.();
	}

	function handleViewModeChange(newMode: 'form' | 'text') {
		if (newMode === 'text' && viewMode === 'form') {
			// Form → Text: sync variables to raw (preserves comments)
			syncVariablesToRaw();
		} else if (newMode === 'form' && viewMode === 'text') {
			// Text → Form: sync raw to variables (preserves secrets)
			syncRawToVariables();
		}

		viewMode = newMode;
		localStorage.setItem(STORAGE_KEY_VIEW_MODE, newMode);
	}

	async function addEnvVariable() {
		variables = [...variables, { key: '', value: '', isSecret: false }];
		onchange?.();
		await tick();
		if (contentAreaRef) {
			contentAreaRef.scrollTop = contentAreaRef.scrollHeight;
		}
	}

	async function addMissingVariable(key: string) {
		variables = [...variables, { key, value: '', isSecret: false }];
		onchange?.();
		await tick();
		if (contentAreaRef) {
			contentAreaRef.scrollTop = contentAreaRef.scrollHeight;
		}
	}

	function handleLoadFromFile() {
		fileInputRef?.click();
	}

	function handleFileSelect(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = (e) => {
			rawContent = e.target?.result as string;
			// Parse and merge with existing secrets
			syncRawToVariables();
			// Switch to text view to show loaded content
			viewMode = 'text';
			localStorage.setItem(STORAGE_KEY_VIEW_MODE, 'text');
			onchange?.();
		};
		reader.readAsText(file);
		input.value = '';
	}

	function clearAll() {
		rawContent = '';
		variables = [];
		onchange?.();
	}

	const hasContent = $derived(!!rawContent?.trim() || variables.some(v => v.key.trim()));
</script>

<div class="flex flex-col h-full {className}">
	<!-- Header -->
	<div class="px-4 py-2.5 border-b border-zinc-200 dark:border-zinc-700 flex flex-col gap-1.5">
		<!-- Header row: title + info + view toggle + validation pills + actions -->
		<div class="flex items-center gap-2 justify-between">
			<div class="flex items-center gap-2 flex-wrap min-w-0">
				<span class="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">Environment variables</span>
			{#if infoText}
				<Tooltip.Root>
					<Tooltip.Trigger>
						<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help shrink-0" />
					</Tooltip.Trigger>
					<Tooltip.Content>
						<div class="w-80">
							<p class="text-xs text-left">{@html infoText}</p>
						</div>
					</Tooltip.Content>
				</Tooltip.Root>
			{/if}
			<!-- View mode toggle -->
			<div class="flex items-center gap-0.5 bg-zinc-100 dark:bg-zinc-800 rounded p-0.5 shrink-0">
				<button
					type="button"
					class="flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs transition-colors {viewMode === 'form' ? 'bg-white dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}"
					onclick={() => handleViewModeChange('form')}
					title="Form view"
				>
					<List class="w-3 h-3" />
				</button>
				<button
					type="button"
					class="flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs transition-colors {viewMode === 'text' ? 'bg-white dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}"
					onclick={() => handleViewModeChange('text')}
					title="Text view (raw .env file)"
				>
					<FileText class="w-3 h-3" />
				</button>
			</div>
			<!-- Validation status pills -->
			{#if validation}
				<div class="flex gap-1 flex-wrap">
					{#if validation.missing.length > 0}
						<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
							{validation.missing.length} missing
						</span>
					{/if}
					{#if validation.required.length > 0}
						<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
							{validation.required.length - validation.missing.length} defined
						</span>
					{/if}
					{#if validation.optional.length > 0}
						<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
							{validation.optional.length} optional
						</span>
					{/if}
				</div>
			{/if}
			</div>
			<!-- Actions - right-aligned -->
			{#if !readonly}
				<div class="flex items-center gap-1 shrink-0">
					{#if headerActions}
						{@render headerActions()}
					{/if}
					<Button type="button" size="sm" variant="ghost" onclick={handleLoadFromFile} class="h-6 text-xs px-2">
						<Upload class="w-3.5 h-3.5" />
						Load
					</Button>
					{#if viewMode === 'form'}
						<Button type="button" size="sm" variant="ghost" onclick={addEnvVariable} class="h-6 text-xs px-2">
							<Plus class="w-3.5 h-3.5" />
							Add
						</Button>
					{/if}
					<ConfirmPopover
						bind:open={confirmClearOpen}
						title="Clear all variables?"
						action="clear"
						itemType="environment variables"
						confirmText="Clear all"
						onConfirm={clearAll}
						onOpenChange={(o) => confirmClearOpen = o}
					>
						{#snippet children({ open })}
							<Button
								type="button"
								size="sm"
								variant="ghost"
								class="h-6 text-xs px-2 {hasContent ? 'text-destructive hover:text-destructive' : 'text-muted-foreground/50 cursor-not-allowed'}"
								disabled={!hasContent}
							>
								<Trash2 class="w-3.5 h-3.5" />
								Clear
							</Button>
						{/snippet}
					</ConfirmPopover>
				</div>
				<input
					bind:this={fileInputRef}
					type="file"
					accept=".env,.env.*,text/plain"
					class="hidden"
					onchange={handleFileSelect}
				/>
			{/if}
		</div>
		<!-- Help text -->
		{#if viewMode === 'form'}
			{#if showInterpolationHint}
				<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50">
					<Info class="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
					<p class="text-xs text-blue-700 dark:text-blue-300">
						These variables are available for <strong>compose file interpolation</strong> using <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">${'{VAR_NAME}'}</code> syntax.
						To pass them to containers, reference them in the compose file's <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">environment:</code> section.
					</p>
				</div>
			{/if}
			<div class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-zinc-400 dark:text-zinc-500 font-mono">
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR}`}</span> required</span>
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR:-default}`}</span> optional</span>
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR:?error}`}</span> required w/ error</span>
			</div>
		{:else if showInterpolationHint && secretCount > 0}
			<!-- Interpolation hint + secrets hint combined for text view -->
			<div class="flex flex-col gap-1.5">
				<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50">
					<Info class="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
					<p class="text-xs text-blue-700 dark:text-blue-300">
						These variables are available for <strong>compose file interpolation</strong> using <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">${'{VAR_NAME}'}</code> syntax.
						To pass them to containers, reference them in the compose file's <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">environment:</code> section.
					</p>
				</div>
				<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
					<ShieldAlert class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
					<div class="text-xs text-amber-700 dark:text-amber-300">
						<span class="font-medium">{secretCount} secret{secretCount === 1 ? '' : 's'} not shown.</span>
						<span class="text-amber-600 dark:text-amber-400">Secrets are never written to disk and are injected via shell environment when the stack starts.</span>
					</div>
				</div>
			</div>
		{:else if showInterpolationHint}
			<!-- Interpolation hint only (no secrets) -->
			<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50">
				<Info class="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
				<p class="text-xs text-blue-700 dark:text-blue-300">
					These variables are available for <strong>compose file interpolation</strong> using <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">${'{VAR_NAME}'}</code> syntax.
					To pass them to containers, reference them in the compose file's <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">environment:</code> section.
				</p>
			</div>
		{:else if secretCount > 0}
			<!-- Text view hint about secrets (only shown when secrets exist) -->
			<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
				<ShieldAlert class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
				<div class="text-xs text-amber-700 dark:text-amber-300">
					<span class="font-medium">{secretCount} secret{secretCount === 1 ? '' : 's'} not shown.</span>
					<span class="text-amber-600 dark:text-amber-400">Secrets are never written to disk and are injected via shell environment when the stack starts.</span>
				</div>
			</div>
		{/if}
		<!-- Parse warnings (form mode only) -->
		{#if viewMode === 'form' && parseWarnings.length > 0}
			<div class="flex items-start gap-2 px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
				<AlertTriangle class="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
				<div class="text-2xs text-amber-700 dark:text-amber-300">
					<span class="font-medium">Some lines couldn't be parsed:</span>
					<ul class="mt-0.5 list-disc list-inside">
						{#each parseWarnings.slice(0, 3) as warning}
							<li>{warning}</li>
						{/each}
						{#if parseWarnings.length > 3}
							<li>...and {parseWarnings.length - 3} more</li>
						{/if}
					</ul>
					<p class="mt-1 text-amber-600 dark:text-amber-400">Switch to text view to edit these lines.</p>
				</div>
			</div>
		{/if}
		<!-- Add missing variables (form mode only) -->
		{#if viewMode === 'form' && validation && validation.missing.length > 0 && !readonly}
			<div class="flex flex-wrap gap-1 items-center">
				<span class="text-xs text-muted-foreground mr-1">Add missing:</span>
				{#each validation.missing as missing}
					<button
						type="button"
						onclick={() => addMissingVariable(missing)}
						class="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50 transition-colors"
					>
						{missing}
					</button>
				{/each}
			</div>
		{/if}
	</div>
	<!-- Content area -->
	<div bind:this={contentAreaRef} class="flex-1 overflow-auto px-4 py-3">
		{#if viewMode === 'form'}
			<StackEnvVarsEditor
				bind:variables
				{validation}
				{readonly}
				{showSource}
				{sources}
				{fileValues}
				{placeholder}
				{existingSecretKeys}
				{onchange}
			/>
		{:else}
			<CodeEditor
				value={textEditorContent}
				language="dotenv"
				theme={theme}
				readonly={readonly}
				onchange={handleTextChange}
				class="h-full min-h-[200px] rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700"
			/>
		{/if}
	</div>
</div>
