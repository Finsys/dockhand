<script lang="ts" module>
	type KeyValue = { key: string; value: string };
</script>

<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Plus, Trash2, HardDrive, Database, Server, ChevronDown } from 'lucide-svelte';

	const VOLUME_DRIVERS = [
		{ value: 'local', label: 'Local', description: m.volumes_create_driver_local_description(), icon: HardDrive },
		{ value: 'nfs', label: 'NFS', description: m.volumes_create_driver_nfs_description(), icon: Server },
		{ value: 'cifs', label: 'CIFS', description: m.volumes_create_driver_cifs_description(), icon: Database }
	];

	const SMB_VERSIONS = [
		{ value: '2.0', label: 'SMB 2.0' },
		{ value: '2.1', label: 'SMB 2.1' },
		{ value: '3.0', label: 'SMB 3.0' },
		{ value: '3.1.1', label: 'SMB 3.1.1' }
	];

	const NFS_VERSIONS = [
		{ value: '3', label: 'NFSv3' },
		{ value: '4', label: 'NFSv4' },
		{ value: '4.1', label: 'NFSv4.1' },
		{ value: '4.2', label: 'NFSv4.2' }
	];

	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { focusFirstInput } from '$lib/utils';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		onClose?: () => void;
		onSuccess?: () => void;
	}

	let { open = $bindable(), onClose, onSuccess }: Props = $props();

	// Form state
	let name = $state('');
	let driver = $state('local');
	let driverOpts = $state<KeyValue[]>([]);
	let labels = $state<KeyValue[]>([]);

	// CIFS fields
	let cifsServer = $state('');
	let cifsShare = $state('');
	let cifsUsername = $state('');
	let cifsPassword = $state('');
	let cifsVersion = $state('3.0');
	let cifsDomain = $state('');

	// NFS fields
	let nfsServer = $state('');
	let nfsPath = $state('');
	let nfsVersion = $state('4');
	let nfsSoft = $state(true);
	let nfsNolock = $state(true);
	let nfsReadOnly = $state(false);

	// Additional options visibility
	let showAdditionalOpts = $state(false);

	let creating = $state(false);
	let error = $state('');
	let errors = $state<{ name?: string; server?: string; share?: string; path?: string }>({});

	function addDriverOpt() {
		driverOpts = [...driverOpts, { key: '', value: '' }];
	}

	function removeDriverOpt(index: number) {
		driverOpts = driverOpts.filter((_, i) => i !== index);
	}

	function addLabel() {
		labels = [...labels, { key: '', value: '' }];
	}

	function removeLabel(index: number) {
		labels = labels.filter((_, i) => i !== index);
	}

	function resetForm() {
		name = '';
		driver = 'local';
		driverOpts = [];
		labels = [];
		cifsServer = '';
		cifsShare = '';
		cifsUsername = '';
		cifsPassword = '';
		cifsVersion = '3.0';
		cifsDomain = '';
		nfsServer = '';
		nfsPath = '';
		nfsVersion = '4';
		nfsSoft = true;
		nfsNolock = true;
		nfsReadOnly = false;
		showAdditionalOpts = false;
		error = '';
		errors = {};
	}

	async function handleCreate() {
		errors = {};

		if (!name.trim()) {
			errors.name = m.volumes_create_error_name_required();
		}

		// Validate driver-specific required fields
		if (driver === 'cifs') {
			if (!cifsServer.trim()) errors.server = m.volumes_create_error_server_required();
			if (!cifsShare.trim()) errors.share = m.volumes_create_error_share_required();
		} else if (driver === 'nfs') {
			if (!nfsServer.trim()) errors.server = m.volumes_create_error_server_required();
			if (!nfsPath.trim()) errors.path = m.volumes_create_error_export_path_required();
		}

		if (Object.keys(errors).length > 0) return;

		creating = true;
		error = '';

		try {
			const envId = $currentEnvironment?.id ?? null;

			// Build driverOpts based on driver type
			const driverOptsObj: Record<string, string> = {};

			if (driver === 'cifs') {
				driverOptsObj.type = 'cifs';
				const share = cifsShare.trim().replace(/^\/+/, '');
				driverOptsObj.device = `//${cifsServer.trim()}/${share}`;
				const opts = [`addr=${cifsServer.trim()}`, `username=${cifsUsername}`, `password=${cifsPassword}`, `vers=${cifsVersion}`];
				if (cifsDomain.trim()) opts.push(`domain=${cifsDomain.trim()}`);
				// Append additional options
				driverOpts.forEach(({ key, value }) => {
					if (key && value) opts.push(`${key}=${value}`);
					else if (key) opts.push(key);
				});
				driverOptsObj.o = opts.join(',');
			} else if (driver === 'nfs') {
				driverOptsObj.type = 'nfs';
				const path = nfsPath.trim().startsWith('/') ? nfsPath.trim() : `/${nfsPath.trim()}`;
				driverOptsObj.device = `:${path}`;
				const opts = [`addr=${nfsServer.trim()}`, `nfsvers=${nfsVersion}`];
				if (nfsSoft) opts.push('soft');
				if (nfsNolock) opts.push('nolock');
				if (nfsReadOnly) opts.push('ro');
				// Append additional options
				driverOpts.forEach(({ key, value }) => {
					if (key && value) opts.push(`${key}=${value}`);
					else if (key) opts.push(key);
				});
				driverOptsObj.o = opts.join(',');
			} else {
				// Local driver - use generic key-value pairs
				driverOpts.forEach(({ key, value }) => {
					if (key && value) {
						driverOptsObj[key] = value;
					}
				});
			}

			const labelsObj: Record<string, string> = {};
			labels.forEach(({ key, value }) => {
				if (key && value) {
					labelsObj[key] = value;
				}
			});

			const response = await fetch(appendEnvParam('/api/volumes', envId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					driver: driver === 'nfs' || driver === 'cifs' ? 'local' : driver,
					driverOpts: driverOptsObj,
					labels: labelsObj
				})
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.details || data.error || m.volumes_create_error_failed());
			}

			resetForm();
			open = false;
			onSuccess?.();
		} catch (err: any) {
			error = err.message || m.volumes_create_error_failed();
			console.error('Failed to create volume:', err);
		} finally {
			creating = false;
		}
	}

	function handleOpenChange(newOpen: boolean) {
		if (!newOpen && !creating) {
			resetForm();
		}
		open = newOpen;
	}
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (isOpen) focusFirstInput(); handleOpenChange(isOpen); }}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{m.volumes_create_volume()}</Dialog.Title>
		</Dialog.Header>

		<div class="space-y-4">
			{#if error}
				<div class="text-sm text-red-600 dark:text-red-400 p-2 bg-red-50 dark:bg-red-950 rounded">
					{error}
				</div>
			{/if}

			<!-- Volume Name -->
			<div class="space-y-2">
				<Label for="volume-name">{m.volumes_create_name_label()}</Label>
				<Input
					id="volume-name"
					bind:value={name}
					placeholder="my-volume"
					disabled={creating}
					class={errors.name ? 'border-destructive focus-visible:ring-destructive' : ''}
					oninput={() => errors.name = undefined}
				/>
				{#if errors.name}
					<p class="text-xs text-destructive">{errors.name}</p>
				{/if}
			</div>

			<!-- Driver -->
			<div class="space-y-2">
				<Label for="driver">{m.volumes_driver()}</Label>
				<Select.Root type="single" bind:value={driver} disabled={creating}>
					<Select.Trigger class="w-full h-9">
						{@const selectedDriver = VOLUME_DRIVERS.find(d => d.value === driver)}
						<span class="flex items-center">
							{#if selectedDriver}
								<svelte:component this={selectedDriver.icon} class="w-4 h-4 mr-2 text-muted-foreground" />
								{selectedDriver.label}
							{:else}
								{m.volumes_create_select_driver()}
							{/if}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#each VOLUME_DRIVERS as d}
							<Select.Item value={d.value} label={d.label}>
								<svelte:component this={d.icon} class="w-4 h-4 mr-2 text-muted-foreground" />
								<div class="flex flex-col">
									<span>{d.label}</span>
									<span class="text-xs text-muted-foreground">{d.description}</span>
								</div>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<p class="text-xs text-muted-foreground">
					{m.volumes_create_driver_hint()}
				</p>
			</div>

			<!-- Driver-specific fields -->
			{#if driver === 'cifs'}
				<!-- CIFS fields -->
				<div class="grid grid-cols-2 gap-4">
					<div class="space-y-2">
						<Label for="cifs-server">{m.volumes_create_server_label()}</Label>
						<Input
							id="cifs-server"
							bind:value={cifsServer}
							placeholder="192.168.1.100"
							disabled={creating}
							class={errors.server ? 'border-destructive focus-visible:ring-destructive' : ''}
							oninput={() => errors.server = undefined}
						/>
						{#if errors.server}
							<p class="text-xs text-destructive">{errors.server}</p>
						{/if}
					</div>
					<div class="space-y-2">
						<Label for="cifs-share">{m.volumes_create_share_path_label()}</Label>
						<Input
							id="cifs-share"
							bind:value={cifsShare}
							placeholder="shared/folder"
							disabled={creating}
							class={errors.share ? 'border-destructive focus-visible:ring-destructive' : ''}
							oninput={() => errors.share = undefined}
						/>
						{#if errors.share}
							<p class="text-xs text-destructive">{errors.share}</p>
						{/if}
					</div>
				</div>
				<div class="grid grid-cols-2 gap-4">
					<div class="space-y-2">
						<Label for="cifs-username">{m.volumes_create_username()}</Label>
						<Input
							id="cifs-username"
							bind:value={cifsUsername}
							placeholder="user"
							disabled={creating}
						/>
					</div>
					<div class="space-y-2">
						<Label for="cifs-password">{m.volumes_create_password()}</Label>
						<Input
							id="cifs-password"
							type="password"
							bind:value={cifsPassword}
							placeholder="••••••••"
							disabled={creating}
						/>
					</div>
				</div>
				<div class="grid grid-cols-2 gap-4">
					<div class="space-y-2">
						<Label for="cifs-version">{m.volumes_create_smb_version()}</Label>
						<Select.Root type="single" bind:value={cifsVersion} disabled={creating}>
							<Select.Trigger class="w-full h-9">
								{SMB_VERSIONS.find(v => v.value === cifsVersion)?.label ?? m.volumes_create_select_version()}
							</Select.Trigger>
							<Select.Content>
								{#each SMB_VERSIONS as v}
									<Select.Item value={v.value} label={v.label}>{v.label}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
					<div class="space-y-2">
						<Label for="cifs-domain">{m.volumes_create_domain()}</Label>
						<Input
							id="cifs-domain"
							bind:value={cifsDomain}
							placeholder="WORKGROUP"
							disabled={creating}
						/>
						<p class="text-xs text-muted-foreground">{m.volumes_create_domain_hint()}</p>
					</div>
				</div>

				<!-- Additional options (collapsible) -->
				<div class="space-y-2">
					<button
						type="button"
						class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
						onclick={() => showAdditionalOpts = !showAdditionalOpts}
					>
						<ChevronDown class="w-3.5 h-3.5 transition-transform {showAdditionalOpts ? 'rotate-180' : ''}" />
						{m.volumes_create_additional_options()}
					</button>
					{#if showAdditionalOpts}
						<div class="space-y-2 pl-1">
							<div class="flex items-center justify-end">
								<Button type="button" size="sm" variant="outline" onclick={addDriverOpt} disabled={creating}>
									<Plus class="w-3 h-3" />
									{m.volumes_create_add_option()}
								</Button>
							</div>
							{#if driverOpts.length > 0}
								{#each driverOpts as opt, i}
									<div class="flex gap-2">
										<Input bind:value={opt.key} placeholder={m.volumes_create_key()} disabled={creating} class="flex-1" />
										<Input bind:value={opt.value} placeholder={m.volumes_create_value_optional()} disabled={creating} class="flex-1" />
										<Button type="button" size="icon" variant="ghost" onclick={() => removeDriverOpt(i)} disabled={creating}>
											<Trash2 class="w-4 h-4" />
										</Button>
									</div>
								{/each}
							{:else}
								<p class="text-xs text-muted-foreground">{m.volumes_create_extra_mount_options_hint()}</p>
							{/if}
						</div>
					{/if}
				</div>
			{:else if driver === 'nfs'}
				<!-- NFS fields -->
				<div class="grid grid-cols-2 gap-4">
					<div class="space-y-2">
						<Label for="nfs-server">{m.volumes_create_server_label()}</Label>
						<Input
							id="nfs-server"
							bind:value={nfsServer}
							placeholder="192.168.1.100"
							disabled={creating}
							class={errors.server ? 'border-destructive focus-visible:ring-destructive' : ''}
							oninput={() => errors.server = undefined}
						/>
						{#if errors.server}
							<p class="text-xs text-destructive">{errors.server}</p>
						{/if}
					</div>
					<div class="space-y-2">
						<Label for="nfs-path">{m.volumes_create_export_path_label()}</Label>
						<Input
							id="nfs-path"
							bind:value={nfsPath}
							placeholder="/exports/data"
							disabled={creating}
							class={errors.path ? 'border-destructive focus-visible:ring-destructive' : ''}
							oninput={() => errors.path = undefined}
						/>
						{#if errors.path}
							<p class="text-xs text-destructive">{errors.path}</p>
						{/if}
					</div>
				</div>
				<div class="space-y-2">
					<Label for="nfs-version">{m.volumes_create_nfs_version()}</Label>
					<Select.Root type="single" bind:value={nfsVersion} disabled={creating}>
						<Select.Trigger class="w-full max-w-[200px] h-9">
							{NFS_VERSIONS.find(v => v.value === nfsVersion)?.label ?? m.volumes_create_select_version()}
						</Select.Trigger>
						<Select.Content>
							{#each NFS_VERSIONS as v}
								<Select.Item value={v.value} label={v.label}>{v.label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
				<div class="flex items-center gap-6">
					<div class="flex items-center gap-2">
						<TogglePill bind:checked={nfsSoft} onLabel="Soft" offLabel="Hard" />
						<span class="text-xs text-muted-foreground">{m.volumes_create_nfs_mount()}</span>
					</div>
					<div class="flex items-center gap-2">
						<TogglePill bind:checked={nfsNolock} />
						<span class="text-xs text-muted-foreground">{m.volumes_create_nfs_no_lock()}</span>
					</div>
					<div class="flex items-center gap-2">
						<TogglePill bind:checked={nfsReadOnly} />
						<span class="text-xs text-muted-foreground">{m.volumes_read_only()}</span>
					</div>
				</div>

				<!-- Additional options (collapsible) -->
				<div class="space-y-2">
					<button
						type="button"
						class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
						onclick={() => showAdditionalOpts = !showAdditionalOpts}
					>
						<ChevronDown class="w-3.5 h-3.5 transition-transform {showAdditionalOpts ? 'rotate-180' : ''}" />
						{m.volumes_create_additional_options()}
					</button>
					{#if showAdditionalOpts}
						<div class="space-y-2 pl-1">
							<div class="flex items-center justify-end">
								<Button type="button" size="sm" variant="outline" onclick={addDriverOpt} disabled={creating}>
									<Plus class="w-3 h-3" />
									{m.volumes_create_add_option()}
								</Button>
							</div>
							{#if driverOpts.length > 0}
								{#each driverOpts as opt, i}
									<div class="flex gap-2">
										<Input bind:value={opt.key} placeholder={m.volumes_create_key()} disabled={creating} class="flex-1" />
										<Input bind:value={opt.value} placeholder={m.volumes_create_value_optional()} disabled={creating} class="flex-1" />
										<Button type="button" size="icon" variant="ghost" onclick={() => removeDriverOpt(i)} disabled={creating}>
											<Trash2 class="w-4 h-4" />
										</Button>
									</div>
								{/each}
							{:else}
								<p class="text-xs text-muted-foreground">{m.volumes_create_extra_mount_options_hint()}</p>
							{/if}
						</div>
					{/if}
				</div>
			{:else}
				<!-- Local driver - generic key-value options -->
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<Label>{m.volumes_driver_options()}</Label>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onclick={addDriverOpt}
							disabled={creating}
						>
							<Plus class="w-3 h-3" />
							{m.volumes_create_add_option()}
						</Button>
					</div>
					{#if driverOpts.length > 0}
						<div class="space-y-2">
							{#each driverOpts as opt, i}
								<div class="flex gap-2">
									<Input
										bind:value={opt.key}
										placeholder={m.volumes_create_key()}
										disabled={creating}
										class="flex-1"
									/>
									<Input
										bind:value={opt.value}
										placeholder={m.volumes_create_value()}
										disabled={creating}
										class="flex-1"
									/>
									<Button
										type="button"
										size="icon"
										variant="ghost"
										onclick={() => removeDriverOpt(i)}
										disabled={creating}
									>
										<Trash2 class="w-4 h-4" />
									</Button>
								</div>
							{/each}
						</div>
					{:else}
						<p class="text-xs text-muted-foreground">{m.volumes_no_driver_options()}</p>
					{/if}
				</div>
			{/if}

			<!-- Labels -->
			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<Label>{m.volumes_labels()}</Label>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onclick={addLabel}
						disabled={creating}
					>
						<Plus class="w-3 h-3" />
						{m.volumes_create_add_label()}
					</Button>
				</div>
				{#if labels.length > 0}
					<div class="space-y-2">
						{#each labels as label, i}
							<div class="flex gap-2">
								<Input
									bind:value={label.key}
									placeholder={m.volumes_create_key()}
									disabled={creating}
									class="flex-1"
								/>
								<Input
									bind:value={label.value}
									placeholder={m.volumes_create_value()}
									disabled={creating}
									class="flex-1"
								/>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									onclick={() => removeLabel(i)}
									disabled={creating}
								>
									<Trash2 class="w-4 h-4" />
								</Button>
							</div>
						{/each}
					</div>
				{:else}
					<p class="text-xs text-muted-foreground">{m.volumes_create_no_labels()}</p>
				{/if}
			</div>

			<Dialog.Footer class="pt-4">
				<Button variant="outline" onclick={() => (open = false)} disabled={creating}>
					{m.volumes_cancel()}
				</Button>
				<Button onclick={handleCreate} disabled={creating}>
					{creating ? m.volumes_create_creating() : m.volumes_create_volume()}
				</Button>
			</Dialog.Footer>
		</div>
	</Dialog.Content>
</Dialog.Root>
