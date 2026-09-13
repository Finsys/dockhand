<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Plus, Check, RefreshCw, Mail, Zap, Send, CheckCircle2, XCircle, Bell, HelpCircle, Settings } from 'lucide-svelte';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { toast } from 'svelte-sonner';
	import { focusFirstInput } from '$lib/utils';

	// System-only events (configured at channel level, not per-environment)
	const SYSTEM_EVENTS = [
		{ id: 'license_expiring', label: 'License expiring', description: 'Enterprise license expiring soon' },
		{ id: 'repo_prune_success', label: 'Backup repository prune success', description: 'Scheduled repository prune completed successfully' },
		{ id: 'repo_prune_failed', label: 'Backup repository prune failed', description: 'Scheduled repository prune failed' },
		{ id: 'repo_check_success', label: 'Backup repository check success', description: 'Scheduled integrity check completed successfully' },
		{ id: 'repo_check_failed', label: 'Backup repository check failed', description: 'Scheduled integrity check found errors or failed' },
		{ id: 'repo_verify_success', label: 'Backup repository data verification success', description: 'Scheduled data verification completed successfully' },
		{ id: 'repo_verify_failed', label: 'Backup repository data verification failed', description: 'Scheduled data verification found corruption or failed' }
	] as const;

	export interface NotificationSetting {
		id: number;
		name: string;
		type: 'smtp' | 'apprise';
		enabled: boolean;
		config: Record<string, any>;
		eventTypes: string[];
		createdAt: string;
	}

	interface Props {
		open: boolean;
		notification?: NotificationSetting | null;
		onClose: () => void;
		onSaved: () => void;
	}

	let { open = $bindable(), notification = null, onClose, onSaved }: Props = $props();

	const isEditing = $derived(notification !== null);

	// Form state
	let formType = $state<'smtp' | 'apprise'>('smtp');
	let formName = $state('');
	let formEnabled = $state(true);
	// SMTP specific
	let formSmtpHost = $state('');
	let formSmtpPort = $state(587);
	let formSmtpSecure = $state(false);
	let formSmtpSkipTlsVerify = $state(false);
	let formSmtpUsername = $state('');
	let formSmtpPassword = $state('');
	let formSmtpFromEmail = $state('');
	let formSmtpFromName = $state('');
	let formSmtpToEmails = $state('');
	// Apprise specific
	let formAppriseUrls = $state('');
	// System events
	let formSystemEvents = $state<string[]>([]);
	let activeTab = $state<'channel' | 'events'>('channel');
	let formError = $state('');
	let formSaving = $state(false);
	let formTesting = $state(false);
	let testResult = $state<'idle' | 'success' | 'error'>('idle');
	let initializedForId = $state<number | null>(null);

	function resetForm() {
		formType = 'smtp';
		formName = '';
		formEnabled = true;
		formSmtpHost = '';
		formSmtpPort = 587;
		formSmtpSecure = false;
		formSmtpSkipTlsVerify = false;
		formSmtpUsername = '';
		formSmtpPassword = '';
		formSmtpFromEmail = '';
		formSmtpFromName = '';
		formSmtpToEmails = '';
		formAppriseUrls = '';
		formSystemEvents = [];
		activeTab = 'channel';
		formError = '';
		formSaving = false;
		formTesting = false;
		testResult = 'idle';
	}

	// Initialize form when notification changes or modal opens
	$effect(() => {
		if (open) {
			if (notification) {
				// Only initialize if this is a different notification than before
				if (initializedForId === notification.id) return;
				initializedForId = notification.id;

				formType = notification.type;
				formName = notification.name;
				formEnabled = notification.enabled;

				if (notification.type === 'smtp') {
					formSmtpHost = notification.config.host || '';
					formSmtpPort = notification.config.port || 587;
					formSmtpSecure = notification.config.secure || false;
					formSmtpSkipTlsVerify = notification.config.skipTlsVerify || false;
					formSmtpUsername = notification.config.username || '';
					formSmtpPassword = '';
					formSmtpFromEmail = notification.config.from_email || '';
					formSmtpFromName = notification.config.from_name || '';
					formSmtpToEmails = notification.config.to_emails?.join(', ') || '';
				} else {
					formAppriseUrls = notification.config.urls?.join('\n') || '';
				}

				// Load system events (filter to only system-scoped events)
				const systemEventIds = SYSTEM_EVENTS.map(e => e.id);
				formSystemEvents = (notification.eventTypes || []).filter(e => systemEventIds.includes(e as typeof SYSTEM_EVENTS[number]['id']));
				activeTab = 'channel';

				formError = '';
				formSaving = false;
			} else {
				// New notification - only reset if we haven't already
				if (initializedForId !== -1) {
					initializedForId = -1; // Use -1 to mark "new notification" mode
					resetForm();
				}
			}
		} else {
			// Modal closed - reset the guard so next open will initialize
			initializedForId = null;
		}
	});

	function getFormConfig() {
		if (formType === 'smtp') {
			return {
				host: formSmtpHost.trim(),
				port: formSmtpPort,
				secure: formSmtpSecure,
				skipTlsVerify: formSmtpSkipTlsVerify || undefined,
				username: formSmtpUsername.trim() || undefined,
				password: formSmtpPassword || undefined,
				from_email: formSmtpFromEmail.trim(),
				from_name: formSmtpFromName.trim() || undefined,
				to_emails: formSmtpToEmails.split(',').map(e => e.trim()).filter(Boolean)
			};
		} else {
			return {
				urls: formAppriseUrls.split('\n').map(u => u.trim()).filter(Boolean)
			};
		}
	}

	function validateConfig(): string | null {
		const config = getFormConfig();
		if (formType === 'smtp') {
			if (!config.host || !config.from_email || !config.to_emails?.length) {
				return 'Host, from email, and at least one recipient are required';
			}
		} else {
			if (!config.urls?.length) {
				return 'At least one webhook URL is required';
			}
		}
		return null;
	}

	async function testConfig() {
		const validationError = validateConfig();
		if (validationError) {
			formError = validationError;
			return;
		}

		formTesting = true;
		formError = '';
		testResult = 'idle';

		try {
			// When editing with no password entered, use stored credentials via [id]/test
			// to avoid sending blank password and getting "Missing credentials" from SMTP server
			const useStoredCredentials = isEditing && formType === 'smtp' && !formSmtpPassword && notification?.id;

			let response: Response;
			if (useStoredCredentials) {
				response = await fetch(`/api/notifications/${notification!.id}/test`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' }
				});
			} else {
				const config = getFormConfig();
				response = await fetch('/api/notifications/test', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						type: formType,
						name: formName.trim() || 'Test',
						config
					})
				});
			}

			const data = await response.json();

			if (data.success) {
				testResult = 'success';
				toast.success('Test notification sent successfully');
				setTimeout(() => { testResult = 'idle'; }, 3000);
			} else {
				testResult = 'error';
				formError = data.error || 'Failed to send test notification';
				setTimeout(() => { testResult = 'idle'; }, 3000);
			}
		} catch {
			testResult = 'error';
			formError = 'Failed to test notification';
			setTimeout(() => { testResult = 'idle'; }, 3000);
		} finally {
			formTesting = false;
		}
	}

	async function save() {
		if (!formName.trim()) {
			formError = 'Name is required';
			return;
		}

		const config = getFormConfig();
		if (formType === 'smtp') {
			if (!config.host || !config.from_email || !config.to_emails?.length) {
				formError = 'Host, from email, and at least one recipient are required';
				return;
			}
		} else {
			if (!config.urls?.length) {
				formError = 'At least one webhook URL is required';
				return;
			}
		}

		formSaving = true;
		formError = '';

		try {
			const url = isEditing ? `/api/notifications/${notification!.id}` : '/api/notifications';
			const method = isEditing ? 'PUT' : 'POST';

			const body: Record<string, any> = {
				name: formName.trim(),
				enabled: formEnabled,
				config,
				eventTypes: formSystemEvents
			};

			// Only include type for new notifications
			if (!isEditing) {
				body.type = formType;
			}

			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			if (response.ok) {
				open = false;
				onSaved();
			} else {
				const data = await response.json();
				formError = data.error || `Failed to ${isEditing ? 'update' : 'create'} notification`;
			}
		} catch {
			formError = `Failed to ${isEditing ? 'update' : 'create'} notification`;
		} finally {
			formSaving = false;
		}
	}

	function handleClose() {
		open = false;
		onClose();
	}

	function toggleSystemEvent(eventId: string, checked: boolean) {
		if (checked) {
			formSystemEvents = [...formSystemEvents, eventId];
		} else {
			formSystemEvents = formSystemEvents.filter(e => e !== eventId);
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) { formError = ''; focusFirstInput(); } }}>
	<Dialog.Content class="max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
		<Dialog.Header>
			<Dialog.Title>{isEditing ? 'Edit' : 'Add'} notification channel</Dialog.Title>
		</Dialog.Header>

		{#if formError}
			<div class="text-sm text-red-600 dark:text-red-400">{formError}</div>
		{/if}

		<Tabs.Root bind:value={activeTab} class="flex-1 flex flex-col overflow-hidden mt-2">
			<Tabs.List class="flex-shrink-0 mb-0 w-full grid grid-cols-2">
				<Tabs.Trigger value="channel" class="flex items-center justify-center gap-1.5">
					<Settings class="w-3.5 h-3.5" />
					Channel
				</Tabs.Trigger>
				<Tabs.Trigger value="events" class="flex items-center justify-center gap-1.5">
					<Bell class="w-3.5 h-3.5" />
					System events
					{#if formSystemEvents.length > 0}
						<Badge variant="secondary" class="ml-1 h-4 px-1.5 text-[10px]">{formSystemEvents.length}</Badge>
					{/if}
				</Tabs.Trigger>
			</Tabs.List>

			<div class="overflow-y-auto pb-4 pr-2 h-[530px]">
				<Tabs.Content value="channel" class="space-y-4 mt-0">
			<div class="grid grid-cols-2 gap-4">
				<div class="space-y-2">
					<Label for="notif-name">Name *</Label>
					<Input id="notif-name" bind:value={formName} placeholder="My notification channel" />
				</div>
				<div class="space-y-2">
					<Label>Type</Label>
					{#if isEditing}
						<Badge variant="secondary" class="h-9 flex items-center justify-center">
							{formType === 'smtp' ? 'SMTP (Email)' : 'Webhooks'}
						</Badge>
					{:else}
						<Select.Root
							type="single"
							value={formType}
							onValueChange={(v) => formType = v as 'smtp' | 'apprise'}
						>
							<Select.Trigger class="w-full">
								<span class="flex items-center gap-2">
									{#if formType === 'smtp'}
										<Mail class="w-4 h-4" />SMTP (Email)
									{:else}
										<Zap class="w-4 h-4" />Webhooks
									{/if}
								</span>
							</Select.Trigger>
							<Select.Content>
								<Select.Item value="smtp">
									<span class="flex items-center gap-2"><Mail class="w-4 h-4" />SMTP (Email)</span>
								</Select.Item>
								<Select.Item value="apprise">
									<span class="flex items-center gap-2"><Zap class="w-4 h-4" />Webhooks</span>
								</Select.Item>
							</Select.Content>
						</Select.Root>
					{/if}
				</div>
			</div>

			<div class="flex items-center gap-2">
				<Label>Status</Label>
				<TogglePill bind:checked={formEnabled} onLabel="Enabled" offLabel="Disabled" />
			</div>

			{#if formType === 'smtp'}
				<div class="space-y-4 border-t pt-4 min-h-[380px]">
					<div class="flex items-center gap-2">
						<p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">SMTP configuration</p>
						<Tooltip.Root>
							<Tooltip.Trigger>
								<HelpCircle class="w-3.5 h-3.5 text-muted-foreground hover:text-foreground cursor-help" />
							</Tooltip.Trigger>
							<Tooltip.Portal>
								<Tooltip.Content side="right" class="w-80">
									<p class="text-xs"><span class="font-semibold">Gmail:</span> smtp.gmail.com, port 587, TLS/SSL off. Use an App Password.</p>
									<p class="text-xs mt-1"><span class="font-semibold">Outlook:</span> smtp.office365.com, port 587, TLS/SSL off.</p>
								</Tooltip.Content>
							</Tooltip.Portal>
						</Tooltip.Root>
					</div>
					<div class="grid grid-cols-3 gap-4">
						<div class="space-y-2 col-span-2">
							<Label for="notif-smtp-host">SMTP host *</Label>
							<Input id="notif-smtp-host" bind:value={formSmtpHost} placeholder="smtp.gmail.com" />
						</div>
						<div class="space-y-2">
							<Label for="notif-smtp-port">Port *</Label>
							<Input id="notif-smtp-port" type="number" bind:value={formSmtpPort} />
						</div>
					</div>
					<div class="flex items-center gap-4">
						<div class="flex items-center gap-2">
							<Label>TLS/SSL</Label>
							<TogglePill bind:checked={formSmtpSecure} onLabel="Yes" offLabel="No" />
						</div>
						<div class="flex items-center gap-2">
							<Label class="text-muted-foreground">Skip TLS verify</Label>
							<TogglePill bind:checked={formSmtpSkipTlsVerify} onLabel="Yes" offLabel="No" />
						</div>
					</div>
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-2">
							<Label for="notif-smtp-username">Username</Label>
							<Input id="notif-smtp-username" bind:value={formSmtpUsername} placeholder="user@example.com" />
						</div>
						<div class="space-y-2">
							<Label for="notif-smtp-password">Password</Label>
							<Input id="notif-smtp-password" type="password" bind:value={formSmtpPassword} placeholder={isEditing ? 'Leave blank to keep existing' : 'App password or token'} />
						</div>
					</div>
					<div class="grid grid-cols-2 gap-4">
						<div class="space-y-2">
							<Label for="notif-smtp-from-email">From email *</Label>
							<Input id="notif-smtp-from-email" bind:value={formSmtpFromEmail} placeholder="alerts@example.com" />
						</div>
						<div class="space-y-2">
							<Label for="notif-smtp-from-name">From name</Label>
							<Input id="notif-smtp-from-name" bind:value={formSmtpFromName} placeholder="Dockhand Alerts" />
						</div>
					</div>
					<div class="space-y-2">
						<Label for="notif-smtp-to">Recipients * (comma-separated)</Label>
						<Input id="notif-smtp-to" bind:value={formSmtpToEmails} placeholder="admin@example.com, ops@example.com" />
					</div>
				</div>
			{:else}
				<div class="space-y-4 border-t pt-4 min-h-[380px]">
					<p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Webhook configuration</p>
					<div class="space-y-2">
						<Label for="notif-apprise-urls">Webhook URLs * (one per line)</Label>
						<textarea
							id="notif-apprise-urls"
							bind:value={formAppriseUrls}
							placeholder="gotify://hostname/app-token
gotifys://hostname/app-token?priority=5
discord://webhook_id/webhook_token
slack://token_a/token_b/token_c
mmost://hostname/webhook-token
tgram://bot_token/chat_id
tgram://bot_token/chat_id:topic_id
ntfy://my-topic
ntfy://host/topic?auth=base64token&priority=3
ntfys://host/topic?auth=base64token
pushover://user_key/api_token
pushover://user_key/api_token/device1/device2
pover://user_key@api_token/device1/device2
mqtt://user:pass@broker-host:1883/dockhand/events?qos=1&amp;retain=true
mqtts://broker-host:8883/dockhand/events
workflows://hostname/workflow/signature
bark://bark_key
bark://host/bark_key
barks://host/bark_key
signal://host:8080/+sender/+recipient
apprise://host:8000/your-key
jsons://hostname/webhook/path
zabbix://hostname/api_jsonrpc.php?token=TOKEN&amp;host=HOST&amp;key=ITEM_KEY
zabbixs://hostname/api_jsonrpc.php?token=TOKEN&amp;host=HOST&amp;key=ITEM_KEY"
						class="flex min-h-[220px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					></textarea>
					<p class="text-xs text-muted-foreground">
						Built-in channels: Discord, Slack, Mattermost, Telegram, ntfy, Gotify, Pushover, MQTT, Bark, Signal (via signal-cli-rest-api), Microsoft Teams (via Workflows), Zabbix (via history.push), and generic JSON.
					</p>
					<p class="flex gap-1.5 text-xs text-muted-foreground">
						<HelpCircle class="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
						<span>Need a provider that is not in the list (Matrix, Nextcloud, Pushbullet, Home Assistant, ...)? Run a <a href="https://github.com/caronc/apprise-api" target="_blank" rel="noopener">caronc/apprise-api</a> server, configure the provider there, and point Dockhand at it with <code>apprise://host/key</code> (or <code>apprises://</code> for TLS). Every provider Apprise supports is then reachable.</span>
					</p>
					</div>
				</div>
			{/if}

				</Tabs.Content>

				<Tabs.Content value="events" class="space-y-3 mt-0">
					<p class="text-xs text-muted-foreground">
						These events are not tied to specific environments and are configured globally here.
						Environment-specific events (containers, stacks, auto-updates) are configured in each environment's settings.
					</p>
					<div class="space-y-1">
						{#each SYSTEM_EVENTS as event}
							<div class="flex items-center gap-3 p-2 rounded hover:bg-muted/50">
								<TogglePill
									checked={formSystemEvents.includes(event.id)}
									onchange={() => toggleSystemEvent(event.id, !formSystemEvents.includes(event.id))}
								/>
								<div class="flex-1 min-w-0">
									<span class="text-sm font-medium">{event.label}</span>
									<p class="text-xs text-muted-foreground">{event.description}</p>
								</div>
							</div>
						{/each}
					</div>
				</Tabs.Content>
			</div>
		</Tabs.Root>

		<Dialog.Footer class="flex justify-between sm:justify-between">
			<Button variant="outline" onclick={testConfig} disabled={formTesting || formSaving}>
				{#if formTesting}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
					Testing...
				{:else if testResult === 'success'}
					<CheckCircle2 class="w-4 h-4 mr-1 text-green-500" />
					Sent!
				{:else if testResult === 'error'}
					<XCircle class="w-4 h-4 mr-1 text-destructive" />
					Failed
				{:else}
					<Send class="w-4 h-4" />
					Test
				{/if}
			</Button>
			<div class="flex gap-2">
				<Button variant="outline" onclick={handleClose}>Cancel</Button>
				<Button onclick={save} disabled={formSaving || formTesting}>
					{#if formSaving}
						<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
					{:else if isEditing}
						<Check class="w-4 h-4" />
					{:else}
						<Plus class="w-4 h-4" />
					{/if}
					{isEditing ? 'Save' : 'Add'}
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
