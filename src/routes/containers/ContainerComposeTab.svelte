<script lang="ts">
	/**
	 * "Compose" tab in the container inspect modal (#489): generates a docker-compose
	 * service definition from the container's inspect and lets the user validate it, copy /
	 * download it, save it as a NEW stack, or merge it into an EXISTING internal stack (with
	 * the merged-in lines highlighted before saving).
	 */
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { ToggleSwitch } from '$lib/components/ui/toggle-pill';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Loader2, Copy, Check, Download, Layers, FileCode, ChevronDown, ListPlus, ShieldCheck, Info, Save } from 'lucide-svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import StackIcon from '$lib/components/StackIcon.svelte';
	import StackModal from '../stacks/StackModal.svelte';
	import ComposeValidatePanel from '../stacks/ComposeValidatePanel.svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { toast } from 'svelte-sonner';
	import { mergeServiceIntoCompose, computeAddedRange } from '$lib/utils/compose-merge';

	interface Props {
		containerId: string;
		containerName: string;
		envId: number | null;
	}
	let { containerId, containerName, envId }: Props = $props();

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	/** Compose with only user-set env; and the variant that keeps every (image-inherited) env var. */
	let composeUserEnv = $state('');
	let composeFullEnv = $state('');
	let serviceName = $state('');
	let stackProject = $state<string | null>(null);
	let envMode = $state<'user' | 'all'>('user');
	const onlyUserEnv = $derived(envMode === 'user');
	let copied = $state(false);

	// The editor holds the user's (possibly edited) content. It is seeded from the generated
	// compose and re-seeded when the env toggle flips (unless the user has edited).
	let editorContent = $state('');
	let userEdited = $state(false);
	let editorRef = $state<CodeEditor | null>(null);
	let addedLineMarkers = $state<{ line: number; endLine: number }[]>([]);

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch(appendEnvParam(`/api/containers/${containerId}/compose`, envId));
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `Failed to generate compose (${res.status})`);
			}
			const data = await res.json();
			composeUserEnv = data.compose ?? '';
			composeFullEnv = data.composeFullEnv ?? '';
			serviceName = data.serviceName ?? containerName;
			stackProject = data.stackProject ?? null;
			editorContent = onlyUserEnv ? composeUserEnv : composeFullEnv;
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Failed to generate compose';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (containerId) load();
	});

	// React to the env toggle. Takes the mode explicitly (not the derived `onlyUserEnv`) so
	// it uses the NEW value synchronously. Works consistently in BOTH modes: a plain compose
	// re-seeds the editor; a merge-under-review RE-MERGES the service in the new env variant
	// (so the toggle behaves the same as it does for a new stack). A hand-edit opts out.
	function reseedEditor(mode: 'user' | 'all') {
		if (userEdited) return;
		const variant = mode === 'user' ? composeUserEnv : composeFullEnv;
		if (mergedIntoStack) {
			applyMerge(variant, mergedIntoStack); // applyMerge revalidates itself
		} else {
			editorContent = variant;
			editorRef?.setValue(variant);
			afterContentChanged();
		}
	}

	// The editor content just changed programmatically (toggle / merge / cancel). Any open
	// validate report is now stale (line numbers moved), so re-run it if the panel is open,
	// otherwise drop the stale findings.
	function afterContentChanged() {
		if (validatePanelOpen) runValidate();
		else validateReport = null;
	}

	function onEditorChange(v: string) {
		editorContent = v;
		userEdited = true;
		// A hand-edit invalidates the "these are the added lines" highlight.
		if (addedLineMarkers.length > 0) addedLineMarkers = [];
	}

	async function doCopy() {
		const ok = await copyToClipboard(editorContent);
		if (ok) {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} else {
			toast.error('Failed to copy');
		}
	}

	function doDownload() {
		const blob = new Blob([editorContent], { type: 'text/yaml' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${serviceName || containerName}.compose.yaml`;
		a.click();
		URL.revokeObjectURL(url);
	}

	// --- Validate (reuses the Compose Validate engine via the stacks endpoint) ---
	let validatePanelOpen = $state(false);
	let validateLoading = $state(false);
	let validateError = $state<string | null>(null);
	let validateActiveLine = $state<number | null>(null);
	let validateReport = $state<import('../stacks/ComposeValidatePanel.svelte').ValidateReport | null>(null);
	let validateSeq = 0;
	const validateMarkers = $derived(
		(validateReport?.findings ?? [])
			.filter((f) => typeof f.line === 'number')
			.map((f) => ({ line: f.line!, severity: f.severity, ruleId: f.ruleId, message: f.message }))
	);

	async function runValidate() {
		if (!editorContent.trim()) return;
		validateLoading = true;
		validateError = null;
		validatePanelOpen = true;
		const seq = ++validateSeq;
		try {
			const res = await fetch(
				appendEnvParam(`/api/stacks/${encodeURIComponent(serviceName || 'generated')}/validate`, envId),
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ compose: editorContent })
				}
			);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `Validation failed (${res.status})`);
			}
			const fresh = await res.json();
			if (seq !== validateSeq) return;
			validateReport = fresh;
		} catch (e) {
			if (seq !== validateSeq) return;
			validateError = e instanceof Error ? e.message : 'Validation failed';
			validateReport = null;
		} finally {
			if (seq === validateSeq) validateLoading = false;
		}
	}

	function jumpToLine(line: number) {
		validateActiveLine = line;
		editorRef?.scrollToLine?.(line);
	}

	// --- Save as NEW stack (StackModal prefilled) ---
	let stackModalOpen = $state(false);

	// --- Add to an EXISTING internal stack ---
	interface StackOption {
		name: string;
		icon: string | null;
	}
	let existingStacks = $state<StackOption[]>([]);
	let loadingStacks = $state(false);
	let merging = $state(false);
	let mergedIntoStack = $state<string | null>(null);
	let appendMenuOpen = $state(false);
	// The target stack's own compose, captured once so the env toggle can RE-merge the
	// service (in the current env variant) onto a clean base instead of merge-on-merge.
	let mergeBaseCompose = $state<string>('');

	async function loadInternalStacks() {
		loadingStacks = true;
		try {
			const res = await fetch(appendEnvParam('/api/stacks', envId));
			const all = res.ok ? await res.json() : [];
			existingStacks = (all as any[])
				.filter((s) => s.sourceType === 'internal')
				.map((s) => ({ name: s.name, icon: s.icon ?? null }));
		} catch {
			existingStacks = [];
		} finally {
			loadingStacks = false;
		}
	}

	/**
	 * Merge the generated service into an existing stack's compose (parse -> insert -> dump),
	 * auto-suffixing the service key on a name clash, then show the merged doc with the added
	 * lines highlighted. The user reviews/edits before Save writes it.
	 */
	async function addToExisting(stack: StackOption) {
		appendMenuOpen = false; // the async handler doesn't auto-close the menu
		if (mergedIntoStack) return; // already reviewing a merge; cancel it first
		merging = true;
		try {
			const res = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stack.name)}/compose`, envId));
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `Failed to read ${stack.name} compose`);
			}
			const { content } = await res.json();
			mergeBaseCompose = content ?? '';
			mergedIntoStack = stack.name;
			// Merge using the CURRENT env variant of the generated service (warn on clash once).
			applyMerge(onlyUserEnv ? composeUserEnv : composeFullEnv, stack.name, true);
			toast.info(`Merged into ${stack.name} - review the highlighted service, then Save`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Merge failed');
		} finally {
			merging = false;
		}
	}

	/**
	 * Merge `serviceCompose`'s single service onto the captured base stack compose and show
	 * it with the added lines highlighted. Pure w.r.t. the network - re-run on env toggle to
	 * swap which env variant of the service is merged in.
	 */
	function applyMerge(serviceCompose: string, stackName: string, notify = false) {
		const { merged, key, renamed } = mergeServiceIntoCompose(mergeBaseCompose, serviceCompose);
		// Only warn on the first merge - re-merges from the env toggle would re-spam the toast.
		if (renamed && notify) {
			const original = key.replace(/-\d+$/, '');
			toast.warning(`"${original}" already exists in ${stackName}; added as "${key}"`);
		}
		// Set text + highlight in ONE transaction so the decorations land on the new doc.
		const ranges = computeAddedRange(merged, key);
		addedLineMarkers = ranges;
		editorContent = merged;
		userEdited = false;
		editorRef?.setValueWithAddedRanges(merged, ranges);
		afterContentChanged();
	}

	async function saveToExisting() {
		if (!mergedIntoStack) return;
		merging = true;
		try {
			const res = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(mergedIntoStack)}/compose`, envId), {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: editorContent })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `Failed to save (${res.status})`);
			}
			toast.success(`Saved to ${mergedIntoStack}`);
			mergedIntoStack = null;
			mergeBaseCompose = '';
			addedLineMarkers = [];
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Save failed');
		} finally {
			merging = false;
		}
	}

	function cancelMerge() {
		mergedIntoStack = null;
		mergeBaseCompose = '';
		addedLineMarkers = [];
		editorContent = onlyUserEnv ? composeUserEnv : composeFullEnv;
		userEdited = false;
		editorRef?.setValue(editorContent);
		afterContentChanged();
	}
</script>

<div class="flex flex-col h-full min-h-0 gap-3">
	{#if loading}
		<div class="flex items-center justify-center py-12 text-muted-foreground">
			<Loader2 class="h-5 w-5 animate-spin mr-2" /> Generating compose...
		</div>
	{:else if loadError}
		<div class="text-sm text-red-500 py-4">{loadError}</div>
	{:else}
		<!-- Part-of-stack banner -->
		{#if stackProject}
			<div class="flex items-center gap-2 text-xs rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
				<Layers class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
				<span>This container already belongs to stack <span class="font-semibold">{stackProject}</span>. The generated compose is a fresh definition you can save separately or merge elsewhere.</span>
			</div>
		{/if}

		<!-- Toolbar -->
		<div class="flex items-center gap-2 flex-wrap">
			<span class="text-xs text-muted-foreground">Environment</span>
			<ToggleSwitch
				value={envMode}
				leftValue="user"
				rightValue="all"
				leftLabel="User-set only"
				rightLabel="All"
				onchange={(v) => { const m = v as 'user' | 'all'; envMode = m; reseedEditor(m); }}
			/>
			<div class="flex-1"></div>
			<Button variant="outline" size="sm" onclick={runValidate} disabled={validateLoading}>
				{#if validateLoading}<Loader2 class="h-3.5 w-3.5 mr-1.5 animate-spin" />{:else}<ShieldCheck class="h-3.5 w-3.5 mr-1.5" />{/if}
				Validate
			</Button>
			<Button variant="outline" size="sm" onclick={doCopy}>
				{#if copied}<Check class="h-3.5 w-3.5 mr-1.5 text-green-500" />{:else}<Copy class="h-3.5 w-3.5 mr-1.5" />{/if}
				Copy
			</Button>
			<Button variant="outline" size="sm" onclick={doDownload}>
				<Download class="h-3.5 w-3.5 mr-1.5" /> Download
			</Button>
			<Button size="sm" variant="outline" onclick={() => (stackModalOpen = true)}>
				<FileCode class="h-3.5 w-3.5 mr-1.5" /> Save as new stack
			</Button>
			<DropdownMenu.Root bind:open={appendMenuOpen} onOpenChange={(o) => o && loadInternalStacks()}>
				<DropdownMenu.Trigger>
					<Button size="sm" variant="outline">
						<ListPlus class="h-3.5 w-3.5 mr-1.5" /> Append to existing <ChevronDown class="h-3.5 w-3.5 ml-1" />
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-64 max-h-72 overflow-auto">
					{#if loadingStacks}
						<div class="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading...</div>
					{:else if existingStacks.length === 0}
						<div class="px-2 py-2 text-xs text-muted-foreground">No internal stacks</div>
					{:else}
						{#each existingStacks as s (s.name)}
							<DropdownMenu.Item
								class="flex items-center gap-2 cursor-pointer"
								onSelect={() => addToExisting(s)}
								disabled={merging}
							>
								<StackIcon icon={s.icon} stackName={s.name} {envId} class="w-4 h-4 shrink-0" />
								<span class="truncate">{s.name}</span>
							</DropdownMenu.Item>
						{/each}
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>

		<!-- Merge review bar -->
		{#if mergedIntoStack}
			<div class="flex items-center gap-2 text-xs rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
				<Info class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
				<span class="flex-1">Reviewing merge into <span class="font-semibold">{mergedIntoStack}</span>. The highlighted service is what will be added.</span>
				<Button variant="ghost" size="sm" onclick={cancelMerge} disabled={merging}>Cancel</Button>
				<Button size="sm" onclick={saveToExisting} disabled={merging}>
					{#if merging}<Loader2 class="h-3.5 w-3.5 mr-1.5 animate-spin" />{:else}<Save class="h-3.5 w-3.5 mr-1.5" />{/if}
					Save to {mergedIntoStack}
				</Button>
			</div>
		{/if}

		<!-- Editor + validate panel -->
		<div class="flex-1 min-h-0 flex gap-3">
			<div class="flex-1 min-h-0 border rounded-md overflow-hidden">
				<CodeEditor
					bind:this={editorRef}
					value={editorContent}
					language="yaml"
					onchange={onEditorChange}
					lintMarkers={validateMarkers}
					{addedLineMarkers}
					onLintClick={jumpToLine}
					class="h-full"
				/>
			</div>
			{#if validatePanelOpen}
				<div class="w-80 shrink-0 min-h-0">
					<ComposeValidatePanel
						report={validateReport}
						loading={validateLoading}
						error={validateError}
						activeLine={validateActiveLine}
						onClose={() => (validatePanelOpen = false)}
						onJumpToLine={jumpToLine}
						onRevalidate={runValidate}
					/>
				</div>
			{/if}
		</div>
	{/if}
</div>

<StackModal
	bind:open={stackModalOpen}
	mode="create"
	initialCompose={editorContent}
	initialStackName={serviceName}
	onClose={() => (stackModalOpen = false)}
	onSuccess={() => {
		stackModalOpen = false;
		toast.success('Stack created');
	}}
/>
