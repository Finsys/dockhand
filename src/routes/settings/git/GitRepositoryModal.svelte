<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { appSettings } from '$lib/stores/settings';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Loader2, GitBranch, KeyRound, Lock, Key, Globe, Play, CheckCircle2, XCircle, GitFork, RefreshCw, Webhook } from 'lucide-svelte';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import WebhookSecretInput from '$lib/components/WebhookSecretInput.svelte';
	import WebhookUrlCopyField from '$lib/components/WebhookUrlCopyField.svelte';
	import { focusFirstInput } from '$lib/utils';
	import { ensureWebhookSecret, webhookSecretValidationError } from '$lib/utils/webhook-secret';
	import { startJobPolling, type JobPollingHandle } from '$lib/utils/job-polling';

	interface GitCredential {
		id: number;
		name: string;
		authType: string;
	}

	interface GitRepository {
		id: number;
		name: string;
		url: string;
		branch: string;
		credentialId: number | null;
		autoUpdate: boolean;
		autoUpdateCron: string;
		webhookEnabled: boolean;
		webhookSecret: string | null;
	}

	interface Props {
		open: boolean;
		repository?: GitRepository | null;
		credentials: GitCredential[];
		onClose: () => void;
		onSaved: () => void;
	}

	let { open = $bindable(), repository = null, credentials, onClose, onSaved }: Props = $props();

	// Form state
	let formName = $state('');
	let formUrl = $state('');
	let formBranch = $state('main');
	let formCredentialId = $state<number | null>(null);
	let formError = $state('');
	let formErrors = $state<{ name?: string; url?: string; webhookSecret?: string }>({});
	let formSaving = $state(false);

	let formAutoUpdate = $state(false);
	let formAutoUpdateCron = $state('0 3 * * *');
	let formWebhookEnabled = $state(false);
	let formWebhookSecret = $state('');

	// Repo-level schedule/webhook and the clone-progress modal apply when the
	// repo is (or is about to be) used in centralized mode:
	//  - Editing an existing repo: repo-LEVEL fields follow MEMBERSHIP — shown
	//    when the repo already has a centralized-model stack (server PUT gates on
	//    repositoryHasCentralizedStack), or when a zero-stack repo is being
	//    prepared under a centralized default (fresh repo for a new centralized
	//    stack).
	//  - Creating a new repo: the global DEFAULT governs.
	let repoStacks = $state<{ repositoryId: number; engine: string }[]>([]);

	async function loadRepoStacks() {
		try {
			const res = await fetch('/api/git/stacks');
			if (res.ok) {
				const stacks = await res.json();
				repoStacks = (Array.isArray(stacks) ? stacks : []).map((s: any) => ({
					repositoryId: s.repositoryId,
					engine: s.engine === 'centralized' ? 'centralized' : 'stack'
				}));
			}
		} catch {
			// membership is best-effort; fall back to the default below
		}
	}

	const isCentralizedMode = $derived(
		repository
			? (repoStacks.some((s) => s.repositoryId === repository.id && s.engine === 'centralized')
				|| (repoStacks.filter((s) => s.repositoryId === repository.id).length === 0 && $appSettings.gitRepositoryDesiredMode === 'centralized'))
			: $appSettings.gitRepositoryDesiredMode === 'centralized'
	);

	onMount(() => {
		// F11: sync the client's git mode with the server before showing the modal.
		appSettings.reload();
	});

	$effect(() => {
		if (open) void loadRepoStacks();
	});

	function getWebhookUrl(repoId: number): string {
		return `${window.location.origin}/api/git/webhook/${repoId}`;
	}

	// Test state
	let testing = $state(false);
	let testResult = $state<{ success: boolean; error?: string; branch?: string; lastCommit?: string } | null>(null);

	// Clone-progress state
	type CloneStatus = 'idle' | 'cloning' | 'success' | 'error';
	let cloneStatus = $state<CloneStatus>('idle');
	let cloneError = $state('');
	let savedRepoId = $state<number | null>(null);
	let pollHandle: JobPollingHandle | null = null;

	const isEditing = $derived(repository !== null);

	function getAuthIcon(type: string) {
		switch (type) {
			case 'ssh': return KeyRound;
			case 'password': return Lock;
			default: return Key;
		}
	}

	function getAuthLabel(type: string) {
		switch (type) {
			case 'ssh': return 'SSH Key';
			case 'password': return 'Password';
			default: return 'None';
		}
	}

	function resetForm() {
		if (repository) {
			formName = repository.name;
			formUrl = repository.url;
			formBranch = repository.branch;
			formCredentialId = repository.credentialId;
			formAutoUpdate = repository.autoUpdate ?? false;
			formAutoUpdateCron = repository.autoUpdateCron || '0 3 * * *';
			formWebhookEnabled = repository.webhookEnabled ?? false;
			formWebhookSecret = repository.webhookSecret || '';
		} else {
			formName = '';
			formUrl = '';
			formBranch = 'main';
			formCredentialId = null;
			formAutoUpdate = false;
			formAutoUpdateCron = '0 3 * * *';
			formWebhookEnabled = false;
			formWebhookSecret = '';
		}
		formError = '';
		formErrors = {};
		testResult = null;
		cloneStatus = 'idle';
		cloneError = '';
		savedRepoId = null;
		stopPolling();
	}

	// Track which repository was initialized to avoid repeated resets
	let lastInitializedRepoId = $state<number | null | undefined>(undefined);

	$effect(() => {
		if (open) {
			const currentRepoId = repository?.id ?? null;
			if (lastInitializedRepoId !== currentRepoId) {
				lastInitializedRepoId = currentRepoId;
				resetForm();
			}
		} else {
			lastInitializedRepoId = undefined;
		}
	});

	function stopPolling() {
		pollHandle?.stop();
		pollHandle = null;
	}

	function startPolling(jobId: string) {
		stopPolling();
		pollHandle = startJobPolling(jobId, {
			onDone: () => {
				cloneStatus = 'success';
				onSaved(); // refresh list in parent
			},
			onError: (error) => {
				cloneStatus = 'error';
				cloneError = error ?? 'Clone failed — check the repository URL and credentials.';
				onSaved(); // refresh list in parent so the repo shows up behind the modal
			},
			onUnavailable: () => {
				cloneStatus = 'error';
				cloneError = 'Could not retrieve clone status. The repository may still be cloning in the background — check the status below.';
			}
		});
	}

	async function testRepository() {
		if (!formUrl.trim()) {
			formErrors.url = 'Repository URL is required to test';
			return;
		}

		testing = true;
		testResult = null;

		try {
			const response = await fetch('/api/git/repositories/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					url: formUrl.trim(),
					branch: formBranch || 'main',
					credentialId: formCredentialId
				})
			});

			const data = await response.json();
			testResult = data;

			if (data.success) {
				toast.success(`Connection successful! Branch: ${data.branch}, Commit: ${data.lastCommit}`);
			} else {
				toast.error(data.error || 'Connection test failed');
			}
		} catch (error) {
			testResult = { success: false, error: 'Failed to test connection' };
			toast.error('Failed to test connection');
		} finally {
			testing = false;
		}
	}

	async function saveRepository() {
		formErrors = {};

		if (!formName.trim()) {
			formErrors.name = 'Name is required';
		}

		if (!formUrl.trim()) {
			formErrors.url = 'Repository URL is required';
		}

		const webhookSecretError = isCentralizedMode ? webhookSecretValidationError(formWebhookEnabled, formWebhookSecret) : undefined;
		if (webhookSecretError) {
			formErrors.webhookSecret = webhookSecretError;
		}

		if (formErrors.name || formErrors.url || formErrors.webhookSecret) {
			return;
		}

		formSaving = true;
		formError = '';

		try {
			// Stack mode: repositories are thin records — no repo-level schedule/webhook.
			const body = isCentralizedMode
				? {
					name: formName.trim(),
					url: formUrl.trim(),
					branch: formBranch || 'main',
					credentialId: formCredentialId,
					autoUpdate: formAutoUpdate,
					autoUpdateSchedule: formAutoUpdate ? 'custom' : undefined,
					autoUpdateCron: formAutoUpdateCron,
					webhookEnabled: formWebhookEnabled,
					webhookSecret: formWebhookEnabled ? formWebhookSecret : null
				}
				: {
					name: formName.trim(),
					url: formUrl.trim(),
					branch: formBranch || 'main',
					credentialId: formCredentialId
				};

			const url = repository
				? `/api/git/repositories/${repository.id}`
				: '/api/git/repositories';
			const method = repository ? 'PUT' : 'POST';

			const response = await fetch(url, {
				method,
				headers: {
					'Content-Type': 'application/json',
					// Progress modal + job polling need the background clone (centralized only)
					...(method === 'POST' && isCentralizedMode ? { 'X-Dockhand-Async': '1' } : {})
				},
				body: JSON.stringify(body)
			});

			const data = await response.json();

			if (!response.ok) {
				if (data.error?.includes('already exists')) {
					formErrors.name = 'Repository name already exists';
				} else {
					formError = data.error || 'Failed to save repository';
				}
				toast.error(formError || 'Failed to save repository');
				return;
			}

			// Only show clone progress when the API started a sync job
			// (create always; edit only when URL/branch/credentials changed)
			savedRepoId = data.id;

			if (data.jobId) {
				cloneStatus = 'cloning';
				startPolling(data.jobId);
			} else {
				toast.success(isEditing ? 'Repository updated' : 'Repository saved');
				onSaved();
				handleClose();
			}
		} catch (error) {
			formError = 'Failed to save repository';
			toast.error('Failed to save repository');
		} finally {
			formSaving = false;
		}
	}

	async function deleteAndClose() {
		if (!savedRepoId) return;
		try {
			await fetch(`/api/git/repositories/${savedRepoId}`, { method: 'DELETE' });
		} catch {
			// best-effort delete
		}
		onSaved(); // refresh list
		handleClose();
	}

	function handleClose() {
		stopPolling();
		cloneStatus = 'idle';
		cloneError = '';
		savedRepoId = null;
		onClose();
	}

	onDestroy(() => {
		stopPolling();
	});

</script>


<Dialog.Root bind:open onOpenChange={(o) => {
	// Prevent closing while clone is in progress
	if (!o && cloneStatus === 'cloning') return;
	if (o) focusFirstInput();
	else handleClose();
}}>
	<Dialog.Content class="max-w-lg">
		{#if isCentralizedMode && cloneStatus === 'cloning'}
			<!-- ── Cloning state ── -->
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<GitFork class="w-5 h-5" />
					{isEditing ? 'Re-cloning repository…' : 'Cloning repository…'}
				</Dialog.Title>
				<Dialog.Description>
					Please wait while the repository is being cloned. This may take a moment.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col items-center justify-center gap-4 py-10">
				<Loader2 class="w-10 h-10 animate-spin text-muted-foreground" />
				<p class="text-sm text-muted-foreground">Cloning from <span class="font-mono text-foreground">{formUrl}</span>…</p>
			</div>

		{:else if isCentralizedMode && cloneStatus === 'success'}
			<!-- ── Success state ── -->
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2 text-green-600 dark:text-green-400">
					<CheckCircle2 class="w-5 h-5" />
					Repository cloned successfully
				</Dialog.Title>
				<Dialog.Description>
					{isEditing ? 'The repository has been re-cloned with your updated settings.' : 'The repository has been added and cloned successfully.'}
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col items-center justify-center gap-3 py-8">
				<div class="flex h-16 w-16 items-center justify-center rounded-full bg-green-50 dark:bg-green-950/30">
					<CheckCircle2 class="w-9 h-9 text-green-600 dark:text-green-400" />
				</div>
				<p class="text-sm text-muted-foreground">You can now use this repository when deploying stacks.</p>
			</div>
			<Dialog.Footer>
				<Button onclick={handleClose}>Close</Button>
			</Dialog.Footer>

		{:else if isCentralizedMode && cloneStatus === 'error'}
			<!-- ── Error state ── -->
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2 text-destructive">
					<XCircle class="w-5 h-5" />
					Clone failed
				</Dialog.Title>
				<Dialog.Description>
					The repository was saved but could not be cloned. Check the error below.
				</Dialog.Description>
			</Dialog.Header>
			<div class="rounded-md border border-destructive/40 bg-destructive/5 p-4 my-2">
				<p class="text-sm font-medium text-destructive mb-1">Git error</p>
				<pre class="text-xs text-destructive/90 whitespace-pre-wrap break-all font-mono">{cloneError}</pre>
			</div>
			<p class="text-xs text-muted-foreground">
				You can fix the URL or credentials and edit the repository to retry, or delete it to start over.
			</p>
			<Dialog.Footer class="gap-2 flex-col sm:flex-row">
				<Button variant="destructive" onclick={deleteAndClose}>
					Delete repository
				</Button>
				<Button variant="outline" onclick={handleClose}>Close</Button>
			</Dialog.Footer>

		{:else}
			<!-- ── Form state (idle) ── -->
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<GitBranch class="w-5 h-5" />
					{isEditing ? 'Edit' : 'Add'} Git repository
				</Dialog.Title>
				<Dialog.Description>
					{isEditing ? 'Update repository settings' : 'Add a Git repository that can be used to deploy stacks'}
				</Dialog.Description>
			</Dialog.Header>

			<form onsubmit={(e) => { e.preventDefault(); saveRepository(); }} class="space-y-4">
				<div class="space-y-2">
					<Label for="repo-name">Name</Label>
					<Input
						id="repo-name"
						bind:value={formName}
						placeholder="e.g., my-app-repo"
						class={formErrors.name ? 'border-destructive focus-visible:ring-destructive' : ''}
						oninput={() => formErrors.name = undefined}
					/>
					{#if formErrors.name}
						<p class="text-xs text-destructive">{formErrors.name}</p>
					{:else if !isEditing}
						<p class="text-xs text-muted-foreground">A friendly name to identify this repository</p>
					{/if}
				</div>

				<div class="space-y-2">
					<Label for="repo-url">Repository URL</Label>
					<Input
						id="repo-url"
						bind:value={formUrl}
						placeholder="https://github.com/user/repo.git or git@github.com:user/repo.git"
						class={formErrors.url ? 'border-destructive focus-visible:ring-destructive' : ''}
						oninput={() => { formErrors.url = undefined; testResult = null; }}
					/>
					{#if formErrors.url}
						<p class="text-xs text-destructive">{formErrors.url}</p>
					{/if}
				</div>

				<div class="space-y-2">
					<Label for="repo-branch">Branch</Label>
					<Input id="repo-branch" bind:value={formBranch} placeholder="main" oninput={() => testResult = null} />
				</div>

				<div class="space-y-2">
					<Label for="repo-credential">Credential (optional)</Label>
					<Select.Root
						type="single"
						value={formCredentialId?.toString() ?? 'none'}
						onValueChange={(v) => { formCredentialId = v === 'none' ? null : parseInt(v); testResult = null; }}
					>
						<Select.Trigger class="w-full">
							{@const selectedCred = credentials.find(c => c.id === formCredentialId)}
							{#if selectedCred}
								{@const Icon = getAuthIcon(selectedCred.authType)}
								<span class="flex items-center gap-2">
									<Icon class="w-4 h-4 text-muted-foreground" />
									{selectedCred.name} ({getAuthLabel(selectedCred.authType)})
								</span>
							{:else}
								<span class="flex items-center gap-2">
									<Globe class="w-4 h-4 text-muted-foreground" />
									None (public repository)
								</span>
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="none">
								<span class="flex items-center gap-2">
									<Globe class="w-4 h-4 text-muted-foreground" />
									None (public repository)
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
					{#if credentials.length === 0 && !isEditing}
						<p class="text-xs text-muted-foreground">
							<a href="/settings?tab=git&subtab=credentials" class="text-primary hover:underline">Add credentials</a> for private repositories
						</p>
					{/if}
				</div>

				<!-- Auto-update + webhook sections (centralized mode only — stack
				     mode keeps repositories as thin records and configures these per stack) -->
				{#if isCentralizedMode}
				<div class="space-y-3 p-3 bg-muted/50 rounded-md">
					<div class="flex items-center gap-3">
						<div class="flex items-center gap-2 flex-1">
							<RefreshCw class="w-4 h-4 text-muted-foreground" />
							<Label class="text-sm font-normal">Enable scheduled sync</Label>
						</div>
						<TogglePill bind:checked={formAutoUpdate} />
					</div>
					<p class="text-xs text-muted-foreground">
						Automatically sync repository and redeploy affected stacks if there are changes.
					</p>
					{#if formAutoUpdate}
						<CronEditor
							value={formAutoUpdateCron}
							onchange={(cron) => formAutoUpdateCron = cron}
						/>
					{/if}
				</div>

				<div class="space-y-3 p-3 bg-muted/50 rounded-md">
					<div class="flex items-center gap-3">
						<div class="flex items-center gap-2 flex-1">
							<Webhook class="w-4 h-4 text-muted-foreground" />
							<Label class="text-sm font-normal">Enable webhook</Label>
						</div>
						<TogglePill
							bind:checked={formWebhookEnabled}
							onchange={(enabled) => { formWebhookSecret = ensureWebhookSecret(enabled, formWebhookSecret); }}
						/>
					</div>
					<p class="text-xs text-muted-foreground">
						Receive push events from your Git provider to trigger sync and redeploy.
					</p>
					{#if formWebhookEnabled}
						{#if repository}
							<WebhookUrlCopyField url={getWebhookUrl(repository.id)} />
						{/if}
						<WebhookSecretInput
							id="webhook-secret"
							bind:value={formWebhookSecret}
							error={formErrors.webhookSecret}
							showCopy={!!repository}
							oninput={() => formErrors.webhookSecret = undefined}
						/>
						{#if !repository}
							<p class="text-xs text-muted-foreground">
								The webhook URL will be available after creating the repository.
							</p>
						{:else}
							<p class="text-xs text-muted-foreground">
								Configure this URL in your Git provider. Secret is used for signature verification.
							</p>
						{/if}
					{/if}
				</div>
				{/if}

				{#if formError}
					<p class="text-sm text-destructive">{formError}</p>
				{/if}

				<Dialog.Footer>
					<Button variant="outline" type="button" onclick={handleClose}>Cancel</Button>
					<Button
						type="button"
						variant="outline"
						onclick={testRepository}
						disabled={testing || !formUrl.trim()}
						class={testResult?.success ? 'border-green-500 text-green-600 dark:border-green-500 dark:text-green-400' : ''}
					>
						{#if testing}
							<Loader2 class="w-4 h-4 mr-1.5 animate-spin" />
						{:else if testResult?.success}
							<CheckCircle2 class="w-4 h-4 mr-1.5 text-green-500" />
						{:else}
							<Play class="w-4 h-4 mr-1.5" />
						{/if}
						Test
					</Button>
					<Button type="submit" disabled={formSaving}>
						{#if formSaving}
							<Loader2 class="w-4 h-4 mr-1 animate-spin" />
							Saving...
						{:else}
							{isEditing ? 'Save changes' : 'Add repository'}
						{/if}
					</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>

