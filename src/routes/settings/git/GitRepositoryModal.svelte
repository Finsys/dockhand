<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Loader2, GitBranch, KeyRound, Lock, Key, Globe, Play, CheckCircle2 } from 'lucide-svelte';
	import { focusFirstInput } from '$lib/utils';
	import { m } from '$lib/paraglide/messages.js';
	import { splitAtName } from '$lib/i18n/split';

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
	let formErrors = $state<{ name?: string; url?: string }>({});
	let formSaving = $state(false);

	// Test state
	let testing = $state(false);
	let testResult = $state<{ success: boolean; error?: string; branch?: string; lastCommit?: string } | null>(null);

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
			case 'ssh': return m.stacks_git_auth_ssh_key();
			case 'password': return m.stacks_git_auth_password();
			default: return m.stacks_git_auth_none();
		}
	}

	function resetForm() {
		if (repository) {
			formName = repository.name;
			formUrl = repository.url;
			formBranch = repository.branch;
			formCredentialId = repository.credentialId;
		} else {
			formName = '';
			formUrl = '';
			formBranch = 'main';
			formCredentialId = null;
		}
		formError = '';
		formErrors = {};
		testResult = null;
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

	async function testRepository() {
		if (!formUrl.trim()) {
			formErrors.url = m.settings_git_error_url_required_to_test();
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
				toast.success(m.settings_git_test_success_detail({ branch: data.branch, commit: data.lastCommit }));
			} else {
				toast.error(data.error || m.settings_git_connection_test_failed());
			}
		} catch (error) {
			testResult = { success: false, error: m.settings_git_test_connection_error() };
			toast.error(m.settings_git_test_connection_error());
		} finally {
			testing = false;
		}
	}

	async function saveRepository() {
		formErrors = {};

		if (!formName.trim()) {
			formErrors.name = m.settings_git_error_name_required();
		}

		if (!formUrl.trim()) {
			formErrors.url = m.stacks_git_error_repo_url_required();
		}

		if (formErrors.name || formErrors.url) {
			return;
		}

		formSaving = true;
		formError = '';

		try {
			const body = {
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
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			const data = await response.json();

			if (!response.ok) {
				if (data.error?.includes('already exists')) {
					formErrors.name = m.settings_git_error_repo_name_exists();
				} else {
					formError = data.error || m.settings_git_repo_save_failed();
				}
				toast.error(formError || m.settings_git_repo_save_failed());
				return;
			}

			const wasEditing = repository !== null;
			onSaved();
			onClose();
			toast.success(wasEditing ? m.settings_git_repo_updated() : m.settings_git_repo_added());
		} catch (error) {
			formError = m.settings_git_repo_save_failed();
			toast.error(m.settings_git_repo_save_failed());
		} finally {
			formSaving = false;
		}
	}

</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) focusFirstInput(); else onClose(); }}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<GitBranch class="w-5 h-5" />
				{isEditing ? m.settings_git_repo_modal_title_edit() : m.settings_git_repo_modal_title_add()}
			</Dialog.Title>
			<Dialog.Description>
				{isEditing ? m.settings_git_repo_modal_description_edit() : m.settings_git_repo_modal_description_add()}
			</Dialog.Description>
		</Dialog.Header>

		<form onsubmit={(e) => { e.preventDefault(); saveRepository(); }} class="space-y-4">
			<div class="space-y-2">
				<Label for="repo-name">{m.settings_git_name()}</Label>
				<Input
					id="repo-name"
					bind:value={formName}
					placeholder={m.settings_git_repo_name_placeholder()}
					class={formErrors.name ? 'border-destructive focus-visible:ring-destructive' : ''}
					oninput={() => formErrors.name = undefined}
				/>
				{#if formErrors.name}
					<p class="text-xs text-destructive">{formErrors.name}</p>
				{:else if !isEditing}
					<p class="text-xs text-muted-foreground">{m.settings_git_repo_name_hint()}</p>
				{/if}
			</div>

			<div class="space-y-2">
				<Label for="repo-url">{m.stacks_git_repo_url()}</Label>
				<Input
					id="repo-url"
					bind:value={formUrl}
					placeholder={m.settings_git_repo_url_placeholder()}
					class={formErrors.url ? 'border-destructive focus-visible:ring-destructive' : ''}
					oninput={() => { formErrors.url = undefined; testResult = null; }}
				/>
				{#if formErrors.url}
					<p class="text-xs text-destructive">{formErrors.url}</p>
				{/if}
			</div>

			<div class="space-y-2">
				<Label for="repo-branch">{m.stacks_git_branch()}</Label>
				<Input id="repo-branch" bind:value={formBranch} placeholder="main" oninput={() => testResult = null} />
			</div>

			<div class="space-y-2">
				<Label for="repo-credential">{m.settings_git_credential_optional()}</Label>
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
								{m.settings_git_credential_none()}
							</span>
						{/if}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="none">
							<span class="flex items-center gap-2">
								<Globe class="w-4 h-4 text-muted-foreground" />
								{m.settings_git_credential_none()}
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
					{@const [addCredentialsBefore, addCredentialsAfter] = splitAtName(m.settings_git_add_credentials_hint)}
					<p class="text-xs text-muted-foreground">
						{addCredentialsBefore}<a href="/settings?tab=git&subtab=credentials" class="text-primary hover:underline">{m.settings_git_add_credentials_link()}</a>{addCredentialsAfter}
					</p>
				{/if}
			</div>

			{#if formError}
				<p class="text-sm text-destructive">{formError}</p>
			{/if}

			<Dialog.Footer>
				<Button variant="outline" type="button" onclick={onClose}>{m.settings_git_cancel()}</Button>
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
					{m.settings_git_test()}
				</Button>
				<Button type="submit" disabled={formSaving}>
					{#if formSaving}
						<Loader2 class="w-4 h-4 mr-1 animate-spin" />
						{m.settings_git_saving()}
					{:else}
						{isEditing ? m.settings_git_save_changes() : m.settings_git_add_repository()}
					{/if}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
