<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Switch } from '$lib/components/ui/switch';
	import {
		Loader2,
		Save,
		TestTube2,
		Check,
		X,
		KeyRound,
		Server,
		ShieldCheck,
		ShieldAlert,
		Info
	} from 'lucide-svelte';
	import { canAccess } from '$lib/stores/auth';

	// Vault config types
	interface VaultConfig {
		configured: boolean;
		enabled: boolean;
		address?: string;
		namespace?: string;
		defaultPath?: string;
		authMethod?: string;
		hasToken?: boolean;
		roleId?: string;
		hasSecretId?: boolean;
		kubeRole?: string;
		skipTlsVerify?: boolean;
	}

	// State
	let loading = $state(true);
	let saving = $state(false);
	let testing = $state(false);
	let testResult = $state<{ success: boolean; error?: string; version?: string } | null>(null);

	// Form state
	let address = $state('');
	let namespace = $state('');
	let defaultPath = $state('secret/data');
	let authMethod = $state<'token' | 'approle' | 'kubernetes'>('token');
	let enabled = $state(true);
	let skipTlsVerify = $state(false);

	// Auth credentials
	let token = $state('');
	let roleId = $state('');
	let secretId = $state('');
	let kubeRole = $state('');

	// Track if credentials exist
	let hasExistingToken = $state(false);
	let hasExistingSecretId = $state(false);

	// Derived
	let canEdit = $derived($canAccess('settings', 'edit'));

	async function fetchConfig() {
		loading = true;
		try {
			const response = await fetch('/api/vault/config');
			if (response.ok) {
				const data: VaultConfig = await response.json();
				if (data.configured) {
					address = data.address || '';
					namespace = data.namespace || '';
					defaultPath = data.defaultPath || 'secret/data';
					authMethod = (data.authMethod as typeof authMethod) || 'token';
					enabled = data.enabled;
					skipTlsVerify = data.skipTlsVerify || false;
					roleId = data.roleId || '';
					kubeRole = data.kubeRole || '';
					hasExistingToken = data.hasToken || false;
					hasExistingSecretId = data.hasSecretId || false;

					// Show placeholder for existing secrets
					if (hasExistingToken) token = '***';
					if (hasExistingSecretId) secretId = '***';
				}
			}
		} catch (error) {
			console.error('Failed to fetch Vault config:', error);
			toast.error('Failed to load Vault configuration');
		} finally {
			loading = false;
		}
	}

	async function saveConfig() {
		if (!address.trim()) {
			toast.error('Vault address is required');
			return;
		}

		saving = true;
		testResult = null;

		try {
			const body: Record<string, any> = {
				address: address.trim(),
				namespace: namespace.trim() || null,
				defaultPath: defaultPath.trim() || null,
				authMethod,
				enabled,
				skipTlsVerify
			};

			// Handle token auth
			if (authMethod === 'token') {
				if (token && token !== '***') {
					body.token = token;
				} else if (hasExistingToken) {
					body.keepExistingToken = true;
				}
			}

			// Handle AppRole auth
			if (authMethod === 'approle') {
				body.roleId = roleId.trim();
				if (secretId && secretId !== '***') {
					body.secretId = secretId;
				} else if (hasExistingSecretId) {
					body.keepExistingSecretId = true;
				}
			}

			// Handle Kubernetes auth
			if (authMethod === 'kubernetes') {
				body.kubeRole = kubeRole.trim();
			}

			const response = await fetch('/api/vault/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			if (response.ok) {
				const data: VaultConfig = await response.json();
				hasExistingToken = data.hasToken || false;
				hasExistingSecretId = data.hasSecretId || false;

				// Update placeholders
				if (hasExistingToken && (!token || token === '***')) token = '***';
				if (hasExistingSecretId && (!secretId || secretId === '***')) secretId = '***';

				toast.success('Vault configuration saved');
			} else {
				const data = await response.json();
				toast.error(data.error || 'Failed to save configuration');
			}
		} catch (error) {
			console.error('Failed to save Vault config:', error);
			toast.error('Failed to save configuration');
		} finally {
			saving = false;
		}
	}

	async function testConnection() {
		testing = true;
		testResult = null;

		try {
			const body: Record<string, any> = {
				address: address.trim(),
				namespace: namespace.trim() || undefined,
				defaultPath: defaultPath.trim() || undefined,
				authMethod,
				skipTlsVerify
			};

			// Handle auth credentials
			if (authMethod === 'token') {
				if (token && token !== '***') {
					body.token = token;
				} else if (hasExistingToken) {
					body.keepExistingToken = true;
				}
			}

			if (authMethod === 'approle') {
				body.roleId = roleId.trim();
				if (secretId && secretId !== '***') {
					body.secretId = secretId;
				} else if (hasExistingSecretId) {
					body.keepExistingSecretId = true;
				}
			}

			if (authMethod === 'kubernetes') {
				body.kubeRole = kubeRole.trim();
			}

			const response = await fetch('/api/vault/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			testResult = await response.json();

			if (testResult?.success) {
				toast.success(`Connected to Vault${testResult.version ? ` (v${testResult.version})` : ''}`);
			} else {
				toast.error(testResult?.error || 'Connection failed');
			}
		} catch (error) {
			console.error('Failed to test Vault connection:', error);
			testResult = { success: false, error: 'Connection test failed' };
			toast.error('Connection test failed');
		} finally {
			testing = false;
		}
	}

	onMount(() => {
		fetchConfig();
	});
</script>

<div class="p-4 space-y-6">
	<!-- Header -->
	<Card.Root>
		<Card.Header>
			<div class="flex items-center gap-3">
				<div class="p-2 rounded-lg bg-primary/10">
					<KeyRound class="w-5 h-5 text-primary" />
				</div>
				<div>
					<Card.Title>HashiCorp Vault Integration</Card.Title>
					<Card.Description>
						Configure Vault to automatically sync secrets for Git stacks
					</Card.Description>
				</div>
			</div>
		</Card.Header>
	</Card.Root>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="w-6 h-6 animate-spin text-muted-foreground" />
		</div>
	{:else}
		<!-- Configuration Form -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center justify-between">
					<Card.Title class="text-base">Connection Settings</Card.Title>
					<div class="flex items-center gap-2">
						<Label for="vault-enabled" class="text-sm">Enabled</Label>
						<Switch
							id="vault-enabled"
							checked={enabled}
							onCheckedChange={(v) => (enabled = v)}
							disabled={!canEdit}
						/>
					</div>
				</div>
			</Card.Header>
			<Card.Content class="space-y-4">
				<!-- Vault Address -->
				<div class="space-y-2">
					<Label for="vault-address">Vault Address</Label>
					<Input
						id="vault-address"
						type="url"
						placeholder="https://vault.example.com:8200"
						bind:value={address}
						disabled={!canEdit}
					/>
					<p class="text-xs text-muted-foreground">
						The URL of your HashiCorp Vault server
					</p>
				</div>

				<!-- Namespace (optional) -->
				<div class="space-y-2">
					<Label for="vault-namespace">Namespace (optional)</Label>
					<Input
						id="vault-namespace"
						placeholder="my-namespace"
						bind:value={namespace}
						disabled={!canEdit}
					/>
					<p class="text-xs text-muted-foreground">
						Vault Enterprise namespace (leave empty for OSS Vault)
					</p>
				</div>

				<!-- Default Path -->
				<div class="space-y-2">
					<Label for="vault-path">Default Secret Path</Label>
					<Input
						id="vault-path"
						placeholder="secret/data"
						bind:value={defaultPath}
						disabled={!canEdit}
					/>
					<p class="text-xs text-muted-foreground">
						Default path prefix for KV v2 secrets engine
					</p>
				</div>

				<!-- Skip TLS Verification -->
				<div class="flex items-center justify-between p-3 rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30">
					<div class="flex items-start gap-3">
						<ShieldAlert class="w-5 h-5 text-orange-500 mt-0.5 shrink-0" />
						<div class="space-y-0.5">
							<Label for="skip-tls" class="text-sm font-medium">Accept Self-Signed Certificates</Label>
							<p class="text-xs text-muted-foreground">
								Disable TLS certificate verification. Only use for development or with trusted self-signed certificates.
							</p>
						</div>
					</div>
					<Switch
						id="skip-tls"
						checked={skipTlsVerify}
						onCheckedChange={(v) => (skipTlsVerify = v)}
						disabled={!canEdit}
					/>
				</div>
			</Card.Content>
		</Card.Root>

		<!-- Authentication -->
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-base">Authentication</Card.Title>
			</Card.Header>
			<Card.Content class="space-y-4">
				<!-- Auth Method -->
				<div class="space-y-2">
					<Label>Authentication Method</Label>
					<Select.Root
						type="single"
						value={authMethod}
						onValueChange={(v) => {
							if (v) authMethod = v as typeof authMethod;
						}}
					>
						<Select.Trigger class="w-full" disabled={!canEdit}>
							{#if authMethod === 'token'}
								Token
							{:else if authMethod === 'approle'}
								AppRole
							{:else if authMethod === 'kubernetes'}
								Kubernetes
							{/if}
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="token">Token</Select.Item>
							<Select.Item value="approle">AppRole</Select.Item>
							<Select.Item value="kubernetes">Kubernetes</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>

				<!-- Token Auth -->
				{#if authMethod === 'token'}
					<div class="space-y-2">
						<Label for="vault-token">Vault Token</Label>
						<Input
							id="vault-token"
							type="password"
							placeholder={hasExistingToken ? '••••••••' : 'hvs.xxxxx...'}
							bind:value={token}
							disabled={!canEdit}
						/>
						{#if hasExistingToken}
							<p class="text-xs text-muted-foreground">
								Token is configured. Enter a new value to replace it.
							</p>
						{/if}
					</div>
				{/if}

				<!-- AppRole Auth -->
				{#if authMethod === 'approle'}
					<div class="space-y-2">
						<Label for="vault-role-id">Role ID</Label>
						<Input
							id="vault-role-id"
							placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
							bind:value={roleId}
							disabled={!canEdit}
						/>
					</div>
					<div class="space-y-2">
						<Label for="vault-secret-id">Secret ID</Label>
						<Input
							id="vault-secret-id"
							type="password"
							placeholder={hasExistingSecretId ? '••••••••' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
							bind:value={secretId}
							disabled={!canEdit}
						/>
						{#if hasExistingSecretId}
							<p class="text-xs text-muted-foreground">
								Secret ID is configured. Enter a new value to replace it.
							</p>
						{/if}
					</div>
				{/if}

				<!-- Kubernetes Auth -->
				{#if authMethod === 'kubernetes'}
					<div class="space-y-2">
						<Label for="vault-kube-role">Kubernetes Role</Label>
						<Input
							id="vault-kube-role"
							placeholder="dockhand-role"
							bind:value={kubeRole}
							disabled={!canEdit}
						/>
						<p class="text-xs text-muted-foreground">
							The Vault role configured for Kubernetes auth. Dockhand will use the service account token from the pod.
						</p>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<!-- Actions -->
		{#if canEdit}
			<div class="flex items-center gap-3">
				<Button onclick={testConnection} variant="outline" disabled={testing || !address}>
					{#if testing}
						<Loader2 class="w-4 h-4 mr-2 animate-spin" />
						Testing...
					{:else}
						<TestTube2 class="w-4 h-4 mr-2" />
						Test Connection
					{/if}
				</Button>

				<Button onclick={saveConfig} disabled={saving || !address}>
					{#if saving}
						<Loader2 class="w-4 h-4 mr-2 animate-spin" />
						Saving...
					{:else}
						<Save class="w-4 h-4 mr-2" />
						Save Configuration
					{/if}
				</Button>

				{#if testResult}
					<div class="flex items-center gap-2 ml-auto">
						{#if testResult.success}
							<Badge variant="default" class="bg-green-600">
								<Check class="w-3 h-3 mr-1" />
								Connected
								{#if testResult.version}
									(v{testResult.version})
								{/if}
							</Badge>
						{:else}
							<Badge variant="destructive">
								<X class="w-3 h-3 mr-1" />
								Failed
							</Badge>
						{/if}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Usage Info -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center gap-2">
					<Info class="w-4 h-4 text-muted-foreground" />
					<Card.Title class="text-base">How to Use</Card.Title>
				</div>
			</Card.Header>
			<Card.Content class="space-y-3 text-sm text-muted-foreground">
				<p>
					Add a <code class="px-1 py-0.5 bg-muted rounded text-foreground">.secrets.yaml</code> file to your Git stack repository to define which secrets to fetch from Vault:
				</p>
				<pre class="p-3 bg-muted rounded-lg text-xs overflow-x-auto"><code>{`# .secrets.yaml

secrets:
  # 1. Simple: Env var name = Vault key name
  - ADMIN_PASSWORD

  # 2. Mapping: Different Vault key name
  - name: DATABASE_URL
    key: db_connection_string

  # 3. Override path + key for specific secret
  - name: SHARED_API_KEY
    path: kv/data/shared/api
    key: api_key

# Optional: Override default path for this stack
# (uses "Default Secret Path" from settings if omitted)
# vault:
#   path: kv/data/myapp`}</code></pre>
				<p>
					Secrets are automatically synced when Git stacks are deployed. You can also manually sync secrets from the stack's environment variables page.
				</p>
			</Card.Content>
		</Card.Root>
	{/if}
</div>
