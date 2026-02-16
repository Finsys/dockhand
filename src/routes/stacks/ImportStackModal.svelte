<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Import, Loader2, Play, Info } from 'lucide-svelte';
	import FilesystemBrowser, { type FileEntry } from './FilesystemBrowser.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import yaml from 'js-yaml';
	import { toast } from 'svelte-sonner';
	import { currentEnvironment, environments } from '$lib/stores/environment';
	import { getIconComponent } from '$lib/utils/icons';

	interface DiscoveredStack {
		name: string;
		composePath: string;
		envPath: string | null;
		sourceDir?: string;
		serviceCount?: number;
		running?: boolean;
		containerCount?: number;
	}

	interface Props {
		open: boolean;
		onClose: () => void;
		onAdopted?: () => void;
	}

	let { open = $bindable(), onClose, onAdopted }: Props = $props();

	// View state: 'browse' | 'results'
	let view = $state<'browse' | 'results'>('browse');

	// Reference to filesystem browser
	let filesystemBrowser = $state<{ getCurrentPath: () => string | null; addRecentLocation: (path: string) => Promise<void> } | null>(null);

	// Scan results state
	let scanResults = $state<DiscoveredStack[]>([]);
	let scanning = $state(false);

	// Selection and adopt state
	let stackSelections = $state<Map<string, boolean>>(new Map());
	let adopting = $state(false);

	// Preview dialog state (for single file click)
	let showPreview = $state(false);
	let previewFile = $state<FileEntry | null>(null);
	let previewContent = $state<string | null>(null);
	let previewServiceCount = $state<number>(0);
	let loadingPreview = $state(false);

	// Use current environment from store
	const envId = $derived($currentEnvironment?.id ?? null);
	const envName = $derived($currentEnvironment?.name ?? 'Unknown');
	// Look up the icon from the environments list since currentEnvironment doesn't store it
	const currentEnvData = $derived($environments.find(e => e.id === envId));
	const envIcon = $derived(currentEnvData?.icon || 'globe');
	const EnvIconComponent = $derived(getIconComponent(envIcon));

	// Reset when modal closes
	$effect(() => {
		if (!open) {
			view = 'browse';
			scanResults = [];
			stackSelections = new Map();
			showPreview = false;
			previewFile = null;
			previewContent = null;
			previewServiceCount = 0;
		}
	});

	async function handleFilePreview(entry: FileEntry) {
		previewFile = entry;
		showPreview = true;
		loadingPreview = true;
		previewContent = null;
		previewServiceCount = 0;

		try {
			const res = await fetch(`/api/system/files/content?path=${encodeURIComponent(entry.path)}`);
			if (res.ok) {
				const data = await res.json();
				previewContent = data.content || '';
				// Count services in the compose file
				try {
					const doc = yaml.load(previewContent) as Record<string, unknown> | null;
					if (doc?.services && typeof doc.services === 'object') {
						previewServiceCount = Object.keys(doc.services).length;
					}
				} catch {
					previewServiceCount = 0;
				}
			}
		} catch (e) {
			console.error('Failed to load preview:', e);
		} finally {
			loadingPreview = false;
		}
	}

	function confirmAdoptFromPreview() {
		if (previewFile) {
			adoptSingleFile(previewFile);
			showPreview = false;
		}
	}

	async function handleScanDirectory(path: string) {
		scanning = true;

		try {
			const res = await fetch('/api/stacks/scan', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path })
			});

			const data = await res.json();

			if (!res.ok) {
				toast.error(data.error || 'Failed to scan directory');
				return;
			}

			const discovered: DiscoveredStack[] = data.discovered || [];

			// Detect running stacks on current environment
			if (envId && discovered.length > 0) {
				try {
					const runningRes = await fetch(`/api/stacks?env=${envId}`);
					if (runningRes.ok) {
						const runningStacks: Array<{ name: string; containers?: any[] }> = await runningRes.json();
						const runningMap = new Map(
							runningStacks.map((s) => [s.name.toLowerCase(), s])
						);

						for (const stack of discovered) {
							const runningStack = runningMap.get(stack.name.toLowerCase());
							if (runningStack) {
								stack.running = true;
								stack.containerCount = runningStack.containers?.length || 0;
							}
						}
					}
				} catch (e) {
					console.error('Failed to detect running stacks:', e);
				}
			}

			scanResults = discovered;

			if (discovered.length === 0) {
				toast.info('No compose stacks found in this directory');
			} else {
				const selections = new Map<string, boolean>();
				for (const stack of discovered) {
					// Don't pre-select stacks that are already running on this environment
					selections.set(stack.composePath, !stack.running);
				}
				stackSelections = selections;
				view = 'results';
			}

			await filesystemBrowser?.addRecentLocation(path);

		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to scan directory');
		} finally {
			scanning = false;
		}
	}

	async function adoptSingleFile(entry: FileEntry) {
		if (!envId) {
			toast.error('No environment selected');
			return;
		}

		adopting = true;

		try {
			const parentDir = entry.path.replace(/\/[^/]+$/, '');
			const rawName = parentDir.split('/').pop() || 'adopted-stack';
			const stackName = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'adopted-stack';
			const envFilePath = `${parentDir}/.env`;

			const stack: DiscoveredStack = {
				name: stackName,
				composePath: entry.path,
				envPath: envFilePath,
				sourceDir: parentDir
			};

			const res = await fetch('/api/stacks/adopt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					stacks: [stack],
					environmentId: envId
				})
			});

			const data = await res.json();

			if (!res.ok) {
				toast.error(data.error || 'Failed to adopt stack');
				return;
			}

			if (data.adopted?.length > 0) {
				toast.success(`Adopted stack "${data.adopted[0]}"`);
				await filesystemBrowser?.addRecentLocation(parentDir);
				onAdopted?.();
				handleClose();
			} else if (data.failed?.length > 0) {
				toast.error(`Failed: ${data.failed[0].error}`);
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to adopt');
		} finally {
			adopting = false;
		}
	}

	async function handleAdoptSelected() {
		if (!envId || stackSelections.size === 0) return;

		const selectedStacks = scanResults.filter(s => stackSelections.get(s.composePath));
		if (selectedStacks.length === 0) return;

		adopting = true;

		try {
			const res = await fetch('/api/stacks/adopt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					stacks: selectedStacks,
					environmentId: envId
				})
			});

			const data = await res.json();

			if (!res.ok) {
				toast.error(data.error || 'Failed to adopt stacks');
				return;
			}

			if (data.adopted?.length > 0) {
				toast.success(`Adopted ${data.adopted.length} stack(s)`);
				onAdopted?.();
				handleClose();
			}
			if (data.failed?.length > 0) {
				toast.error(`Failed to adopt ${data.failed.length} stack(s)`);
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to adopt');
		} finally {
			adopting = false;
		}
	}

	function toggleStack(composePath: string) {
		const newMap = new Map(stackSelections);
		newMap.set(composePath, !newMap.get(composePath));
		stackSelections = newMap;
	}

	function toggleAll() {
		const allSelected = scanResults.every(s => stackSelections.get(s.composePath));
		const newMap = new Map<string, boolean>();
		for (const stack of scanResults) {
			newMap.set(stack.composePath, !allSelected);
		}
		stackSelections = newMap;
	}

	function handleClose() {
		open = false;
		onClose();
	}

	function goBackToBrowse() {
		view = 'browse';
		scanResults = [];
		stackSelections = new Map();
	}

	const selectedCount = $derived([...stackSelections.values()].filter(v => v).length);
	const allSelected = $derived(scanResults.length > 0 && scanResults.every(s => stackSelections.get(s.composePath)));

	// Browser title with environment info
	const browserTitle = $derived.by(() => {
		const envPart = envName ? ` · ${envName}` : '';
		return `Adopt stacks${envPart}`;
	});
</script>

{#if view === 'browse'}
	<!-- File Browser View - using FilesystemBrowser component -->
	<FilesystemBrowser
		bind:this={filesystemBrowser}
		bind:open
		title={browserTitle}
		icon={Import}
		description="Browse to a compose file or scan a directory for stacks."
		selectMode="adopt"
		highlightFilter={/\.ya?ml$/i}
		onFilePreview={handleFilePreview}
		onScanDirectory={handleScanDirectory}
		{scanning}
		onSelect={() => {}}
		onClose={handleClose}
	/>
{:else}
	<!-- Scan Results View -->
	<Dialog.Root bind:open onOpenChange={(o) => !o && handleClose()}>
		<Dialog.Content class="max-w-4xl h-[80vh] flex flex-col p-0 gap-0">
			<Dialog.Header class="px-6 py-4 border-b shrink-0">
				<Dialog.Title class="flex items-center gap-2">
					<Import class="w-5 h-5" />
					Select stacks to adopt
					<span class="text-muted-foreground">·</span>
					<EnvIconComponent class="w-4 h-4 text-muted-foreground" />
					<span class="text-muted-foreground font-normal">{envName}</span>
				</Dialog.Title>
				<Dialog.Description>
					{scanResults.length} stack(s) found. Select which ones to adopt into {envName}.
				</Dialog.Description>
			</Dialog.Header>

			<div class="flex-1 flex flex-col min-h-0">
				<!-- Stack list -->
				<div class="flex-1 overflow-y-auto p-4">
					<div class="space-y-2">
						{#each scanResults as stack}
							{@const isSelected = stackSelections.get(stack.composePath)}
							{@const countsMismatch = stack.running && stack.serviceCount && stack.containerCount !== stack.serviceCount}
							<div
								class="flex items-start gap-3 p-3 rounded-lg border {isSelected ? 'border-primary/50 bg-primary/5' : 'border-border'}"
							>
								<Checkbox
									checked={isSelected}
									onCheckedChange={() => toggleStack(stack.composePath)}
									class="mt-0.5"
								/>
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2 flex-wrap">
										<span class="font-medium truncate">{stack.name}</span>
										{#if stack.serviceCount}
											<Badge variant="outline" class="text-xs">
												{stack.serviceCount} service{stack.serviceCount !== 1 ? 's' : ''}
											</Badge>
										{/if}
										{#if stack.running}
											<Badge variant="default" class="text-xs {countsMismatch ? 'bg-amber-600' : 'bg-green-600'}">
												<Play class="w-3 h-3 mr-1" />
												{stack.containerCount} running
											</Badge>
										{/if}
									</div>
									<p class="text-xs text-muted-foreground truncate mt-0.5" title={stack.composePath}>
										{stack.composePath}
									</p>
									{#if stack.envPath}
										<p class="text-xs text-muted-foreground truncate" title={stack.envPath}>
											.env: {stack.envPath}
										</p>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
				<!-- Adopt info -->
				<div class="px-4 py-3 border-t shrink-0">
					<div class="flex items-start gap-2.5 text-xs bg-zinc-100 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2.5">
						<Info class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
						<span><span class="font-medium text-amber-600 dark:text-amber-400">What happens when you adopt:</span> <span class="text-zinc-600 dark:text-zinc-400">Dockhand will track these compose files, letting you edit, start, and stop the stacks from the UI. Your files stay in their current location.</span></span>
					</div>
				</div>
			</div>

			<!-- Footer -->
			<div class="px-6 py-4 border-t flex items-center justify-between shrink-0">
				<div class="flex items-center gap-3">
					<Checkbox
						checked={allSelected}
						onCheckedChange={toggleAll}
					/>
					<span class="text-sm text-muted-foreground">
						<span class="font-medium text-foreground">{selectedCount}</span> of {scanResults.length} selected
					</span>
				</div>
				<div class="flex gap-2">
					<Button variant="outline" onclick={goBackToBrowse}>
						Back
					</Button>
					<Button variant="outline" onclick={handleClose}>
						Cancel
					</Button>
					<Button
						variant="default"
						onclick={handleAdoptSelected}
						disabled={adopting || selectedCount === 0}
					>
						{#if adopting}
							<Loader2 class="w-4 h-4 mr-2 animate-spin" />
							Adopting...
						{:else}
							<Import class="w-4 h-4" />
							Adopt {selectedCount} stack(s)
						{/if}
					</Button>
				</div>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/if}

<!-- Preview dialog for single file adopt -->
<Dialog.Root bind:open={showPreview}>
	<Dialog.Content class="max-w-3xl h-[70vh] flex flex-col p-0 gap-0">
		<Dialog.Header class="px-5 py-4 border-b shrink-0">
			<Dialog.Title class="flex items-center gap-2">
				<Import class="w-5 h-5" />
				Adopt this stack?
			</Dialog.Title>
			<Dialog.Description>
				Review the compose file before adopting.
			</Dialog.Description>
		</Dialog.Header>

		{#if previewFile}
			<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
				<!-- Stack info bar -->
				<div class="px-5 py-3 border-b bg-muted/30 flex items-center gap-4 shrink-0">
					<div class="flex items-center gap-2">
						<span class="text-sm text-muted-foreground">Stack:</span>
						<span class="font-medium">{previewFile.path.replace(/\/[^/]+$/, '').split('/').pop() || 'unknown'}</span>
						{#if previewServiceCount > 0}
							<Badge variant="outline" class="text-xs">
								{previewServiceCount} service{previewServiceCount !== 1 ? 's' : ''}
							</Badge>
						{/if}
					</div>
					<div class="flex-1 min-w-0">
						<code class="text-xs bg-muted px-2 py-1 rounded truncate block">{previewFile.path}</code>
					</div>
				</div>

				<!-- Preview content with syntax highlighting -->
				<div class="flex-1 min-h-0 p-3">
					{#if loadingPreview}
						<div class="flex items-center justify-center h-full">
							<Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
						</div>
					{:else if previewContent}
						<CodeEditor
							value={previewContent}
							language="yaml"
							theme="dark"
							readonly={true}
							class="h-full rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700"
						/>
					{/if}
				</div>

				<!-- Adopt info -->
				<div class="px-5 py-3 border-t shrink-0">
					<div class="flex items-start gap-2.5 text-xs bg-zinc-100 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2.5">
						<Info class="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
						<span><span class="font-medium text-amber-600 dark:text-amber-400">What happens when you adopt:</span> <span class="text-zinc-600 dark:text-zinc-400">Dockhand will track this compose file, letting you edit, start, and stop the stack from the UI. Your files stay in their current location.</span></span>
					</div>
				</div>
			</div>
		{/if}

		<div class="px-5 py-3 border-t flex justify-end gap-2 shrink-0">
			<Button variant="outline" onclick={() => showPreview = false}>
				Cancel
			</Button>
			<Button onclick={confirmAdoptFromPreview} disabled={adopting}>
				{#if adopting}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
					Adopting...
				{:else}
					<Import class="w-4 h-4" />
					Adopt stack
				{/if}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
