<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import StackEnvVarsEditor, { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { Plus, Info, Upload, Trash2, List, FileText, AlertTriangle } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

	interface Props {
		variables: EnvVar[]; // Bindable - kept in sync with rawContent
		rawContent?: string; // The actual content saved to disk - source of truth
		validation?: ValidationResult | null;
		readonly?: boolean;
		showSource?: boolean;
		sources?: Record<string, 'file' | 'override'>;
		placeholder?: { key: string; value: string };
		infoText?: string;
		existingSecretKeys?: Set<string>;
		class?: string;
		onchange?: () => void;
	}

	let {
		variables = $bindable([]),
		rawContent = $bindable(''),
		validation = null,
		readonly = false,
		showSource = false,
		sources = {},
		placeholder = { key: 'VARIABLE_NAME', value: 'value' },
		infoText,
		existingSecretKeys = new Set<string>(),
		class: className = '',
		onchange
	}: Props = $props();

	const STORAGE_KEY_VIEW_MODE = 'dockhand-env-vars-view-mode';

	let fileInputRef: HTMLInputElement;
	let viewMode = $state<'form' | 'text'>(
		(typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY_VIEW_MODE) as 'form' | 'text') || 'form'
	);
	let confirmClearOpen = $state(false);
	let contentAreaRef: HTMLDivElement;
	let parseWarnings = $state<string[]>([]);
	let editorTheme = $state<'light' | 'dark'>('dark');

	// Track previous variables to detect form changes
	let prevVariablesJson = $state('');

	// Track if initial sync has been done (to distinguish initial load from user action)
	let initialized = $state(false);

	// Parse raw content to EnvVar array
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
				result.push({
					key,
					value,
					isSecret: existingSecretKeys.has(key) || false
				});
			}
		}

		return { vars: result, warnings };
	}

	// Update rawContent when variables change - replace var lines by position, preserve comments
	function syncRawContentFromVariables(newVars: EnvVar[]) {
		const lines = rawContent.split('\n');
		const resultLines: string[] = [];
		const varsWithKeys = newVars.filter(v => v.key.trim());
		let varIdx = 0;

		for (const line of lines) {
			const trimmed = line.trim();
			// Keep comments and blank lines
			if (!trimmed || trimmed.startsWith('#')) {
				resultLines.push(line);
				continue;
			}

			const eqIndex = trimmed.indexOf('=');
			if (eqIndex > 0) {
				const key = trimmed.slice(0, eqIndex).trim();
				if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
					// This is a valid variable line - replace with var at current index
					if (varIdx < varsWithKeys.length) {
						const v = varsWithKeys[varIdx];
						resultLines.push(`${v.key.trim()}=${v.value}`);
						varIdx++;
					}
					// If we have fewer vars, this line is deleted
					continue;
				}
			}
			// Keep invalid lines as-is
			resultLines.push(line);
		}

		// Append any new variables
		while (varIdx < varsWithKeys.length) {
			const v = varsWithKeys[varIdx];
			resultLines.push(`${v.key.trim()}=${v.value}`);
			varIdx++;
		}

		let result = resultLines.join('\n');
		if (result && !result.endsWith('\n')) {
			result += '\n';
		}
		return result;
	}

	// When rawContent changes externally (text view, file load), update variables
	$effect(() => {
		const { vars, warnings } = parseRawContent(rawContent);
		parseWarnings = warnings;

		// Initial load with no .env file: don't overwrite DB-loaded variables
		// Let the second $effect generate rawContent from the existing variables instead
		if (!initialized && !rawContent.trim() && variables.length > 0) {
			initialized = true;
			return;
		}
		initialized = true;

		// When rawContent has content, merge parsed vars with existing DB secrets
		// This handles the case where .env file exists but DB has additional secrets
		let finalVars = vars;
		if (rawContent.trim()) {
			const parsedKeys = new Set(vars.map(v => v.key));
			const existingSecrets = untrack(() =>
				variables.filter(v => v.isSecret && !parsedKeys.has(v.key))
			);
			if (existingSecrets.length > 0) {
				finalVars = [...vars, ...existingSecrets];
			}
		}

		const newJson = JSON.stringify(finalVars.map(v => ({ key: v.key, value: v.value })));
		// Use untrack to read variables without creating a dependency on it
		// This prevents the effect from running when variables changes (only rawContent should trigger it)
		const currentNonEmptyJson = untrack(() =>
			JSON.stringify(variables.filter(v => v.key.trim()).map(v => ({ key: v.key, value: v.value })))
		);

		if (newJson !== currentNonEmptyJson) {
			variables = finalVars;
			prevVariablesJson = newJson;
		}
	});

	// When variables change from form edits, update rawContent
	$effect(() => {
		const currentJson = JSON.stringify(variables.map(v => ({ key: v.key, value: v.value })));

		// Only sync if variables actually changed (not from parsing rawContent)
		if (currentJson !== prevVariablesJson) {
			prevVariablesJson = currentJson;
			const newRaw = syncRawContentFromVariables(variables);
			if (newRaw !== rawContent) {
				rawContent = newRaw;
			}
		}
	});

	function handleTextChange(value: string) {
		rawContent = value;
		onchange?.();
	}

	function handleViewModeChange(newMode: 'form' | 'text') {
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
		<div class="flex items-center justify-between gap-2">
			<div class="flex items-center gap-2 flex-nowrap min-w-0">
				<span class="text-xs text-zinc-500 dark:text-zinc-400">Environment variables</span>
				{#if infoText}
					<Tooltip.Root>
						<Tooltip.Trigger>
							<Info class="w-3.5 h-3.5 text-blue-400" />
						</Tooltip.Trigger>
						<Tooltip.Portal>
							<Tooltip.Content side="bottom" sideOffset={8} class="max-w-xs w-64 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 border-zinc-200 dark:border-zinc-700">
								<p class="text-xs text-left">{infoText}</p>
							</Tooltip.Content>
						</Tooltip.Portal>
					</Tooltip.Root>
				{/if}
				<!-- View mode toggle -->
				<div class="flex items-center gap-0.5 bg-zinc-100 dark:bg-zinc-800 rounded p-0.5 ml-1">
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
			</div>
			{#if !readonly}
				<div class="flex items-center gap-1 shrink-0 ml-4">
					<Button type="button" size="sm" variant="ghost" onclick={handleLoadFromFile} class="h-6 text-xs px-2">
						<Upload class="w-3.5 h-3.5 mr-1" />
						Load .env
					</Button>
					{#if viewMode === 'form'}
						<Button type="button" size="sm" variant="ghost" onclick={addEnvVariable} class="h-6 text-xs px-2">
							<Plus class="w-3.5 h-3.5 mr-1" />
							Add
						</Button>
					{/if}
					<div class="{hasContent ? '' : 'invisible'}">
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
								<Button type="button" size="sm" variant="ghost" class="h-6 text-xs px-2 text-destructive hover:text-destructive">
									<Trash2 class="w-3.5 h-3.5 mr-1" />
									Clear
								</Button>
							{/snippet}
						</ConfirmPopover>
					</div>
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
			<div class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-zinc-400 dark:text-zinc-500 font-mono">
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR}`}</span> required</span>
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR:-default}`}</span> optional</span>
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR:?error}`}</span> required w/ error</span>
			</div>
		{:else}
			<div class="text-2xs text-zinc-400 dark:text-zinc-500">
				Raw .env file (comments preserved, saved exactly as typed)
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
				{placeholder}
				{existingSecretKeys}
			/>
		{:else}
			<CodeEditor
				value={rawContent}
				language="dotenv"
				theme={editorTheme}
				readonly={readonly}
				onchange={handleTextChange}
				class="h-full min-h-[200px] rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700"
			/>
		{/if}
	</div>
</div>
