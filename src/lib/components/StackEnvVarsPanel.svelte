<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import StackEnvVarsEditor, { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import { Plus, Upload, Trash2, List, FileText, AlertTriangle, ShieldAlert, HelpCircle, Info, Check, KeyRound, ChevronRight } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { getProviderIcon } from '$lib/components/provider-icons';
	import { providerTypeLabel } from '../../routes/settings/secrets/ProviderModal.svelte';
	import { effectiveMissing, isInlineProviderRef } from '$lib/utils/invault-markers';
	import { parseRawContent, generateRawContent, keysInRawContent, mergeParsedIntoVariables, mergeVariablesIntoRawContent, textEditorContent as deriveTextEditorContent, injectedKeysNeedCollapse } from '$lib/utils/env-panel-core';
	import { m } from '$lib/paraglide/messages.js';

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
		/** Provider-injected key NAMES from the last deploy (banner). */
		injectedSecretKeys?: string[];
		/** Bound provider type/name, for the injected banner + pills. */
		providerType?: string | null;
		providerName?: string | null;
		/**
		 * Whether a secret provider is CURRENTLY bound to this stack. When false but
		 * injectedSecretKeys is non-empty, the keys are historical (from the last deploy)
		 * and the next deploy will drop them - the banner says so instead of implying they
		 * are still active (#1522).
		 */
		providerBound?: boolean;
		/** Set when the live provider probe failed - shown as an amber line. */
		probeError?: string | null;
		/** Key NAMES the live probe found in the bound provider (present RIGHT NOW).
		 *  These are not "missing" even without a local value. Empty on probe failure. */
		providerKeySet?: Set<string>;
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
		injectedSecretKeys = [],
		providerType = null,
		providerName = null,
		providerBound = true,
		probeError = null,
		providerKeySet = new Set<string>(),
		showInterpolationHint = false,
		theme = 'dark',
		class: className = '',
		onchange,
		headerActions
	}: Props = $props();


	// A ${VAR} the bound provider currently supplies (LIVE probe) is NOT "missing" even
	// without a local value. Drop those from the panel's missing count / "Add missing"
	// list so the panel matches the editor's IN VAULT markers - same source, one truth.
	// This is purely live: the last-deploy injected names drive only the banner, never
	// this set. A failed probe leaves providerKeySet empty, so those keys stay missing.
	const effectiveValidation = $derived.by<ValidationResult | null>(() => {
		if (!validation || providerKeySet.size === 0) return validation;
		return {
			...validation,
			missing: effectiveMissing(validation.missing, providerKeySet)
		};
	});

	const STORAGE_KEY_VIEW_MODE = 'dockhand-env-vars-view-mode';
	// Collapsed by default: a provider can inject dozens of keys, and the full badge
	// list otherwise dominates the panel. The choice is remembered across sessions.
	const STORAGE_KEY_INJECTED_EXPANDED = 'dockhand-env-vars-injected-expanded';

	let fileInputRef: HTMLInputElement;
	let viewMode = $state<'form' | 'text'>(
		(typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY_VIEW_MODE) as 'form' | 'text') || 'form'
	);
	let injectedKeysExpanded = $state<boolean>(
		typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY_INJECTED_EXPANDED) === 'true'
	);
	function toggleInjectedKeys() {
		injectedKeysExpanded = !injectedKeysExpanded;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY_INJECTED_EXPANDED, String(injectedKeysExpanded));
		}
	}
	// A short list stays inline (no toggle); a long one gets the collapse control.
	const injectedKeysCollapsible = $derived(injectedKeysNeedCollapse(injectedSecretKeys.length));
	const injectedKeysVisible = $derived(!injectedKeysCollapsible || injectedKeysExpanded);
	let confirmClearOpen = $state(false);
	let contentAreaRef: HTMLDivElement;
	let parseWarnings = $state<string[]>([]);

	// Count of secrets (for display in hint)
	const secretCount = $derived(variables.filter(v => v.isSecret && v.key.trim()).length);

	// True when any variable's VALUE is a provider reference. Such a reference is
	// resolved only here (stack env), never when written straight into a compose
	// environment: block - so we surface a hint.
	const hasProviderReference = $derived(
		variables.some((v) => isInlineProviderRef((v.value ?? '').trim()))
	);

	// What text view shows: the .env file, or the non-secret rows rendered as text when
	// there is no file yet.
	const textEditorContent = $derived(deriveTextEditorContent(rawContent, variables));

	/**
	 * Sync variables with rawContent after initial load.
	 * Pass the loaded data directly to avoid timing issues with bindable props.
	 * Merges: secrets from loadedVars (DB) + non-secrets from loadedRaw (file).
	 */
	export function syncAfterLoad(loadedVars: EnvVar[], loadedRaw: string) {
		if (!loadedRaw.trim()) {
			// No raw content from file - just set variables; text view renders them as text
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
	 * Sync variables (non-secrets) TO rawContent.
	 * Preserves comments and formatting. Secrets are excluded.
	 */
	function syncVariablesToRaw() {
		const nonSecretVars = variables.filter(v => v.key.trim() && !v.isSecret);

		// If no raw content exists, generate fresh
		if (!rawContent.trim()) {
			if (nonSecretVars.length > 0) {
				rawContent = generateRawContent(nonSecretVars);
			}
			return;
		}

		rawContent = mergeVariablesIntoRawContent(rawContent, variables);
	}

	/**
	 * Parse editor text back into variables.
	 *
	 * `shownBefore` is what the editor was displaying before this text arrived. Rows
	 * outside it were never on screen - a selector written straight into variables by
	 * the provider picker, say - so they are kept rather than wiped (#1620). Rows that
	 * WERE on screen and are absent from the new text were deleted by the user.
	 */
	function syncRawToVariables(content?: string, shownBefore?: Set<string>) {
		const { vars, warnings } = parseRawContent(content ?? rawContent);
		parseWarnings = warnings;
		variables = mergeParsedIntoVariables(vars, variables, shownBefore ?? keysInRawContent(textEditorContent));
	}

	/**
	 * Call before saving. Ensures variables and rawContent are in sync.
	 * Always syncs variables→raw to get proper .env content for disk.
	 */
	export function prepareForSave(): { rawContent: string; variables: EnvVar[] } {
		// If in text view, first sync raw->variables to capture edits. Parse what the
		// editor SHOWS: with an empty .env that is the rows rendered as text, and reading
		// rawContent instead would drop every visible non-secret row (#1620).
		if (viewMode === 'text') {
			syncRawToVariables(textEditorContent);
		}
		// Then sync variables→raw to ensure rawContent is up to date
		syncVariablesToRaw();

		return {
			rawContent,
			variables: variables.filter(v => v.key.trim())
		};
	}

	function handleTextChange(value: string) {
		// Capture what was on screen BEFORE the edit, so a row the user just deleted is
		// not mistaken for one the editor never showed.
		const shownBefore = keysInRawContent(textEditorContent);
		rawContent = value;
		syncRawToVariables(value, shownBefore); // keeps parent's envVars live for compose decorations
		onchange?.();
	}

	function handleViewModeChange(newMode: 'form' | 'text') {
		if (newMode === 'text' && viewMode === 'form') {
			// Form → Text: sync variables to raw (preserves comments)
			syncVariablesToRaw();
		} else if (newMode === 'form' && viewMode === 'text') {
			// Text -> Form: parse what the editor shows, which is the rows rendered as text
			// when there is no .env file (keeps vars that only exist as rows)
			syncRawToVariables(textEditorContent);
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
				<span class="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">{m.stackenv_title()}</span>
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
					title={m.stackenv_view_form()}
				>
					<List class="w-3 h-3" />
				</button>
				<button
					type="button"
					class="flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs transition-colors {viewMode === 'text' ? 'bg-white dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}"
					onclick={() => handleViewModeChange('text')}
					title={m.stackenv_view_text()}
				>
					<FileText class="w-3 h-3" />
				</button>
			</div>
			<!-- Validation status pills -->
			{#if effectiveValidation}
				<div class="flex gap-1 flex-wrap">
					{#if effectiveValidation.missing.length > 0}
						<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
							{m.stackenv_pill_missing({ count: effectiveValidation.missing.length })}
						</span>
					{/if}
					{#if effectiveValidation.required.length > 0}
						<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
							{m.stackenv_pill_defined({ count: effectiveValidation.required.length - effectiveValidation.missing.length })}
						</span>
					{/if}
					{#if effectiveValidation.optional.length > 0}
						<span class="inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
							{m.stackenv_pill_optional({ count: effectiveValidation.optional.length })}
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
						{m.stackenv_load()}
					</Button>
					{#if viewMode === 'form'}
						<Button type="button" size="sm" variant="ghost" onclick={addEnvVariable} class="h-6 text-xs px-2">
							<Plus class="w-3.5 h-3.5" />
							{m.stackenv_add()}
						</Button>
					{/if}
					<ConfirmPopover
						bind:open={confirmClearOpen}
						localized
						title={m.stackenv_clear_title()}
						action={m.stackenv_confirm_action_clear()}
						itemType={m.stackenv_item_environment_variables()}
						confirmText={m.stackenv_clear_confirm()}
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
								{m.stackenv_clear()}
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
						{m.stackenv_interpolation_before()} <strong>{m.stackenv_interpolation_strong()}</strong> {m.stackenv_interpolation_using()} <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">${'{VAR_NAME}'}</code> {m.stackenv_interpolation_after()}
						{m.stackenv_interpolation_pass_before()} <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">environment:</code> {m.stackenv_interpolation_pass_after()}
					</p>
				</div>
			{/if}
			<div class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-zinc-400 dark:text-zinc-500 font-mono">
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR}`}</span> {m.stackenv_syntax_required()}</span>
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR:-default}`}</span> {m.stackenv_syntax_optional()}</span>
				<span><span class="text-zinc-500 dark:text-zinc-400">${`{VAR:?error}`}</span> {m.stackenv_syntax_required_error()}</span>
			</div>
		{:else if showInterpolationHint && secretCount > 0}
			<!-- Interpolation hint + secrets hint combined for text view -->
			<div class="flex flex-col gap-1.5">
				<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50">
					<Info class="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
					<p class="text-xs text-blue-700 dark:text-blue-300">
						{m.stackenv_interpolation_before()} <strong>{m.stackenv_interpolation_strong()}</strong> {m.stackenv_interpolation_using()} <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">${'{VAR_NAME}'}</code> {m.stackenv_interpolation_after()}
						{m.stackenv_interpolation_pass_before()} <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">environment:</code> {m.stackenv_interpolation_pass_after()}
					</p>
				</div>
				<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
					<ShieldAlert class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
					<div class="text-xs text-amber-700 dark:text-amber-300">
						<span class="font-medium">{m.stackenv_secrets_not_shown({ count: secretCount })}</span>
						<span class="text-amber-600 dark:text-amber-400">{m.stackenv_secrets_not_shown_detail()}</span>
					</div>
				</div>
			</div>
		{:else if showInterpolationHint}
			<!-- Interpolation hint only (no secrets) -->
			<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50">
				<Info class="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
				<p class="text-xs text-blue-700 dark:text-blue-300">
					{m.stackenv_interpolation_before()} <strong>{m.stackenv_interpolation_strong()}</strong> {m.stackenv_interpolation_using()} <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">${'{VAR_NAME}'}</code> {m.stackenv_interpolation_after()}
					{m.stackenv_interpolation_pass_before()} <code class="bg-blue-100 dark:bg-blue-800/40 px-1 rounded">environment:</code> {m.stackenv_interpolation_pass_after()}
				</p>
			</div>
		{:else if secretCount > 0}
			<!-- Text view hint about secrets (only shown when secrets exist) -->
			<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
				<ShieldAlert class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
				<div class="text-xs text-amber-700 dark:text-amber-300">
					<span class="font-medium">{m.stackenv_secrets_not_shown({ count: secretCount })}</span>
					<span class="text-amber-600 dark:text-amber-400">{m.stackenv_secrets_not_shown_detail()}</span>
				</div>
			</div>
		{/if}
		<!-- Provider-reference placement hint: inline refs only resolve here, not in compose environment: -->
		{#if hasProviderReference}
			<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
				<Info class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
				<p class="text-xs text-amber-700 dark:text-amber-300">
					{m.stackenv_providerref_before()} (<code class="bg-amber-100 dark:bg-amber-800/40 px-1 rounded">op://</code>, <code class="bg-amber-100 dark:bg-amber-800/40 px-1 rounded">keepass://</code>, <code class="bg-amber-100 dark:bg-amber-800/40 px-1 rounded">azurekv://</code>, <code class="bg-amber-100 dark:bg-amber-800/40 px-1 rounded">pass://</code>) {m.stackenv_providerref_resolved()} <strong>{m.stackenv_providerref_here()}</strong>{m.stackenv_providerref_here_after()} <strong>{m.stackenv_providerref_not()}</strong> {m.stackenv_providerref_not_after()} <code class="bg-amber-100 dark:bg-amber-800/40 px-1 rounded">environment:</code> {m.stackenv_providerref_block()} <code class="bg-amber-100 dark:bg-amber-800/40 px-1 rounded">${'{VAR}'}</code> {m.stackenv_providerref_instead()}
				</p>
			</div>
		{/if}
		<!-- Parse warnings (form mode only) -->
		{#if viewMode === 'form' && parseWarnings.length > 0}
			<div class="flex items-start gap-2 px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
				<AlertTriangle class="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
				<div class="text-2xs text-amber-700 dark:text-amber-300">
					<span class="font-medium">{m.stackenv_parse_warnings_title()}</span>
					<ul class="mt-0.5 list-disc list-inside">
						{#each parseWarnings.slice(0, 3) as warning}
							<li>{warning}</li>
						{/each}
						{#if parseWarnings.length > 3}
							<li>{m.stackenv_parse_warnings_more({ count: parseWarnings.length - 3 })}</li>
						{/if}
					</ul>
					<p class="mt-1 text-amber-600 dark:text-amber-400">{m.stackenv_parse_warnings_hint()}</p>
				</div>
			</div>
		{/if}
		<!-- Provider-injected secrets loaded at the last deploy -->
		{#if injectedSecretKeys.length > 0 && providerBound}
			<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50">
				<Check class="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
				<div class="text-xs text-emerald-700 dark:text-emerald-300 min-w-0">
					<div class="flex items-center gap-1.5 flex-wrap">
						<span class="font-semibold">{m.stackenv_injected_loaded({ count: injectedSecretKeys.length })}</span>
						<span class="text-emerald-600/70 dark:text-emerald-400/70">{m.stackenv_injected_from()}</span>
						{#if providerType}
							{@const ProviderIcon = getProviderIcon(providerType)}
							<span class="inline-flex items-center gap-1 font-medium">
								<ProviderIcon class="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
								{providerTypeLabel(providerType)}
							</span>
							{#if providerName}<span class="text-emerald-600/70 dark:text-emerald-400/70">&middot; {providerName}</span>{/if}
						{:else}
							<span class="font-medium">{m.stackenv_injected_the_provider()}</span>
						{/if}
						{#if injectedKeysCollapsible}
							<button
								type="button"
								onclick={toggleInjectedKeys}
								class="inline-flex items-center gap-0.5 ml-0.5 font-medium text-emerald-600 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-200 transition-colors"
								aria-expanded={injectedKeysExpanded}
							>
								<ChevronRight class="w-3 h-3 transition-transform {injectedKeysExpanded ? 'rotate-90' : ''}" />
								{injectedKeysExpanded ? m.stackenv_injected_hide() : m.stackenv_injected_show()}
							</button>
						{/if}
					</div>
					<p class="text-emerald-600 dark:text-emerald-400 mt-0.5">{m.stackenv_injected_detail_before()} <code>.env</code>{m.stackenv_injected_detail_after()}</p>
					{#if injectedKeysVisible}
						<div class="flex flex-wrap gap-1.5 mt-1.5">
							{#each injectedSecretKeys as key}
								<span class="inline-flex items-center gap-1 font-mono text-2xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-800/40 border border-emerald-300 dark:border-emerald-700">
									<KeyRound class="w-2.5 h-2.5" />{key}
								</span>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		{:else if injectedSecretKeys.length > 0 && !providerBound}
			<!-- Historical: keys were injected on a previous deploy but no provider is bound now (#1522). -->
			<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
				<AlertTriangle class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
				<div class="text-xs text-amber-700 dark:text-amber-300 min-w-0">
					<div class="flex items-center gap-1.5 flex-wrap">
						<span class="font-semibold">{m.stackenv_unbound_title()}</span>
						{#if injectedKeysCollapsible}
							<button
								type="button"
								onclick={toggleInjectedKeys}
								class="inline-flex items-center gap-0.5 font-medium text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 transition-colors"
								aria-expanded={injectedKeysExpanded}
							>
								<ChevronRight class="w-3 h-3 transition-transform {injectedKeysExpanded ? 'rotate-90' : ''}" />
								{injectedKeysExpanded ? m.stackenv_injected_hide() : m.stackenv_injected_show()}
							</button>
						{/if}
					</div>
					<p class="text-amber-600 dark:text-amber-400 mt-0.5">
						{m.stackenv_unbound_detail({ count: injectedSecretKeys.length })}
					</p>
					{#if injectedKeysVisible}
						<div class="flex flex-wrap gap-1.5 mt-1.5">
							{#each injectedSecretKeys as key}
								<span class="inline-flex items-center gap-1 font-mono text-2xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-800/40 border border-amber-300 dark:border-amber-700 line-through decoration-amber-500/60">
									<KeyRound class="w-2.5 h-2.5" />{key}
								</span>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		{/if}
		<!-- Live provider probe couldn't reach the provider: keys fall back to MISSING -->
		{#if probeError}
			<div class="flex items-start gap-2 px-2.5 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50">
				<AlertTriangle class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
				<div class="text-xs text-amber-700 dark:text-amber-300 min-w-0">
					{providerName != null ? m.stackenv_probe_failed_named({ provider: providerName, error: probeError }) : m.stackenv_probe_failed({ error: probeError })}
				</div>
			</div>
		{/if}
		<!-- Add missing variables (form mode only) -->
		{#if viewMode === 'form' && effectiveValidation && effectiveValidation.missing.length > 0 && !readonly}
			<div class="flex flex-wrap gap-1 items-center">
				<span class="text-xs text-muted-foreground mr-1">{m.stackenv_add_missing()}</span>
				{#each effectiveValidation.missing as missing}
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
				validation={effectiveValidation}
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
