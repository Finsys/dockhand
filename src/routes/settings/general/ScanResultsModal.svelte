<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { Search, FolderOpen, CheckCircle2, SkipForward, AlertCircle, FileText, Import, Loader2, Play, HelpCircle } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { toast } from 'svelte-sonner';
	import { onMount } from 'svelte';
	import { getIconComponent } from '$lib/utils/icons';

	interface RunningStackInfo {
		envId: number;
		envName: string;
		containerCount: number;
	}

	interface DiscoveredStack {
		name: string;
		composePath: string;
		envPath: string | null;
		sourceDir?: string;
		runningOn?: RunningStackInfo[];
	}

	interface AdoptedStack {
		name: string;
		envId: number;
	}

	interface ScanResult {
		adopted: string[];
		skipped: DiscoveredStack[];
		errors: { path: string; error: string }[];
		discovered: DiscoveredStack[];
	}

	interface Environment {
		id: number;
		name: string;
		icon: string;
	}

	interface Props {
		open: boolean;
		result: ScanResult | null;
		scannedPaths: string[];
		onclose: () => void;
		onAdopted?: () => void; // Callback when stacks are adopted
	}

	let { open = $bindable(), result, scannedPaths, onclose, onAdopted }: Props = $props();

	// Selection state - maps composePath to environmentId
	let stackSelections = $state<Map<string, number>>(new Map());
	let adopting = $state(false);

	// Track adopted stacks with their environment (for display)
	let adoptedStacks = $state<AdoptedStack[]>([]);

	// Environment state
	let environments = $state<Environment[]>([]);
	let defaultEnvId = $state<number | null>(null);
	let loadingEnvs = $state(true);

	// Load environments on mount
	onMount(async () => {
		try {
			const response = await fetch('/api/environments');
			if (response.ok) {
				environments = await response.json();
				// Default to first environment
				if (environments.length > 0) {
					defaultEnvId = environments[0].id;
				}
			}
		} catch (err) {
			console.error('Failed to load environments:', err);
		} finally {
			loadingEnvs = false;
		}
	});

	// Track if we've initialized selections for this modal session
	let hasInitialized = $state(false);

	// Reset selection when modal opens with new results (only on initial open)
	$effect(() => {
		if (open && result && defaultEnvId !== null && !hasInitialized) {
			// Pre-select all discovered stacks
			// Auto-select the environment where stack is already running, otherwise use default
			const newSelections = new Map<string, number>();
			for (const stack of result.discovered) {
				const runningEnvId = stack.runningOn?.[0]?.envId;
				newSelections.set(stack.composePath, runningEnvId ?? defaultEnvId);
			}
			stackSelections = newSelections;
			hasInitialized = true;
		}
		// Reset tracker when modal closes
		if (!open) {
			hasInitialized = false;
			adoptedStacks = [];
		}
	});

	const selectedCount = $derived(stackSelections.size);

	const allSelected = $derived(
		result?.discovered.length > 0 &&
		stackSelections.size === result.discovered.length
	);

	const someSelected = $derived(
		stackSelections.size > 0 &&
		result?.discovered.length > 0 &&
		stackSelections.size < result.discovered.length
	);

	const defaultEnv = $derived(environments.find(e => e.id === defaultEnvId));
	const defaultEnvName = $derived(defaultEnv?.name || 'Select environment');
	const DefaultEnvIcon = $derived(defaultEnv ? getIconComponent(defaultEnv.icon || 'globe') : null);

	function isSelected(composePath: string): boolean {
		return stackSelections.has(composePath);
	}

	function getStackEnvId(composePath: string): number | null {
		return stackSelections.get(composePath) ?? null;
	}

	function getStackEnv(composePath: string): Environment | null {
		const envId = stackSelections.get(composePath);
		return envId ? environments.find(e => e.id === envId) ?? null : null;
	}

	function toggleStack(composePath: string) {
		const newMap = new Map(stackSelections);
		if (newMap.has(composePath)) {
			newMap.delete(composePath);
		} else if (defaultEnvId !== null) {
			newMap.set(composePath, defaultEnvId);
		}
		stackSelections = newMap;
	}

	function setStackEnv(composePath: string, envId: number) {
		const newMap = new Map(stackSelections);
		newMap.set(composePath, envId);
		stackSelections = newMap;
	}

	function toggleAll() {
		if (!result || defaultEnvId === null) return;

		if (allSelected) {
			stackSelections = new Map();
		} else {
			const newSelections = new Map<string, number>();
			for (const stack of result.discovered) {
				// Preserve existing env selection or use default
				const existingEnv = stackSelections.get(stack.composePath);
				newSelections.set(stack.composePath, existingEnv ?? defaultEnvId);
			}
			stackSelections = newSelections;
		}
	}

	function applyDefaultEnvToAll() {
		if (!result || defaultEnvId === null) return;
		const newMap = new Map<string, number>();
		for (const [path] of stackSelections) {
			newMap.set(path, defaultEnvId);
		}
		stackSelections = newMap;
	}

	async function handleAdopt() {
		if (!result || stackSelections.size === 0) return;

		// Group stacks by environment
		const stacksByEnv = new Map<number, DiscoveredStack[]>();
		for (const [composePath, envId] of stackSelections) {
			const stack = result.discovered.find(d => d.composePath === composePath);
			if (stack) {
				if (!stacksByEnv.has(envId)) {
					stacksByEnv.set(envId, []);
				}
				stacksByEnv.get(envId)!.push(stack);
			}
		}

		adopting = true;
		let totalAdopted: AdoptedStack[] = [];
		let totalFailed: { name: string; error: string }[] = [];

		try {
			// Adopt each group to its environment
			for (const [envId, stacks] of stacksByEnv) {
				const response = await fetch('/api/stacks/adopt', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						stacks,
						environmentId: envId
					})
				});

				const data = await response.json();

				if (!response.ok) {
					// Add all stacks in this batch as failed
					for (const stack of stacks) {
						totalFailed.push({ name: stack.name, error: data.error || 'Failed to adopt' });
					}
				} else {
					// Track adopted stacks with their environment
					for (const name of (data.adopted || [])) {
						totalAdopted.push({ name, envId });
					}
					totalFailed.push(...(data.failed || []));
				}
			}

			if (totalAdopted.length > 0) {
				toast.success(`Adopted ${totalAdopted.length} stack(s)`);
			}
			if (totalFailed.length > 0) {
				toast.error(`Failed to adopt ${totalFailed.length} stack(s)`);
			}

			// Update the result to reflect adopted stacks
			const adoptedNames = new Set(totalAdopted.map(s => s.name));
			const adoptedPaths = new Set(
				result.discovered
					.filter(d => stackSelections.has(d.composePath) && adoptedNames.has(d.name))
					.map(d => d.composePath)
			);

			// Add to local adopted stacks list (with env info)
			adoptedStacks = [...adoptedStacks, ...totalAdopted];

			result = {
				...result,
				adopted: [...result.adopted, ...totalAdopted.map(s => s.name)],
				discovered: result.discovered.filter(d => !adoptedPaths.has(d.composePath))
			};

			// Clear selections for adopted stacks
			const newSelections = new Map(stackSelections);
			for (const path of adoptedPaths) {
				newSelections.delete(path);
			}
			stackSelections = newSelections;

			// Notify parent of adoption
			onAdopted?.();

		} catch (err) {
			toast.error('Failed to adopt stacks');
		} finally {
			adopting = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => !isOpen && onclose()}>
	<Dialog.Content class="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Search class="w-5 h-5" />
				External stack scan results
			</Dialog.Title>
			<Dialog.Description>
				Scanned {scannedPaths.length} configured path{scannedPaths.length !== 1 ? 's' : ''} for Docker Compose files
			</Dialog.Description>
		</Dialog.Header>

		{#if result}
			<!-- Sticky header with summary and environment selector -->
			<div class="space-y-3 py-2 border-b bg-background">
				<!-- Summary -->
				<div class="flex items-center gap-4 p-3 rounded-lg bg-muted/50">
					<div class="flex items-center gap-2">
						<FolderOpen class="w-4 h-4 text-muted-foreground" />
						<span class="text-sm font-medium">{result.discovered.length + result.skipped.length + adoptedStacks.length} found</span>
					</div>
					{#if result.discovered.length > 0}
						<div class="flex items-center gap-1.5 text-blue-600 dark:text-blue-500">
							<Import class="w-4 h-4" />
							<span class="text-sm">{result.discovered.length} new</span>
						</div>
					{/if}
					{#if adoptedStacks.length > 0}
						<div class="flex items-center gap-1.5 text-green-600 dark:text-green-500">
							<CheckCircle2 class="w-4 h-4" />
							<span class="text-sm">{adoptedStacks.length} adopted</span>
						</div>
					{/if}
					{#if result.skipped.length > 0}
						<div class="flex items-center gap-1.5 text-muted-foreground">
							<SkipForward class="w-4 h-4" />
							<span class="text-sm">{result.skipped.length} already adopted</span>
						</div>
					{/if}
					{#if result.errors.length > 0}
						<div class="flex items-center gap-1.5 text-destructive">
							<AlertCircle class="w-4 h-4" />
							<span class="text-sm">{result.errors.length} errors</span>
						</div>
					{/if}
				</div>

				<!-- Default environment selector (apply to all) - only show when multiple environments -->
				{#if result.discovered.length > 0}
					{#if loadingEnvs}
						<div class="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
							<Label class="text-sm font-medium shrink-0">Adopt to:</Label>
							<div class="flex items-center gap-2 text-muted-foreground">
								<Loader2 class="w-4 h-4 animate-spin" />
								<span class="text-sm">Loading...</span>
							</div>
						</div>
					{:else if environments.length === 0}
						<div class="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
							<p class="text-sm text-destructive">No environments configured</p>
						</div>
					{:else if environments.length > 1}
						<div class="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
							<Label class="text-sm font-medium shrink-0">Adopt to:</Label>
							<Select.Root
								type="single"
								value={defaultEnvId?.toString()}
								onValueChange={(v) => {
									defaultEnvId = v ? parseInt(v) : null;
								}}
							>
								<Select.Trigger class="w-[220px]">
									{#if DefaultEnvIcon}
										<DefaultEnvIcon class="w-4 h-4 mr-2 shrink-0" />
									{/if}
									<span class="truncate">{defaultEnvName}</span>
								</Select.Trigger>
								<Select.Content>
									{#each environments as env}
										{@const EnvIcon = getIconComponent(env.icon || 'globe')}
										<Select.Item value={env.id.toString()}>
											<div class="flex items-center gap-2">
												<EnvIcon class="w-4 h-4 shrink-0" />
												<span>{env.name}</span>
											</div>
										</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
							<Button variant="outline" size="sm" onclick={applyDefaultEnvToAll} disabled={stackSelections.size === 0}>
								Apply to all
							</Button>
						</div>
					{/if}
				{/if}
			</div>

			<!-- Scrollable content -->
			<div class="flex-1 overflow-y-auto space-y-4 py-2">
				<!-- Discovered stacks (available for import) -->
				{#if result.discovered.length > 0}
					<div class="space-y-2">
						<div class="flex items-center justify-between">
							<h4 class="text-sm font-medium flex items-center gap-2 text-blue-600 dark:text-blue-500">
								<Import class="w-4 h-4" />
								Available for adoption
							</h4>
							<button
								type="button"
								class="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
								onclick={toggleAll}
							>
								<Checkbox checked={allSelected} indeterminate={someSelected} />
								<span>{allSelected ? 'Deselect all' : 'Select all'}</span>
							</button>
						</div>
						<div class="space-y-1.5">
							{#each result.discovered as stack}
								{@const stackEnvId = getStackEnvId(stack.composePath)}
								{@const stackEnv = stackEnvId ? environments.find(e => e.id === stackEnvId) : null}
								<div
									class="flex items-start gap-3 p-2 rounded-md border transition-colors
										{isSelected(stack.composePath)
											? 'bg-blue-500/10 border-blue-500/30'
											: 'bg-muted/30 border-transparent hover:bg-muted/50'}"
								>
									<button
										type="button"
										class="pt-0.5 shrink-0"
										onclick={() => toggleStack(stack.composePath)}
									>
										<Checkbox checked={isSelected(stack.composePath)} />
									</button>
									<button
										type="button"
										class="flex-1 min-w-0 text-left"
										onclick={() => toggleStack(stack.composePath)}
									>
										<div class="flex items-center gap-2 flex-wrap">
											<p class="text-sm font-medium">{stack.name}</p>
											{#if stack.runningOn && stack.runningOn.length > 0}
												<Badge variant="outline" class="text-xs text-green-600 dark:text-green-500 border-green-300 dark:border-green-600 gap-1">
													<Play class="w-3 h-3" />
													Running on {stack.runningOn.map(r => r.envName).join(', ')}
													<Tooltip.Root>
														<Tooltip.Trigger>
															<HelpCircle class="w-3 h-3 opacity-60" />
														</Tooltip.Trigger>
														<Tooltip.Content class="max-w-sm">
															<p class="text-xs">This stack is already running (detected via Docker's <code class="bg-muted px-1 rounded">com.docker.compose.project</code> label). Adopting will allow you to manage it through Dockhand.</p>
														</Tooltip.Content>
													</Tooltip.Root>
												</Badge>
											{/if}
										</div>
										<code class="text-xs text-muted-foreground block truncate" title={stack.composePath}>{stack.composePath}</code>
										{#if stack.envPath}
											<p class="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
												<FileText class="w-3 h-3" />
												.env file detected
											</p>
										{/if}
									</button>
									<!-- Per-stack environment selector - only show when multiple environments -->
									{#if isSelected(stack.composePath) && environments.length > 1}
										<div class="shrink-0 flex items-center gap-2" onclick={(e) => e.stopPropagation()}>
											<!-- Note if importing to different environment than running -->
											{#if stack.runningOn && stack.runningOn.length > 0 && !stack.runningOn.some(r => r.envId === stackEnvId)}
												<Badge variant="outline" class="text-xs text-amber-600 dark:text-amber-500 border-amber-300 dark:border-amber-600 gap-1">
													Running elsewhere
													<Tooltip.Root>
														<Tooltip.Trigger>
															<HelpCircle class="w-3 h-3 opacity-60" />
														</Tooltip.Trigger>
														<Tooltip.Content class="max-w-sm">
															<p class="text-xs">This stack is running on a different environment ({stack.runningOn?.map(r => r.envName).join(', ')}). You can still adopt it here, but it won't affect the running containers.</p>
														</Tooltip.Content>
													</Tooltip.Root>
												</Badge>
											{/if}
											<Select.Root
												type="single"
												value={stackEnvId?.toString() || ''}
												onValueChange={(v) => {
													if (v) setStackEnv(stack.composePath, parseInt(v));
												}}
											>
												<Select.Trigger class="h-8 w-[220px] text-xs">
													{#if getStackEnv(stack.composePath)}
														{@const StackIcon = getIconComponent(getStackEnv(stack.composePath)?.icon || 'globe')}
														<StackIcon class="w-3.5 h-3.5 mr-1.5 shrink-0" />
													{/if}
													<span class="truncate">{getStackEnv(stack.composePath)?.name || 'Select'}</span>
												</Select.Trigger>
												<Select.Content>
													{#each environments as env}
														{@const EnvIcon = getIconComponent(env.icon || 'globe')}
														<Select.Item value={env.id.toString()}>
															<div class="flex items-center gap-2">
																<EnvIcon class="w-3.5 h-3.5 shrink-0" />
																<span>{env.name}</span>
															</div>
														</Select.Item>
													{/each}
												</Select.Content>
											</Select.Root>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Adopted stacks (just adopted in this session) -->
				{#if adoptedStacks.length > 0}
					<div class="space-y-2">
						<h4 class="text-sm font-medium flex items-center gap-2 text-green-600 dark:text-green-500">
							<CheckCircle2 class="w-4 h-4" />
							Adopted stacks
						</h4>
						<div class="space-y-1.5">
							{#each adoptedStacks as adopted}
								{@const env = environments.find(e => e.id === adopted.envId)}
								{@const EnvIcon = env ? getIconComponent(env.icon || 'globe') : null}
								<div class="flex items-center gap-2 p-2 rounded-md bg-green-500/10 border border-green-500/20">
									<CheckCircle2 class="w-4 h-4 text-green-600 dark:text-green-500 shrink-0" />
									<p class="text-sm font-medium flex-1">{adopted.name}</p>
									{#if env}
										<div class="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
											{#if EnvIcon}
												<EnvIcon class="w-3.5 h-3.5" />
											{/if}
											<span>{env.name}</span>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Skipped stacks (already adopted) -->
				{#if result.skipped.length > 0}
					<div class="space-y-2">
						<h4 class="text-sm font-medium flex items-center gap-2 text-muted-foreground">
							<SkipForward class="w-4 h-4" />
							Already adopted
						</h4>
						<div class="space-y-1.5">
							{#each result.skipped as stack}
								<div class="flex items-start gap-2 p-2 rounded-md bg-muted/50">
									<SkipForward class="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
									<div class="flex-1 min-w-0">
										<p class="text-sm font-medium">{stack.name}</p>
										<code class="text-xs text-muted-foreground block truncate" title={stack.composePath}>{stack.composePath}</code>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Errors -->
				{#if result.errors.length > 0}
					<div class="space-y-2">
						<h4 class="text-sm font-medium flex items-center gap-2 text-destructive">
							<AlertCircle class="w-4 h-4" />
							Errors
						</h4>
						<div class="space-y-1.5">
							{#each result.errors as error}
								<div class="flex items-start gap-2 p-2 rounded-md bg-destructive/10 border border-destructive/20">
									<AlertCircle class="w-4 h-4 text-destructive shrink-0 mt-0.5" />
									<div class="flex-1 min-w-0">
										<code class="text-xs block truncate" title={error.path}>{error.path}</code>
										<p class="text-xs text-destructive">{error.error}</p>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- No results message -->
				{#if result.discovered.length === 0 && result.skipped.length === 0 && result.adopted.length === 0 && result.errors.length === 0}
					<div class="text-center py-8 text-muted-foreground">
						<FolderOpen class="w-12 h-12 mx-auto mb-3 opacity-50" />
						<p class="text-sm">No Docker Compose files found in the configured paths.</p>
						<p class="text-xs mt-1">Make sure your paths contain compose.yaml, compose.yml, or similar files.</p>
					</div>
				{/if}

				<!-- Scanned paths -->
				<div class="space-y-2 pt-2 border-t">
					<h4 class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Scanned paths</h4>
					<div class="space-y-1">
						{#each scannedPaths as path}
							<code class="text-xs text-muted-foreground block">{path}</code>
						{/each}
					</div>
				</div>
			</div>
		{/if}

		<Dialog.Footer class="flex items-center justify-between">
			<div class="text-xs text-muted-foreground">
				{#if selectedCount > 0}
					{selectedCount} stack{selectedCount !== 1 ? 's' : ''} selected
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<Button variant="outline" onclick={() => { open = false; onclose(); }}>Close</Button>
				{#if result && result.discovered.length > 0}
					<Button
						onclick={handleAdopt}
						disabled={selectedCount === 0 || adopting}
					>
						{#if adopting}
							<Loader2 class="w-4 h-4 mr-2 animate-spin" />
							Adopting...
						{:else}
							<Import class="w-4 h-4" />
							Adopt selected
						{/if}
					</Button>
				{:else if adoptedStacks.length > 0}
					<Button href="/stacks">View stacks</Button>
				{/if}
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
