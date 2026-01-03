<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Loader2, GitBranch, RefreshCw, Webhook, Rocket, RefreshCcw, Copy, Check, FolderGit2, Github, Key, KeyRound, Lock, FileText, HelpCircle, GripVertical, X } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import StackEnvVarsPanel from '$lib/components/StackEnvVarsPanel.svelte';
	import { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import { toast } from 'svelte-sonner';
	import { focusFirstInput } from '$lib/utils';
	import { useSidebar } from '$lib/components/ui/sidebar/context.svelte';

	// Get sidebar state to adjust modal positioning
	const sidebar = useSidebar();

	// localStorage key for persisted split ratio
	const STORAGE_KEY_SPLIT = 'dockhand-git-stack-modal-split';

	interface GitCredential {
		id: number;
		name: string;
		authType: string;
	}

	function getAuthLabel(authType: string) {
		switch (authType) {
			case 'ssh': return 'SSH Key';
			case 'password': return 'Password';
			default: return 'None';
		}
	}

	interface GitRepository {
		id: number;
		name: string;
		url: string;
		branch: string;
		credential_id: number | null;
	}

	interface GitStack {
		id: number;
		stackName: string;
		repositoryId: number;
		composePath: string;
		envFilePath: string | null;
		autoUpdate: boolean;
		autoUpdateSchedule: 'daily' | 'weekly' | 'custom';
		autoUpdateCron: string;
		webhookEnabled: boolean;
		webhookSecret: string | null;
	}

	interface Props {
		open: boolean;
		gitStack?: GitStack | null;
		environmentId?: number | null;
		repositories: GitRepository[];
		credentials: GitCredential[];
		onClose: () => void;
		onSaved: () => void;
	}

	let { open = $bindable(), gitStack = null, environmentId = null, repositories, credentials, onClose, onSaved }: Props = $props();

	// Form state - repository selection or creation
	let formRepoMode = $state<'existing' | 'new'>('existing');
	let formRepositoryId = $state<number | null>(null);
	let formNewRepoName = $state('');
	let formNewRepoUrl = $state('');
	let formNewRepoBranch = $state('main');
	let formNewRepoCredentialId = $state<number | null>(null);

	// Form state - stack deployment config
	let formStackName = $state('');
	let formStackNameUserModified = $state(false);
	let formComposePath = $state('docker-compose.yml');
	let formAutoUpdate = $state(false);
	let formAutoUpdateCron = $state('0 3 * * *');
	let formWebhookEnabled = $state(false);
	let formWebhookSecret = $state('');
	let formDeployNow = $state(false);
	let formError = $state('');
	let formSaving = $state(false);
	let errors = $state<{ stackName?: string; repository?: string; repoName?: string; repoUrl?: string }>({});
	let copiedWebhookUrl = $state(false);
	let copiedWebhookSecret = $state(false);

	// Environment variables state
	let formEnvFilePath = $state<string | null>(null);
	let envFiles = $state<string[]>([]);
	let loadingEnvFiles = $state(false);
	let envVars = $state<EnvVar[]>([]);
	let fileEnvVars = $state<Record<string, string>>({});
	let loadingFileVars = $state(false);
	let existingSecretKeys = $state<Set<string>>(new Set());

	// Resizable split panel state
	let splitRatio = $state(60); // percentage for form panel
	let isDraggingSplit = $state(false);
	let containerRef: HTMLDivElement | null = $state(null);

	// Derived state for merged variables and sources
	const envVarSources = $derived<Record<string, 'file' | 'override'>>(() => {
		const sources: Record<string, 'file' | 'override'> = {};
		// File vars
		for (const key of Object.keys(fileEnvVars)) {
			sources[key] = 'file';
		}
		// Overrides take precedence
		for (const v of envVars.filter(v => v.key)) {
			sources[v.key] = 'override';
		}
		return sources;
	});

	// Track which gitStack was initialized to avoid repeated resets
	let lastInitializedStackId = $state<number | null | undefined>(undefined);

	$effect(() => {
		if (open) {
			const currentStackId = gitStack?.id ?? null;
			if (lastInitializedStackId !== currentStackId) {
				lastInitializedStackId = currentStackId;
				resetForm();
			}
		} else {
			lastInitializedStackId = undefined;
		}
	});

	// Derived state for selected repository
	let selectedRepo = $derived(formRepositoryId ? repositories.find(r => r.id === formRepositoryId) : null);

	onMount(() => {
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

	function generateWebhookSecret(): string {
		const array = new Uint8Array(24);
		crypto.getRandomValues(array);
		return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
	}

	function getWebhookUrl(stackId: number): string {
		return `${window.location.origin}/api/git/stacks/${stackId}/webhook`;
	}

	async function copyToClipboard(text: string, type: 'url' | 'secret') {
		await navigator.clipboard.writeText(text);
		if (type === 'url') {
			copiedWebhookUrl = true;
			setTimeout(() => copiedWebhookUrl = false, 2000);
		} else {
			copiedWebhookSecret = true;
			setTimeout(() => copiedWebhookSecret = false, 2000);
		}
	}

	async function loadEnvFiles() {
		if (!gitStack) return;

		loadingEnvFiles = true;
		try {
			const response = await fetch(`/api/git/stacks/${gitStack.id}/env-files`);
			if (response.ok) {
				const data = await response.json();
				envFiles = data.files || [];
			}
		} catch (e) {
			console.error('Failed to load env files:', e);
		} finally {
			loadingEnvFiles = false;
		}
	}

	async function loadEnvFileContents(path: string) {
		if (!gitStack || !path) {
			fileEnvVars = {};
			return;
		}

		loadingFileVars = true;
		try {
			const response = await fetch(`/api/git/stacks/${gitStack.id}/env-files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path })
			});
			if (response.ok) {
				const data = await response.json();
				fileEnvVars = data.vars || {};
			}
		} catch (e) {
			console.error('Failed to load env file contents:', e);
			fileEnvVars = {};
		} finally {
			loadingFileVars = false;
		}
	}

	async function loadEnvVarsOverrides() {
		if (!gitStack) return;

		try {
			const response = await fetch(`/api/stacks/${encodeURIComponent(gitStack.stackName)}/env${environmentId ? `?env=${environmentId}` : ''}`);
			if (response.ok) {
				const data = await response.json();
				envVars = data.variables || [];
				// Track existing secret keys (secrets loaded from DB cannot have visibility toggled)
				existingSecretKeys = new Set(
					envVars.filter(v => v.isSecret && v.key.trim()).map(v => v.key.trim())
				);
			}
		} catch (e) {
			console.error('Failed to load env var overrides:', e);
		}
	}

	function resetForm() {
		if (gitStack) {
			formRepoMode = 'existing';
			formRepositoryId = gitStack.repositoryId;
			formStackName = gitStack.stackName;
			formComposePath = gitStack.composePath;
			formEnvFilePath = gitStack.envFilePath;
			formAutoUpdate = gitStack.autoUpdate;
			formAutoUpdateCron = gitStack.autoUpdateCron || '0 3 * * *';
			formWebhookEnabled = gitStack.webhookEnabled;
			formWebhookSecret = gitStack.webhookSecret || '';
			formDeployNow = false;
			// Load env files and overrides for editing
			loadEnvFiles();
			loadEnvVarsOverrides();
			if (gitStack.envFilePath) {
				loadEnvFileContents(gitStack.envFilePath);
			}
		} else {
			formRepoMode = repositories.length > 0 ? 'existing' : 'new';
			formRepositoryId = null;
			formNewRepoName = '';
			formNewRepoUrl = '';
			formNewRepoBranch = 'main';
			formNewRepoCredentialId = null;
			formStackName = '';
			formStackNameUserModified = false;
			formComposePath = 'docker-compose.yml';
			formEnvFilePath = null;
			formAutoUpdate = false;
			formAutoUpdateCron = '0 3 * * *';
			formWebhookEnabled = false;
			formWebhookSecret = '';
			formDeployNow = false;
		}
		formError = '';
		errors = {};
		copiedWebhookUrl = false;
		copiedWebhookSecret = false;
		envFiles = [];
		envVars = [];
		fileEnvVars = {};
		existingSecretKeys = new Set();
	}

	async function saveGitStack(deployAfterSave: boolean = false) {
		errors = {};
		let hasErrors = false;

		if (!formStackName.trim()) {
			errors.stackName = 'Stack name is required';
			hasErrors = true;
		}

		if (formRepoMode === 'existing' && !formRepositoryId) {
			errors.repository = 'Please select a repository';
			hasErrors = true;
		}

		if (formRepoMode === 'new' && !formNewRepoName.trim()) {
			errors.repoName = 'Repository name is required';
			hasErrors = true;
		}

		if (formRepoMode === 'new' && !formNewRepoUrl.trim()) {
			errors.repoUrl = 'Repository URL is required';
			hasErrors = true;
		}

		if (hasErrors) return;

		formSaving = true;
		formError = '';

		try {
			let body: any = {
				stackName: formStackName,
				composePath: formComposePath || 'docker-compose.yml',
				envFilePath: formEnvFilePath,
				environmentId: environmentId,
				autoUpdate: formAutoUpdate,
				autoUpdateCron: formAutoUpdateCron,
				webhookEnabled: formWebhookEnabled,
				webhookSecret: formWebhookEnabled ? formWebhookSecret : null,
				deployNow: deployAfterSave
			};

			if (formRepoMode === 'existing') {
				body.repositoryId = formRepositoryId;
			} else {
				// Create new repo inline
				body.repoName = formNewRepoName;
				body.url = formNewRepoUrl;
				body.branch = formNewRepoBranch || 'main';
				body.credentialId = formNewRepoCredentialId;
			}

			const url = gitStack
				? `/api/git/stacks/${gitStack.id}`
				: '/api/git/stacks';
			const method = gitStack ? 'PUT' : 'POST';

			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			const data = await response.json();

			if (!response.ok) {
				formError = data.error || 'Failed to save git stack';
				return;
			}

			// Check if deployment failed
			if (data.deployResult && !data.deployResult.success) {
				toast.error('Deployment failed', {
					description: data.deployResult.error || 'Unknown error'
				});
				onSaved(); // Still refresh the list to show the new stack
				onClose(); // Close modal, error shown as toast
				return;
			}

			// Save environment variable overrides if we have any
			const definedVars = envVars.filter(v => v.key.trim());
			if (definedVars.length > 0) {
				try {
					const envResponse = await fetch(
						`/api/stacks/${encodeURIComponent(formStackName)}/env${environmentId ? `?env=${environmentId}` : ''}`,
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
						console.error('Failed to save environment variables');
					}
				} catch (e) {
					console.error('Failed to save environment variables:', e);
				}
			}

			onSaved();
			onClose();
		} catch (error) {
			formError = 'Failed to save git stack';
		} finally {
			formSaving = false;
		}
	}

	// Auto-populate stack name from selected repo and compose path (only if user hasn't manually edited)
	$effect(() => {
		if (formRepoMode === 'existing' && formRepositoryId && !gitStack && !formStackNameUserModified) {
			const repo = repositories.find(r => r.id === formRepositoryId);
			if (repo) {
				// Extract compose filename without extension for stack name
				const composeName = formComposePath
					.replace(/^.*\//, '') // Remove directory path
					.replace(/\.(yml|yaml)$/i, '') // Remove extension
					.replace(/^docker-compose\.?/, ''); // Remove docker-compose prefix

				// Combine repo name with compose name if it's not the default
				if (composeName && composeName !== 'docker-compose') {
					formStackName = `${repo.name}-${composeName}`;
				} else {
					formStackName = repo.name;
				}
			}
		}
	});
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (isOpen) focusFirstInput(); }}>
	<Dialog.Content
		class="max-w-none h-[95vh] flex flex-col p-0 gap-0 shadow-xl border-zinc-200 dark:border-zinc-700 {sidebar.state === 'collapsed' ? 'w-[calc(100vw-6rem)] ml-[1.5rem]' : 'w-[calc(100vw-12rem)] ml-[4.5rem]'}"
		showCloseButton={false}
	>
		<Dialog.Header class="px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<div class="p-1.5 rounded-md bg-zinc-200 dark:bg-zinc-700">
						<GitBranch class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
					</div>
					<div>
						<Dialog.Title class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
							{gitStack ? 'Edit git stack' : 'Deploy from Git'}
						</Dialog.Title>
						<Dialog.Description class="text-xs text-zinc-500 dark:text-zinc-400">
							{gitStack ? 'Update git stack settings' : 'Deploy a compose stack from a Git repository'}
						</Dialog.Description>
					</div>
				</div>

				<!-- Close button -->
				<button
					onclick={onClose}
					class="p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
				>
					<X class="w-4 h-4" />
				</button>
			</div>
		</Dialog.Header>

		<div bind:this={containerRef} class="flex-1 min-h-0 flex {isDraggingSplit ? 'select-none' : ''}">
			<!-- Left column: Form fields -->
			<div class="flex-shrink-0 flex flex-col min-w-0 overflow-y-auto" style="width: {splitRatio}%">
				<div class="space-y-4 py-4 px-6">
			<!-- Repository selection -->
			{#if !gitStack}
				<div class="space-y-3">
					<Label>Repository</Label>
					<div class="flex gap-2">
						<Button
							variant={formRepoMode === 'existing' ? 'default' : 'outline'}
							size="sm"
							onclick={() => formRepoMode = 'existing'}
							disabled={repositories.length === 0}
						>
							Select existing
						</Button>
						<Button
							variant={formRepoMode === 'new' ? 'default' : 'outline'}
							size="sm"
							onclick={() => formRepoMode = 'new'}
						>
							Add new
						</Button>
					</div>

					{#if formRepoMode === 'existing'}
						<Select.Root
							type="single"
							value={formRepositoryId?.toString() ?? ''}
							onValueChange={(v) => { formRepositoryId = v ? parseInt(v) : null; errors.repository = undefined; }}
						>
							<Select.Trigger class="w-full {errors.repository ? 'border-destructive' : ''}">
								{#if selectedRepo}
									{@const repoPath = selectedRepo.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '')}
									<div class="flex items-center gap-2 text-left">
										{#if selectedRepo.url.includes('github.com')}
											<Github class="w-4 h-4 shrink-0 text-muted-foreground" />
										{:else}
											<FolderGit2 class="w-4 h-4 shrink-0 text-muted-foreground" />
										{/if}
										<span class="truncate">{selectedRepo.name}</span>
										<span class="text-muted-foreground text-xs truncate hidden sm:inline">({repoPath})</span>
									</div>
								{:else}
									<span class="text-muted-foreground">Select a repository...</span>
								{/if}
							</Select.Trigger>
							<Select.Content>
								{#each repositories as repo}
									{@const repoPath = repo.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '')}
									<Select.Item value={repo.id.toString()} label={repo.name}>
										<div class="flex items-center gap-2">
											{#if repo.url.includes('github.com')}
												<Github class="w-4 h-4 shrink-0 text-muted-foreground" />
											{:else}
												<FolderGit2 class="w-4 h-4 shrink-0 text-muted-foreground" />
											{/if}
											<span>{repo.name}</span>
											<span class="text-muted-foreground text-xs">- {repoPath}</span>
											<span class="text-muted-foreground text-xs flex items-center gap-1">
												<GitBranch class="w-3 h-3" />
												{repo.branch}
											</span>
										</div>
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						{#if errors.repository}
							<p class="text-xs text-destructive">{errors.repository}</p>
						{:else if repositories.length === 0}
							<p class="text-xs text-muted-foreground">
								No repositories configured. Click "Add new" to add one.
							</p>
						{/if}
					{:else}
						<div class="space-y-3 p-3 border rounded-md bg-muted/30">
							<div class="space-y-2">
								<Label for="new-repo-name">Repository name</Label>
								<Input
									id="new-repo-name"
									bind:value={formNewRepoName}
									placeholder="e.g., my-stacks"
									class={errors.repoName ? 'border-destructive focus-visible:ring-destructive' : ''}
									oninput={() => errors.repoName = undefined}
								/>
								{#if errors.repoName}
									<p class="text-xs text-destructive">{errors.repoName}</p>
								{/if}
							</div>
							<div class="space-y-2">
								<Label for="new-repo-url">Repository URL</Label>
								<Input
									id="new-repo-url"
									bind:value={formNewRepoUrl}
									placeholder="https://github.com/user/repo.git"
									class={errors.repoUrl ? 'border-destructive focus-visible:ring-destructive' : ''}
									oninput={() => errors.repoUrl = undefined}
								/>
								{#if errors.repoUrl}
									<p class="text-xs text-destructive">{errors.repoUrl}</p>
								{/if}
							</div>
							<div class="grid grid-cols-2 gap-3">
								<div class="space-y-2">
									<Label for="new-repo-branch">Branch</Label>
									<Input id="new-repo-branch" bind:value={formNewRepoBranch} placeholder="main" />
								</div>
								<div class="space-y-2">
									<Label for="new-repo-credential">Credential</Label>
									<Select.Root
										type="single"
										value={formNewRepoCredentialId?.toString() ?? 'none'}
										onValueChange={(v) => formNewRepoCredentialId = v === 'none' ? null : parseInt(v)}
									>
										<Select.Trigger class="w-full">
											{@const selectedCred = credentials.find(c => c.id === formNewRepoCredentialId)}
											{#if selectedCred}
												{#if selectedCred.authType === 'ssh'}
													<KeyRound class="w-4 h-4 mr-2 text-muted-foreground" />
												{:else if selectedCred.authType === 'password'}
													<Lock class="w-4 h-4 mr-2 text-muted-foreground" />
												{:else}
													<Key class="w-4 h-4 mr-2 text-muted-foreground" />
												{/if}
												<span>{selectedCred.name} ({getAuthLabel(selectedCred.authType)})</span>
											{:else}
												<Key class="w-4 h-4 mr-2 text-muted-foreground" />
												<span>None (public)</span>
											{/if}
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="none">
												<span class="flex items-center gap-2">
													<Key class="w-4 h-4 text-muted-foreground" />
													None (public)
												</span>
											</Select.Item>
											{#each credentials as cred}
												<Select.Item value={cred.id.toString()}>
													<span class="flex items-center gap-2">
														{#if cred.authType === 'ssh'}
															<KeyRound class="w-4 h-4 text-muted-foreground" />
														{:else if cred.authType === 'password'}
															<Lock class="w-4 h-4 text-muted-foreground" />
														{:else}
															<Key class="w-4 h-4 text-muted-foreground" />
														{/if}
														{cred.name} ({getAuthLabel(cred.authType)})
													</span>
												</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
								</div>
							</div>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Stack configuration -->
			<div class="space-y-2">
				<Label for="stack-name">Stack name</Label>
				<Input
					id="stack-name"
					bind:value={formStackName}
					placeholder="e.g., my-app"
					class={errors.stackName ? 'border-destructive focus-visible:ring-destructive' : ''}
					oninput={() => { errors.stackName = undefined; formStackNameUserModified = true; }}
				/>
				{#if errors.stackName}
					<p class="text-xs text-destructive">{errors.stackName}</p>
				{:else}
					<p class="text-xs text-muted-foreground">This will be the name of the deployed stack</p>
				{/if}
			</div>

			<div class="space-y-2">
				<Label for="compose-path">Compose file path</Label>
				<Input id="compose-path" bind:value={formComposePath} placeholder="docker-compose.yml" />
				<p class="text-xs text-muted-foreground">Path to the compose file within the repository</p>
			</div>

			<!-- Additional env file for variable substitution -->
			<div class="space-y-2">
				<div class="flex items-center gap-1.5">
					<Label for="env-file-path">Additional .env file (optional)</Label>
					<Tooltip.Root>
						<Tooltip.Trigger>
							<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<div class="w-80">
								<p class="text-xs">All files in the git repository are cloned automatically, including any files referenced by <code class="bg-muted px-1 rounded">env_file:</code> directives.</p>
								<p class="text-xs mt-2">Only use this field for additional environment variables to be passed to Docker Compose.</p>
								<p class="text-xs mt-2">The contents will be parsed and passed as shell environment variables.</p>
							</div>
						</Tooltip.Content>
					</Tooltip.Root>
				</div>
				{#if gitStack && envFiles.length > 0}
					<!-- Dropdown selector for existing stacks with discovered .env files -->
					<Select.Root
						type="single"
						value={formEnvFilePath ?? 'none'}
						onValueChange={(v) => {
							formEnvFilePath = v === 'none' ? null : v;
							if (formEnvFilePath) {
								loadEnvFileContents(formEnvFilePath);
							} else {
								fileEnvVars = {};
							}
						}}
					>
						<Select.Trigger class="w-full">
							{#if loadingEnvFiles}
								<Loader2 class="w-4 h-4 mr-2 animate-spin" />
								Loading...
							{:else if formEnvFilePath}
								<FileText class="w-4 h-4 mr-2 text-muted-foreground" />
								{formEnvFilePath}
							{:else}
								<FileText class="w-4 h-4 mr-2 text-muted-foreground" />
								None
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="none">
								<span class="text-muted-foreground">None</span>
							</Select.Item>
							{#each envFiles as file}
								<Select.Item value={file}>
									<span class="flex items-center gap-2">
										<FileText class="w-4 h-4 text-muted-foreground" />
										{file}
									</span>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				{:else}
					<!-- Text input for new stacks or when no .env files discovered -->
					<Input
						id="env-file-path"
						bind:value={formEnvFilePath}
						placeholder=".env"
					/>
				{/if}
				<p class="text-xs text-muted-foreground">
				For variable substitution from a file outside the compose directory.
			</p>
			</div>

			<!-- Auto-update section -->
			<div class="space-y-3 p-3 bg-muted/50 rounded-md">
			<div class="flex items-center gap-3">
				<div class="flex items-center gap-2 flex-1">
					<RefreshCw class="w-4 h-4 text-muted-foreground" />
					<Label class="text-sm font-normal">Enable scheduled sync</Label>
				</div>
				<TogglePill bind:checked={formAutoUpdate} />
			</div>
				<p class="text-xs text-muted-foreground">
					Automatically sync repository and redeploy stack if there are changes.
				</p>
				{#if formAutoUpdate}
					<CronEditor
						value={formAutoUpdateCron}
						onchange={(cron) => formAutoUpdateCron = cron}
					/>
				{/if}
			</div>

			<!-- Webhook section -->
			<div class="space-y-3 p-3 bg-muted/50 rounded-md">
			<div class="flex items-center gap-3">
				<div class="flex items-center gap-2 flex-1">
					<Webhook class="w-4 h-4 text-muted-foreground" />
					<Label class="text-sm font-normal">Enable webhook</Label>
				</div>
				<TogglePill bind:checked={formWebhookEnabled} />
			</div>
				<p class="text-xs text-muted-foreground">
					Receive push events from your Git provider to trigger sync and redeploy.
				</p>
				{#if formWebhookEnabled}
					{#if gitStack}
						<div class="space-y-2">
							<Label>Webhook URL</Label>
							<div class="flex gap-2">
								<Input
									value={getWebhookUrl(gitStack.id)}
									readonly
									class="font-mono text-xs bg-background"
								/>
								<Button
									variant="outline"
									size="sm"
									onclick={() => copyToClipboard(getWebhookUrl(gitStack.id), 'url')}
									title="Copy URL"
								>
									{#if copiedWebhookUrl}
										<Check class="w-4 h-4 text-green-500" />
									{:else}
										<Copy class="w-4 h-4" />
									{/if}
								</Button>
							</div>
						</div>
					{/if}
					<div class="space-y-2">
						<Label for="webhook-secret">Webhook secret (optional)</Label>
						<div class="flex gap-2">
							<Input
								id="webhook-secret"
								bind:value={formWebhookSecret}
								placeholder="Leave empty for no signature verification"
								class="font-mono text-xs"
							/>
							{#if gitStack && formWebhookSecret}
								<Button
									variant="outline"
									size="sm"
									onclick={() => copyToClipboard(formWebhookSecret, 'secret')}
									title="Copy secret"
								>
									{#if copiedWebhookSecret}
										<Check class="w-4 h-4 text-green-500" />
									{:else}
										<Copy class="w-4 h-4" />
									{/if}
								</Button>
							{/if}
							<Button
								variant="outline"
								size="sm"
								onclick={() => formWebhookSecret = generateWebhookSecret()}
								title="Generate new secret"
							>
								<RefreshCcw class="w-4 h-4" />
							</Button>
						</div>
					</div>
					{#if !gitStack}
						<p class="text-xs text-muted-foreground">
							The webhook URL will be available after creating the stack.
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">
							Configure this URL in your Git provider. Secret is used for signature verification.
						</p>
					{/if}
				{/if}
			</div>

			<!-- Deploy now option (only for new stacks) -->
			{#if !gitStack}
				<div class="space-y-3 p-3 bg-muted/50 rounded-md">
					<div class="flex items-center gap-3">
						<div class="flex items-center gap-2 flex-1">
							<Rocket class="w-4 h-4 text-muted-foreground" />
							<div class="flex-1">
								<Label class="text-sm font-normal">Deploy now</Label>
								<p class="text-xs text-muted-foreground">Clone and deploy the stack immediately</p>
							</div>
						</div>
						<TogglePill bind:checked={formDeployNow} />
					</div>
				</div>
			{/if}

			{#if formError}
				<p class="text-sm text-destructive">{formError}</p>
			{/if}
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
				<div class="w-4 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity {isDraggingSplit ? 'opacity-100' : ''}">
					<GripVertical class="w-3 h-3 text-white" />
				</div>
			</div>

			<!-- Right column: Environment Variables -->
			<div class="flex-1 min-w-0 flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-800/50">
				<StackEnvVarsPanel
					bind:variables={envVars}
					showSource={!!formEnvFilePath && gitStack !== null}
					sources={envVarSources}
					placeholder={{ key: 'OVERRIDE_VAR', value: 'override value' }}
					infoText="These environment variables are optional. If a .env file is specified in the repository, these values will be merged with the file values. Variables defined here take precedence over .env file values."
					existingSecretKeys={gitStack !== null ? existingSecretKeys : new Set()}
				/>
			</div>
		</div>

		<Dialog.Footer class="px-5 py-2.5 border-t border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<Button variant="outline" onclick={onClose}>Cancel</Button>
			{#if gitStack}
				<Button variant="outline" onclick={() => saveGitStack(true)} disabled={formSaving}>
					{#if formSaving}
						<Loader2 class="w-4 h-4 mr-1 animate-spin" />
						Deploying...
					{:else}
						<Rocket class="w-4 h-4 mr-1" />
						Save and deploy
					{/if}
				</Button>
				<Button onclick={() => saveGitStack(false)} disabled={formSaving}>
					{#if formSaving}
						<Loader2 class="w-4 h-4 mr-1 animate-spin" />
						Saving...
					{:else}
						Save changes
					{/if}
				</Button>
			{:else}
				<Button onclick={() => saveGitStack(formDeployNow)} disabled={formSaving}>
					{#if formSaving}
						<Loader2 class="w-4 h-4 mr-1 animate-spin" />
						{formDeployNow ? 'Deploying...' : 'Creating...'}
					{:else}
						{formDeployNow ? 'Deploy' : 'Create'}
					{/if}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
