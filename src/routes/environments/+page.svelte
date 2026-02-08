<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import {
		Globe,
		Plus,
		Trash2,
		Pencil,
		Check,
		RefreshCw,
		Wifi,
		WifiOff,
		Lock,
		Unlock
	} from 'lucide-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	interface Environment {
		id: number;
		name: string;
		host?: string;
		port?: number;
		protocol?: string;
		tlsCa?: string;
		tlsCert?: string;
		tlsKey?: string;
		socketPath?: string;
		connectionType?: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge';
		createdAt: string;
		updatedAt: string;
	}

	interface TestResult {
		success: boolean;
		error?: string;
		info?: {
			serverVersion: string;
			containers: number;
			images: number;
			name: string;
		};
	}

	let environments = $state<Environment[]>([]);
	let loading = $state(true);
	let showAddModal = $state(false);
	let showEditModal = $state(false);
	let editingEnv = $state<Environment | null>(null);
	let testResults = $state<{ [id: number]: TestResult | 'testing' }>({});

	// Form state
	let formName = $state('');
	let formHost = $state('');
	let formPort = $state(2375);
	let formProtocol = $state('http');
	let formTlsCa = $state('');
	let formTlsCert = $state('');
	let formTlsKey = $state('');
	let formError = $state('');
	let formSaving = $state(false);
	let quickUrl = $state('');

	async function fetchEnvironments() {
		loading = true;
		try {
			const response = await fetch('/api/environments');
			environments = await response.json();
		} catch (error) {
			console.error('Failed to fetch environments:', error);
		} finally {
			loading = false;
		}
	}

	function resetForm() {
		formName = '';
		formHost = '';
		formPort = 2375;
		formProtocol = 'http';
		formTlsCa = '';
		formTlsCert = '';
		formTlsKey = '';
		formError = '';
		formSaving = false;
		quickUrl = '';
	}

	function parseDockerUrl(url: string) {
		try {
			const urlObj = new URL(url);
			formProtocol = urlObj.protocol.replace(':', '');
			formHost = urlObj.hostname;
			formPort = urlObj.port ? parseInt(urlObj.port) : (formProtocol === 'https' ? 2376 : 2375);
		} catch (e) {
			// If not a valid URL, try to extract host:port
			const match = url.match(/^(?:(\w+):\/\/)?([^:]+)(?::(\d+))?$/);
			if (match) {
				formProtocol = match[1] || 'http';
				formHost = match[2];
				formPort = match[3] ? parseInt(match[3]) : 2375;
			}
		}
	}

	function openAddModal() {
		resetForm();
		showAddModal = true;
	}

	function openEditModal(env: Environment) {
		editingEnv = env;
		formName = env.name;
		formHost = env.host;
		formPort = env.port;
		formProtocol = env.protocol;
		formTlsCa = env.tlsCa || '';
		formTlsCert = env.tlsCert || '';
		formTlsKey = env.tlsKey || '';
		formError = '';
		formSaving = false;
		showEditModal = true;
	}

	async function createEnvironment() {
		if (!formName.trim() || !formHost.trim()) {
			formError = 'Name and host are required';
			return;
		}

		formSaving = true;
		formError = '';

		try {
			const response = await fetch('/api/environments', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: formName.trim(),
					host: formHost.trim(),
					port: formPort,
					protocol: formProtocol,
					tlsCa: formTlsCa || undefined,
					tlsCert: formTlsCert || undefined,
					tlsKey: formTlsKey || undefined
				})
			});

			if (response.ok) {
				showAddModal = false;
				await fetchEnvironments();
			} else {
				const data = await response.json();
				formError = data.error || 'Failed to create environment';
			}
		} catch (error) {
			formError = 'Failed to create environment';
		} finally {
			formSaving = false;
		}
	}

	async function updateEnvironment() {
		if (!editingEnv || !formName.trim() || !formHost.trim()) {
			formError = 'Name and host are required';
			return;
		}

		formSaving = true;
		formError = '';

		try {
			const response = await fetch(`/api/environments/${editingEnv.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: formName.trim(),
					host: formHost.trim(),
					port: formPort,
					protocol: formProtocol,
					tlsCa: formTlsCa || undefined,
					tlsCert: formTlsCert || undefined,
					tlsKey: formTlsKey || undefined
				})
			});

			if (response.ok) {
				showEditModal = false;
				editingEnv = null;
				await fetchEnvironments();
			} else {
				const data = await response.json();
				formError = data.error || 'Failed to update environment';
			}
		} catch (error) {
			formError = 'Failed to update environment';
		} finally {
			formSaving = false;
		}
	}

	async function deleteEnvironment(id: number) {
		if (!confirm('Are you sure you want to delete this environment?')) return;

		try {
			const response = await fetch(`/api/environments/${id}`, {
				method: 'DELETE'
			});

			if (response.ok) {
				await fetchEnvironments();
			} else {
				const data = await response.json();
				alert(data.error || 'Failed to delete environment');
			}
		} catch (error) {
			alert('Failed to delete environment');
		}
	}

	async function testConnection(id: number) {
		testResults[id] = 'testing';
		testResults = { ...testResults };

		try {
			const response = await fetch(`/api/environments/${id}/test`, {
				method: 'POST'
			});
			const result = await response.json();
			testResults[id] = result;
		} catch (error) {
			testResults[id] = { success: false, error: 'Connection failed' };
		}
		testResults = { ...testResults };
	}

	onMount(() => {
		fetchEnvironments();
	});
</script>

<div class="space-y-4">
	<div class="shrink-0 flex flex-wrap justify-between items-center gap-3 min-h-8">
		<PageHeader icon={Globe} title="Environments">
			<Badge variant="secondary" class="text-xs">{environments.length} total</Badge>
		</PageHeader>
		<div class="flex gap-2">
			<Button size="sm" onclick={openAddModal}>
				<Plus class="w-4 h-4" />
				Add environment
			</Button>
			<Button size="sm" variant="outline" onclick={fetchEnvironments}>Refresh</Button>
		</div>
	</div>

	{#if loading && environments.length === 0}
		<p class="text-muted-foreground text-sm">Loading environments...</p>
	{:else if environments.length === 0}
		<p class="text-muted-foreground text-sm">No environments found</p>
	{:else}
		<div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each environments as env (env.id)}
				{@const testResult = testResults[env.id]}
				<Card.Root>
					<Card.Header class="pb-2">
						<div class="flex items-start justify-between">
							<div class="flex items-center gap-2">
								<Globe class="w-5 h-5 text-muted-foreground" />
								<Card.Title class="text-base">{env.name}</Card.Title>
							</div>
						</div>
					</Card.Header>
					<Card.Content class="space-y-3">
						<div class="text-sm text-muted-foreground">
							{#if env.connectionType === 'socket' || !env.connectionType}
								<span>{env.socketPath || '/var/run/docker.sock'}</span>
							{:else if env.connectionType === 'hawser-edge'}
								<span>Edge connection (outbound)</span>
							{:else}
								<span>{env.protocol || 'http'}://{env.host}:{env.port || 2375}</span>
							{/if}
						</div>

						{#if testResult}
							<div class="text-sm">
								{#if testResult === 'testing'}
									<div class="flex items-center gap-2 text-muted-foreground">
										<RefreshCw class="w-4 h-4 animate-spin" />
										<span>Testing connection...</span>
									</div>
								{:else if testResult.success}
									<div class="flex items-center gap-2 text-green-600 dark:text-green-400">
										<Wifi class="w-4 h-4" />
										<span>Connected</span>
									</div>
									{#if testResult.info}
										<div class="mt-2 text-xs text-muted-foreground space-y-0.5">
											<div>Host: {testResult.info.name}</div>
											<div>Docker: {testResult.info.serverVersion}</div>
											<div>Containers: {testResult.info.containers} | Images: {testResult.info.images}</div>
										</div>
									{/if}
								{:else}
									<div class="flex items-center gap-2 text-red-600 dark:text-red-400">
										<WifiOff class="w-4 h-4" />
										<span>Failed</span>
									</div>
									{#if testResult.error}
										<div class="mt-1 text-xs text-muted-foreground">{testResult.error}</div>
									{/if}
								{/if}
							</div>
						{/if}

						<div class="flex gap-2 pt-2">
							<Button
								variant="outline"
								size="sm"
								onclick={() => testConnection(env.id)}
								disabled={testResult === 'testing'}
							>
								{#if testResult === 'testing'}
									<RefreshCw class="w-3 h-3 mr-1 animate-spin" />
								{:else}
									<Wifi class="w-3 h-3" />
								{/if}
								Test
							</Button>
							<Button
								variant="outline"
								size="sm"
								onclick={() => openEditModal(env)}
							>
								<Pencil class="w-3 h-3" />
							</Button>
							<Button
									variant="outline"
									size="sm"
									onclick={() => deleteEnvironment(env.id)}
								>
									<Trash2 class="w-3 h-3 text-destructive" />
								</Button>
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

<!-- Add Environment Modal -->
<Dialog.Root bind:open={showAddModal}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Add environment</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			{#if formError}
				<div class="text-sm text-red-600 dark:text-red-400">{formError}</div>
			{/if}

			<!-- Quick URL parser -->
			<div class="space-y-2 pb-3 border-b">
				<Label for="quick-url">Quick URL (optional)</Label>
				<div class="flex gap-2">
					<Input
						id="quick-url"
						bind:value={quickUrl}
						placeholder="http://192.168.1.4:2375 or https://docker.example.com:2376"
						class="flex-1"
					/>
					<Button
						variant="secondary"
						size="sm"
						onclick={() => parseDockerUrl(quickUrl)}
						disabled={!quickUrl.trim()}
					>
						Parse
					</Button>
				</div>
				<p class="text-xs text-muted-foreground">
					Paste a full Docker URL to auto-fill the fields below
				</p>
			</div>

			<div class="space-y-2">
				<Label for="name">Name</Label>
				<Input id="name" bind:value={formName} placeholder="Production server" />
			</div>
			<div class="space-y-2">
				<Label for="host">Host</Label>
				<Input id="host" bind:value={formHost} placeholder="192.168.1.100 or docker.example.com" />
			</div>
			<div class="grid grid-cols-2 gap-4">
				<div class="space-y-2">
					<Label for="port">Port</Label>
					<Input id="port" type="number" bind:value={formPort} />
				</div>
				<div class="space-y-2">
					<Label for="protocol">Protocol</Label>
					<Select.Root type="single" bind:value={formProtocol}>
						<Select.Trigger class="w-full h-9">
							{#if formProtocol === 'https'}
								<Lock class="w-4 h-4 mr-2 text-muted-foreground" />
							{:else}
								<Unlock class="w-4 h-4 mr-2 text-muted-foreground" />
							{/if}
							<span>{formProtocol === 'https' ? 'HTTPS (TLS)' : 'HTTP'}</span>
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="http" label="HTTP">
								<Unlock class="w-4 h-4 mr-2 text-muted-foreground" />
								HTTP
							</Select.Item>
							<Select.Item value="https" label="HTTPS (TLS)">
								<Lock class="w-4 h-4 mr-2 text-muted-foreground" />
								HTTPS (TLS)
							</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>
			{#if formProtocol === 'https'}
				<div class="space-y-4 pt-2 border-t">
					<p class="text-xs text-muted-foreground">TLS certificates (optional)</p>
					<div class="space-y-2">
						<Label for="tls_ca">CA certificate</Label>
						<textarea
							id="tls_ca"
							bind:value={formTlsCa}
							placeholder="-----BEGIN CERTIFICATE-----"
							class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						></textarea>
					</div>
					<div class="space-y-2">
						<Label for="tls_cert">Client certificate</Label>
						<textarea
							id="tls_cert"
							bind:value={formTlsCert}
							placeholder="-----BEGIN CERTIFICATE-----"
							class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						></textarea>
					</div>
					<div class="space-y-2">
						<Label for="tls_key">Client key</Label>
						<textarea
							id="tls_key"
							bind:value={formTlsKey}
							placeholder="-----BEGIN RSA PRIVATE KEY-----"
							class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						></textarea>
					</div>
				</div>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (showAddModal = false)}>Cancel</Button>
			<Button onclick={createEnvironment} disabled={formSaving}>
				{#if formSaving}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else}
					<Plus class="w-4 h-4" />
				{/if}
				Add
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Edit Environment Modal -->
<Dialog.Root bind:open={showEditModal}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Edit environment</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4">
			{#if formError}
				<div class="text-sm text-red-600 dark:text-red-400">{formError}</div>
			{/if}

			<!-- Quick URL parser -->
			<div class="space-y-2 pb-3 border-b">
				<Label for="edit-quick-url">Quick URL (optional)</Label>
				<div class="flex gap-2">
					<Input
						id="edit-quick-url"
						bind:value={quickUrl}
						placeholder="http://192.168.1.4:2375 or https://docker.example.com:2376"
						class="flex-1"
					/>
					<Button
						variant="secondary"
						size="sm"
						onclick={() => parseDockerUrl(quickUrl)}
						disabled={!quickUrl.trim()}
					>
						Parse
					</Button>
				</div>
				<p class="text-xs text-muted-foreground">
					Paste a full Docker URL to auto-fill the fields below
				</p>
			</div>

			<div class="space-y-2">
				<Label for="edit-name">Name</Label>
				<Input id="edit-name" bind:value={formName} placeholder="Production server" />
			</div>
			<div class="space-y-2">
				<Label for="edit-host">Host</Label>
				<Input id="edit-host" bind:value={formHost} placeholder="192.168.1.100" />
			</div>
			<div class="grid grid-cols-2 gap-4">
				<div class="space-y-2">
					<Label for="edit-port">Port</Label>
					<Input id="edit-port" type="number" bind:value={formPort} />
				</div>
				<div class="space-y-2">
					<Label for="edit-protocol">Protocol</Label>
					<Select.Root type="single" bind:value={formProtocol}>
						<Select.Trigger class="w-full h-9">
							{#if formProtocol === 'https'}
								<Lock class="w-4 h-4 mr-2 text-muted-foreground" />
							{:else}
								<Unlock class="w-4 h-4 mr-2 text-muted-foreground" />
							{/if}
							<span>{formProtocol === 'https' ? 'HTTPS (TLS)' : 'HTTP'}</span>
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="http" label="HTTP">
								<Unlock class="w-4 h-4 mr-2 text-muted-foreground" />
								HTTP
							</Select.Item>
							<Select.Item value="https" label="HTTPS (TLS)">
								<Lock class="w-4 h-4 mr-2 text-muted-foreground" />
								HTTPS (TLS)
							</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>
			{#if formProtocol === 'https'}
				<div class="space-y-4 pt-2 border-t">
					<p class="text-xs text-muted-foreground">TLS certificates (optional)</p>
					<div class="space-y-2">
						<Label for="edit-tls_ca">CA certificate</Label>
						<textarea
							id="edit-tls_ca"
							bind:value={formTlsCa}
							placeholder="-----BEGIN CERTIFICATE-----"
							class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						></textarea>
					</div>
					<div class="space-y-2">
						<Label for="edit-tls_cert">Client certificate</Label>
						<textarea
							id="edit-tls_cert"
							bind:value={formTlsCert}
							placeholder="-----BEGIN CERTIFICATE-----"
							class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						></textarea>
					</div>
					<div class="space-y-2">
						<Label for="edit-tls_key">Client key</Label>
						<textarea
							id="edit-tls_key"
							bind:value={formTlsKey}
							placeholder="-----BEGIN RSA PRIVATE KEY-----"
							class="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						></textarea>
					</div>
				</div>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => { showEditModal = false; editingEnv = null; }}>Cancel</Button>
			<Button onclick={updateEnvironment} disabled={formSaving}>
				{#if formSaving}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else}
					<Check class="w-4 h-4" />
				{/if}
				Save
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
