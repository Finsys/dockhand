<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Loader2, GitBranch, RefreshCw, Webhook, Rocket, RefreshCcw, Copy, Check, XCircle, FolderGit2, Github, Key, KeyRound, Lock, FileText, HelpCircle, GripVertical, X, Download } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { copyToClipboard } from '$lib/utils/clipboard';
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
		environmentId: number | null;
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
	let formComposePath = $state('compose.yaml');
	let formAutoUpdate = $state(false);
	let formAutoUpdateCron = $state('0 3 * * *');
	let formWebhookEnabled = $state(false);
	let formWebhookSecret = $state('');
	let formDeployNow = $state(false);
	let formError = $state('');
	let formSaving = $state(false);
	let errors = $state<{ stackName?: string; repository?: string; repoName?: string; repoUrl?: string }>({});

	// Stack name validation: must start with alphanumeric, can contain alphanumeric, hyphens, underscores
	const STACK_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
	let copiedWebhookUrl = $state<'ok' | 'error' | null>(null);
	let copiedWebhookSecret = $state<'ok' | 'error' | null>(null);

	// Environment variables state
	let formEnvFilePath = $state<string | null>(null);
	let envFiles = $state<string[]>([]);
	let loadingEnvFiles = $state(false);
	let envVars = $state<EnvVar[]>([]);
	let fileEnvVars = $state<Record<string, string>>({});
	let loadingFileVars = $state(false);
	let existingSecretKeys = $state<Set<string>>(new Set());
	let populatingEnvVars = $state(false);

	// Resizable split panel state
	let splitRatio = $state(60); // percentage for form panel
	let isDraggingSplit = $state(false);
	let containerRef: HTMLDivElement | null = $state(null);


	// Track which gitStack was initialized to avoid repeated resets
	let lastInitializedStackId = $state<number | null | undefined>(undefined);
	let isInitializing = $state(false);

	$effect(() => {
		if (open) {
			const currentStackId = gitStack?.id ?? null;
			if (lastInitializedStackId !== currentStackId && !isInitializing) {
				lastInitializedStackId = currentStackId;
				isInitializing = true;
				resetForm().finally(() => {
					isInitializing = false;
				});
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

	async function copyWebhookField(text: string, type: 'url' | 'secret') {
		const ok = await copyToClipboard(text);
		const state = ok ? 'ok' : 'error';
		if (type === 'url') {
			copiedWebhookUrl = state;
			setTimeout(() => copiedWebhookUrl = null, 2000);
		} else {
			copiedWebhookSecret = state;
			setTimeout(() => copiedWebhookSecret = null, 2000);
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
			// Use gitStack.environmentId when editing, fall back to prop for new stacks
			const envIdToUse = gitStack.environmentId ?? environmentId;
			const response = await fetch(`/api/stacks/${encodeURIComponent(gitStack.stackName)}/env${envIdToUse ? `?env=${envIdToUse}` : ''}`);
			if (response.ok) {
				const data = await response.json();
				const loadedVars = data.variables || [];
				// Track existing secret keys (secrets loaded from DB cannot have visibility toggled)
				existingSecretKeys = new Set(
					loadedVars.filter((v: EnvVar) => v.isSecret && v.key.trim()).map((v: EnvVar) => v.key.trim())
				);
				// Set envVars - the panel's $effect will auto-sync rawContent for text view
				envVars = loadedVars;
			}
		} catch (e) {
			console.error('Failed to load env var overrides:', e);
		}
	}

	async function populateEnvVars() {
		// Validate we have repository info
		if (formRepoMode === 'existing' && !formRepositoryId) {
			toast.error('Please select a repository first');
			return;
		}
		if (formRepoMode === 'new' && !formNewRepoUrl.trim()) {
			toast.error('Please enter a repository URL first');
			return;
		}

		populatingEnvVars = true;
		try {
			const body: Record<string, any> = {
				composePath: formComposePath || 'compose.yaml',
				envFilePath: formEnvFilePath || null
			};

			if (formRepoMode === 'existing') {
				body.repositoryId = formRepositoryId;
			} else {
				body.url = formNewRepoUrl;
				body.branch = formNewRepoBranch || 'main';
				body.credentialId = formNewRepoCredentialId;
			}

			const response = await fetch('/api/git/preview-env', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			const data = await response.json();

			if (!response.ok) {
				toast.error('Failed to load env variables', {
					description: data.error || 'Unknown error'
				});
				return;
			}

			const vars = data.vars as Record<string, string>;
			const count = Object.keys(vars).length;

			if (count === 0) {
				toast.info('No environment variables found', {
					description: 'No .env files found in the repository. You can still add variables manually.'
				});
				return;
			}

			// Convert to EnvVar array - preserve existing user entries that aren't in repo
			const existingUserVars = envVars.filter(v => v.key.trim() && !(v.key in vars));
			const newVars: EnvVar[] = Object.entries(vars).map(([key, value]) => ({
				key,
				value,
				isSecret: false
			}));

			envVars = [...newVars, ...existingUserVars];
			fileEnvVars = vars;

			toast.success(`Loaded ${count} variable${count === 1 ? '' : 's'}`, {
				description: 'You can now customize values before deploying'
			});
		} catch (e) {
			console.error('Failed to populate env vars:', e);
			toast.error('Failed to load env variables');
		} finally {
			populatingEnvVars = false;
		}
	}

	async function resetForm() {
		// Clear state BEFORE async loads to avoid race conditions
		formError = '';
		errors = {};
		copiedWebhookUrl = null;
		copiedWebhookSecret = null;
		envFiles = [];
		envVars = [];
		fileEnvVars = {};
		existingSecretKeys = new Set();

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

			// Load env files and overrides SYNCHRONOUSLY to avoid race conditions
			// Wait for all loads to complete before allowing any other effect to run
			await Promise.all([
				loadEnvFiles(),
				loadEnvVarsOverrides(),
				gitStack.envFilePath ? loadEnvFileContents(gitStack.envFilePath) : Promise.resolve()
			]);
		} else {
			formRepoMode = repositories.length > 0 ? 'existing' : 'new';
			formRepositoryId = null;
			formNewRepoName = '';
			formNewRepoUrl = '';
			formNewRepoBranch = 'main';
			formNewRepoCredentialId = null;
			formStackName = '';
			formStackNameUserModified = false;
			formComposePath = 'compose.yaml';
			formEnvFilePath = null;
			formAutoUpdate = false;
			formAutoUpdateCron = '0 3 * * *';
			formWebhookEnabled = false;
			formWebhookSecret = '';
			formDeployNow = false;
		}
	}

	async function saveGitStack(deployAfterSave: boolean = false) {
		errors = {};
		let hasErrors = false;

		const trimmedStackName = formStackName.trim();
		if (!trimmedStackName) {
			errors.stackName = 'Stack name is required';
			hasErrors = true;
		} else if (!STACK_NAME_REGEX.test(trimmedStackName)) {
			errors.stackName = 'Stack name must start with a letter or number, and contain only letters, numbers, hyphens, and underscores';
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
			// Only save vars that are actual overrides (differ from file) or new (not in file)
			// This ensures file updates from git are picked up on next sync
			const overrideVars = envVars.filter(v => {
				if (!v.key.trim()) return false;
				const fileValue = fileEnvVars[v.key];
				// Save if: not in file (new var), value differs from file, or is a secret
				return fileValue === undefined || v.value !== fileValue || v.isSecret;
			});

			let body: any = {
				stackName: formStackName,
				composePath: formComposePath || 'compose.yaml',
				envFilePath: formEnvFilePath,
				environmentId: environmentId,
				autoUpdate: formAutoUpdate,
				autoUpdateCron: formAutoUpdateCron,
				webhookEnabled: formWebhookEnabled,
				webhookSecret: formWebhookEnabled ? formWebhookSecret : null,
				deployNow: deployAfterSave,
				envVars: overrideVars.map(v => ({
					key: v.key.trim(),
					value: v.value,
					isSecret: v.isSecret
				}))
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
				// Normalize repo name: lowercase, spaces/underscores to hyphens, strip invalid chars
				const normalizedName = repo.name
					.toLowerCase()
					.replace(/[\s_]+/g, '-')
					.replace(/[^a-z0-9-]/g, '')
					.replace(/-+/g, '-')
					.replace(/^-|-$/g, '');

				// Extract compose filename without extension for stack name
				const composeName = formComposePath
					.replace(/^.*\//, '') // Remove directory path
					.replace(/\.(yml|yaml)$/i, '') // Remove extension
					.replace(/^docker-compose\.?/, '') // Remove docker-compose prefix
					.replace(/^compose$/, ''); // Remove plain "compose"

				// Combine repo name with compose name if it's not the default
				if (composeName && composeName !== 'docker-compose') {
					formStackName = `${normalizedName}-${composeName}`;
				} else {
					formStackName = normalizedName;
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
				<Input id="compose-path" bind:value={formComposePath} placeholder="compose.yaml" />
				<p class="text-xs text-muted-foreground">Path to the compose file within the repository</p>
			</div>

			<!-- Additional env file for variable substitution -->
			<div class="space-y-2">
				<div class="flex items-center gap-1.5">
					<Label for="env-file-path">Additional env file (optional)</Label>
					<Tooltip.Root>
						<Tooltip.Trigger>
							<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<div class="w-80">
								<p class="text-xs">A <code class="bg-muted px-1 rounded">.env</code> file in the compose directory is always loaded automatically, if present.</p>
								<p class="text-xs mt-2">Use this field for an additional env file with a non-standard name (e.g. <code class="bg-muted px-1 rounded">.env.production</code>). Its values override the default <code class="bg-muted px-1 rounded">.env</code>.</p>
								<p class="text-xs mt-2">Overrides from the environment variables editor on the right always take highest precedence.</p>
							</div>
						</Tooltip.Content>
					</Tooltip.Root>
				</div>
					<Input
						id="env-file-path"
						bind:value={formEnvFilePath}
						placeholder=""
					/>
				<p class="text-xs text-muted-foreground">Additional env file to pass to Docker Compose</p>
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
									onclick={() => copyWebhookField(getWebhookUrl(gitStack.id), 'url')}
									title="Copy URL"
								>
									{#if copiedWebhookUrl === 'error'}
										<Tooltip.Root open>
											<Tooltip.Trigger>
												<XCircle class="w-4 h-4 text-red-500" />
											</Tooltip.Trigger>
											<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
										</Tooltip.Root>
									{:else if copiedWebhookUrl === 'ok'}
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
									onclick={() => copyWebhookField(formWebhookSecret, 'secret')}
									title="Copy secret"
								>
									{#if copiedWebhookSecret === 'error'}
										<Tooltip.Root open>
											<Tooltip.Trigger>
												<XCircle class="w-4 h-4 text-red-500" />
											</Tooltip.Trigger>
											<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
										</Tooltip.Root>
									{:else if copiedWebhookSecret === 'ok'}
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
					placeholder={{ key: 'MY_VAR', value: 'value' }}
					infoText="Override variables from your repository env files. Non-secrets are saved to <code class='bg-muted px-1 rounded'>.env.dockhand</code> in the stack directory. Secrets are stored in the database and injected via shell environment at deploy time.<br/><br/>Variables are available for <strong>compose file interpolation</strong> using <code class='bg-muted px-1 rounded'>${'{VAR_NAME}'}</code> syntax. They are not automatically injected into containers — use <code class='bg-muted px-1 rounded'>environment:</code> or reference <code class='bg-muted px-1 rounded'>.env.dockhand</code> in <code class='bg-muted px-1 rounded'>env_file:</code> to pass them through."
					existingSecretKeys={gitStack !== null ? existingSecretKeys : new Set()}
					showInterpolationHint={true}
				>
					{#snippet headerActions()}
						{#if !gitStack}
							<div class="flex items-center gap-0.5">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onclick={populateEnvVars}
									disabled={populatingEnvVars || (formRepoMode === 'existing' && !formRepositoryId) || (formRepoMode === 'new' && !formNewRepoUrl.trim())}
									class="h-6 text-xs px-2"
								>
									{#if populatingEnvVars}
										<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />
										Loading...
									{:else}
										<Download class="w-3.5 h-3.5" />
										Populate
									{/if}
								</Button>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
									</Tooltip.Trigger>
									<Tooltip.Content>
										<div class="w-64">
											<p class="text-xs">Clone the repository and load environment variables from the <code class="bg-muted px-1 rounded">.env</code> file (in compose directory) and additional env file (if specified), so you can see what you can override.</p>
										</div>
									</Tooltip.Content>
								</Tooltip.Root>
							</div>
						{/if}
					{/snippet}
				</StackEnvVarsPanel>
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
						<Rocket class="w-4 h-4" />
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
