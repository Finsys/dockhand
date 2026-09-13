<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Plus, Check, RefreshCw, Wifi, Database, HardDrive, Dices, Copy, BarChart3, Loader2, Clock, PackageCheck, FolderCheck, Unlock, CircleHelp, AlertTriangle, Upload } from 'lucide-svelte';
	import { AWS_REGIONS, regionalEndpoint, extractS3Region } from '$lib/utils/s3-region';
	import cronstrue from 'cronstrue';
	import { formatBytes } from '$lib/utils/format';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import * as Popover from '$lib/components/ui/popover';
	import { AmazonS3Icon, BackblazeIcon, AzureBlobIcon, GoogleCloudIcon, RestServerIcon } from '$lib/components/cloud-icons';
	import { FieldLabel } from '$lib/components/ui/field-label';
	import { toast } from 'svelte-sonner';
	import { focusFirstInput } from '$lib/utils';
	import { backendSupportsTls } from '$lib/shared/repo-predicates';

	interface Destination {
		id: number;
		name: string;
		repository: string;
		hostPath?: string | null;
		envVars?: Record<string, string>;
		hasCacert?: boolean;         // a CA cert is stored (the PEM itself is never sent back)
		hasTlsClientCert?: boolean;  // a client cert is stored
		flags?: string;
		backupFlags?: string;   // split from the GET endpoint (legacy strings surface here)
		restoreFlags?: string;
		policies?: string | null;
		lastTestStatus?: string | null;
		createdAt: string;
		updatedAt: string;
	}

	interface Props {
		open: boolean;
		destination?: Destination | null;
		existingDestinations?: Destination[];
		onClose: () => void;
		onSaved: () => void;
	}

	let { open = $bindable(), destination = null, existingDestinations = [], onClose, onSaved }: Props = $props();
	const isEditing = $derived(destination !== null);

	// Stats for existing destinations
	let repoStats = $state<{ totalSize: number; totalFiles: number; snapshots: number } | null>(null);
	let loadingStats = $state(false);

	async function fetchStats() {
		if (!destination?.id) return;
		loadingStats = true;
		try {
			const res = await fetch(`/api/backup/destinations/${destination.id}/task`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ task: 'stats' })
			});
			const data = await res.json();
			if (data.success && data.stats) repoStats = data.stats;
		} catch {} finally { loadingStats = false; }
	}

	$effect(() => {
		if (open && destination?.id) {
			repoStats = null;
			fetchStats();
		}
	});

	interface FormField {
		key: string;
		label: string;
		placeholder: string;
		secret?: boolean;
		envKey?: string; // if set, stored as env var instead of part of repo URL
		optional?: boolean; // no red asterisk; not required for Test/Create
		multiline?: boolean; // render a textarea (e.g. a pasted JSON credential)
		hint?: string; // small helper text under the field
	}

	interface BackendType {
		value: string;
		label: string;
		icon: any;
		fields: FormField[];
		buildRepo: (fields: Record<string, string>) => string;
		parseRepo: (repo: string) => Record<string, string>;
	}

	const backendTypes: BackendType[] = [
		{
			value: 'local', label: 'Local path', icon: HardDrive,
			fields: [
				{ key: 'path', label: 'Path', placeholder: '/app/local-backups/myrepo', optional: true }
			],
			buildRepo: (f) => f.path || '',
			parseRepo: (repo) => ({ path: repo })
		},
		{
			value: 's3', label: 'Amazon S3', icon: AmazonS3Icon,
			fields: [
				{ key: 'region', label: 'AWS region', placeholder: '', optional: true },
				{ key: 'endpoint', label: 'Endpoint', placeholder: 's3.amazonaws.com (or http://minio:9000)' },
				{ key: 'bucket', label: 'Bucket', placeholder: 'my-backup-bucket' },
				{ key: 'path', label: 'Path', placeholder: 'dockhand', optional: true },
				{ key: 'accessKey', label: 'Access key ID', placeholder: '', envKey: 'AWS_ACCESS_KEY_ID' },
				{ key: 'secretKey', label: 'Secret access key', placeholder: '', secret: true, envKey: 'AWS_SECRET_ACCESS_KEY' }
			],
			buildRepo: (f) => {
				const endpoint = f.endpoint || 's3.amazonaws.com';
				const path = f.path ? `/${f.path}` : '';
				return `s3:${endpoint.includes('://') ? '' : 'https://'}${endpoint}/${f.bucket}${path}`;
			},
			parseRepo: (repo) => {
				// s3:https://s3.amazonaws.com/bucket/path or s3:http://minio:9000/bucket/path
				const after = repo.replace(/^s3:/, '');
				try {
					const url = new URL(after.startsWith('http') ? after : `https://${after}`);
					const parts = url.pathname.replace(/^\//, '').split('/');
					const bucket = parts[0] || '';
					const path = parts.slice(1).join('/');
					const endpoint = after.startsWith('http') ? `${url.protocol}//${url.host}` : url.host;
					// Recover the region from an AWS regional endpoint so the picker shows it
					// on edit. Non-AWS hosts leave it blank (treated as custom).
					const region = extractS3Region(url.host);
					return { endpoint, bucket, path, region };
				} catch {
					return { endpoint: '', bucket: '', path: '', region: '' };
				}
			}
		},
		{
			value: 'b2', label: 'Backblaze B2', icon: BackblazeIcon,
			fields: [
				{ key: 'bucket', label: 'Bucket', placeholder: 'my-backup-bucket' },
				{ key: 'path', label: 'Path', placeholder: 'dockhand', optional: true },
				{ key: 'accountId', label: 'Key ID', placeholder: '', envKey: 'B2_ACCOUNT_ID' },
				{ key: 'accountKey', label: 'Application key', placeholder: '', secret: true, envKey: 'B2_ACCOUNT_KEY' }
			],
			buildRepo: (f) => `b2:${f.bucket}:${f.path || ''}`.replace(/:$/, ''),
			parseRepo: (repo) => {
				const after = repo.replace(/^b2:/, '');
				const [bucket, ...rest] = after.split(':');
				return { bucket: bucket || '', path: rest.join(':') };
			}
		},
		{
			value: 'azure', label: 'Azure Blob', icon: AzureBlobIcon,
			fields: [
				{ key: 'container', label: 'Container', placeholder: 'my-backup-container' },
				{ key: 'path', label: 'Path', placeholder: 'dockhand', optional: true },
				{ key: 'accountName', label: 'Account name', placeholder: '', envKey: 'AZURE_ACCOUNT_NAME' },
				{ key: 'accountKey', label: 'Account key', placeholder: '', secret: true, envKey: 'AZURE_ACCOUNT_KEY' }
			],
			// Keep the trailing colon: restic's azure parser needs `azure:container:`
			// (it splits on ':' and rejects a repo with no second colon). B2/GS differ.
			buildRepo: (f) => `azure:${f.container}:${f.path || ''}`,
			parseRepo: (repo) => {
				const after = repo.replace(/^azure:/, '');
				const [container, ...rest] = after.split(':');
				return { container: container || '', path: rest.join(':') };
			}
		},
		{
			value: 'gs', label: 'Google Cloud', icon: GoogleCloudIcon,
			fields: [
				{ key: 'bucket', label: 'Bucket', placeholder: 'my-backup-bucket' },
				{ key: 'path', label: 'Path', placeholder: '/dockhand', optional: true },
				{ key: 'projectId', label: 'Project ID', placeholder: 'my-gcp-project', envKey: 'GOOGLE_PROJECT_ID' },
				{ key: 'saJson', label: 'Service account JSON', placeholder: '{ "type": "service_account", ... }', secret: true, multiline: true, envKey: 'GOOGLE_APPLICATION_CREDENTIALS_JSON', hint: 'Paste or upload a service-account key JSON. It auto-refreshes, so scheduled backups keep working.' }
			],
			buildRepo: (f) => `gs:${f.bucket}:${f.path || '/'}`,
			parseRepo: (repo) => {
				const after = repo.replace(/^gs:/, '');
				const [bucket, ...rest] = after.split(':');
				return { bucket: bucket || '', path: rest.join(':') };
			}
		},
		{
			value: 'rest', label: 'REST server', icon: RestServerIcon,
			fields: [
				{ key: 'url', label: 'Server URL', placeholder: 'https://backup-server:8000/repo-name' }
			],
			buildRepo: (f) => `rest:${f.url || ''}`,
			parseRepo: (repo) => ({ url: repo.replace(/^rest:/, '') })
		}
	];

	let formName = $state('');
	let formBackendType = $state('local');
	let formFields = $state<Record<string, string>>({});
	// Hidden file-input refs per multiline field, for the "Upload file" button.
	let fileInputs = $state<Record<string, HTMLInputElement | null>>({});

	// Read a selected file into the field (e.g. a service-account JSON). Kept lenient:
	// we accept any text; restic validates the JSON when the destination is tested.
	async function uploadJsonToField(key: string, e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			formFields[key] = await file.text();
		} catch {
			toast.error('Could not read the selected file');
		}
		input.value = ''; // let the same file be re-picked
	}

	// TLS certs (PEM). Sent as content to the server, which stores them encrypted and
	// NEVER sends the PEM back (only hasCacert/hasTlsClientCert booleans). So on edit
	// these start blank = "keep the stored cert"; an explicit clear zeroes them out.
	let formCacert = $state('');
	let formTlsClientCert = $state('');
	let hadCacert = $state(false);        // a cert was already stored when the modal opened
	let hadTlsClientCert = $state(false);
	let caFileInput = $state<HTMLInputElement | null>(null);
	let clientCertFileInput = $state<HTMLInputElement | null>(null);

	async function uploadPem(which: 'ca' | 'client', e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			if (which === 'ca') formCacert = text; else formTlsClientCert = text;
		} catch {
			toast.error('Could not read the selected file');
		}
		input.value = '';
	}
	let formPassword = $state('');
	let formBackupFlags = $state('');
	let formRestoreFlags = $state('');
	let formError = $state('');
	let formSaving = $state(false);

	// Policies
	let policyPruneEnabled = $state(true);
	let policyPruneSchedule = $state('0 0 1 * *');
	let policyPruneMaxUnused = $state('10');
	let policyCheckEnabled = $state(true);
	let policyCheckSchedule = $state('0 0 1 * *');
	let policyVerifyEnabled = $state(false);
	let policyVerifySchedule = $state('0 0 1 * *');
	let policyVerifyDataSubset = $state('5%');
	let policyAutoUnlock = $state(true);
	let testing = $state(false);
	let initializing = $state(false);
	// Set when a Test on a NEW (unsaved) destination reports the repo reachable but
	// not yet initialised. It flips the create button to "Save and init" so the user
	// can save + init in one click. Reset whenever the repo fields change (a stale
	// verdict must not drive the button after the user edits the target).
	let needsInit = $state(false);
	// Inline verdict shown next to the Test button after a test. `needs_init` is
	// NOT an error (connectivity works, the repo just isn't initialised yet), so it
	// reads green, not red. Cleared when the repo fields change (stale verdict).
	let testStatus = $state<null | 'ok' | 'needs_init' | 'error'>(null);
	let testStatusMsg = $state('');

	const selectedBackend = $derived(backendTypes.find(b => b.value === formBackendType) ?? backendTypes[0]);
	const repoFields = $derived(selectedBackend.fields.filter(f => !f.envKey));
	const credentialFields = $derived(selectedBackend.fields.filter(f => f.envKey));

	// TLS certs only apply to backends self-hostable over HTTPS with a private CA
	// (S3/REST); hidden for local/B2/Azure/Google Cloud. See backendSupportsTls.
	const showTlsSection = $derived(
		backendSupportsTls(formBackendType, { isEditing, hasStoredCert: hadCacert || hadTlsClientCert })
	);

	// A field is mandatory unless it opts out (optional) or is a toggle (skipHostKey).
	function fieldRequired(f: FormField): boolean {
		return !f.optional && f.key !== 'skipHostKey';
	}
	// All mandatory fields present? Drives the disabled state of Test/Create. On edit
	// the credentials + password are already stored (secrets show blank = "keep
	// current"), so credential fields aren't required there - only repo fields are.
	const requiredFieldsFilled = $derived(
		selectedBackend.fields
			.filter(f => fieldRequired(f) && !(isEditing && f.envKey))
			.every(f => (formFields[f.key] ?? '').trim().length > 0)
	);
	const formValid = $derived(
		formName.trim().length > 0
		&& requiredFieldsFilled
		&& (isEditing || formPassword.trim().length > 0)
	);

	// Collect the destination's env vars from the fields that declare an envKey, plus
	// the S3 region (AWS_DEFAULT_REGION) when set. Passing the region lets restic reach
	// a bucket even against the generic s3.amazonaws.com endpoint, and is required by
	// some S3 providers regardless of endpoint.
	function collectEnvVars(): Record<string, string> {
		const envVars: Record<string, string> = {};
		for (const field of selectedBackend.fields) {
			if (field.envKey && formFields[field.key]?.trim()) envVars[field.envKey] = formFields[field.key];
		}
		const region = formFields.region?.trim();
		if (region) envVars['AWS_DEFAULT_REGION'] = region;
		return envVars;
	}

	function detectBackendType(repo: string): string {
		for (const prefix of ['s3:', 'b2:', 'azure:', 'gs:', 'rest:']) {
			if (repo.startsWith(prefix)) return prefix.slice(0, -1);
		}
		return 'local';
	}

	function resetForm() {
		formName = ''; formBackendType = 'local'; formFields = {}; formPassword = '';
		formBackupFlags = ''; formRestoreFlags = ''; formError = '';
		formCacert = ''; formTlsClientCert = ''; hadCacert = false; hadTlsClientCert = false;
		formSaving = false;
		policyPruneEnabled = true; policyPruneSchedule = '0 0 1 * *'; policyPruneMaxUnused = '10';
		policyCheckEnabled = true; policyCheckSchedule = '0 0 1 * *';
		policyVerifyEnabled = false; policyVerifySchedule = '0 0 1 * *'; policyVerifyDataSubset = '5%';
		policyAutoUnlock = true;
	}

	$effect(() => {
		if (open) {
			if (destination) {
				formName = destination.name;
				const type = detectBackendType(destination.repository);
				formBackendType = type;
				const backend = backendTypes.find(b => b.value === type);
				// Parse repo URL into fields, then merge credential env vars
				const fields = backend ? backend.parseRepo(destination.repository) : {};
				if (destination.envVars) {
					for (const [key, value] of Object.entries(destination.envVars)) {
						const field = backend?.fields.find(f => f.envKey === key);
						if (field) fields[field.key] = value as string;
					}
					// The S3 region is stored as AWS_DEFAULT_REGION (no envKey field), so
					// map it back explicitly. It wins over any region recovered from the
					// endpoint by parseRepo — the saved env var is authoritative.
					if (destination.envVars['AWS_DEFAULT_REGION']) {
						fields.region = destination.envVars['AWS_DEFAULT_REGION'];
					}
				}
				formFields = fields;
				formPassword = '';
				// The GET endpoint splits the stored flags JSON into backupFlags/restoreFlags
				// (legacy bare strings surface as backupFlags), so the form binds them directly.
				formBackupFlags = destination.backupFlags ?? '';
				formRestoreFlags = destination.restoreFlags ?? '';
				// PEMs are never returned; start blank and remember one is stored so the
				// UI can say "leave blank to keep" and offer a Clear button.
				formCacert = ''; formTlsClientCert = '';
				hadCacert = !!destination.hasCacert;
				hadTlsClientCert = !!destination.hasTlsClientCert;
				formError = '';
				// Load policies
				const pol = destination.policies ? (() => { try { return JSON.parse(destination.policies); } catch { return {}; } })() : {};
				policyPruneEnabled = pol.pruneEnabled ?? true;
				policyPruneSchedule = pol.pruneSchedule || '0 0 1 * *';
				policyPruneMaxUnused = pol.pruneMaxUnused || '10';
				policyCheckEnabled = pol.checkEnabled ?? true;
				policyCheckSchedule = pol.checkSchedule || '0 0 1 * *';
				policyVerifyEnabled = pol.verifyEnabled ?? false;
				policyVerifySchedule = pol.verifySchedule || '0 0 1 * *';
				policyVerifyDataSubset = pol.verifyDataSubset || '5%';
				policyAutoUnlock = pol.autoUnlock ?? true;
			} else { resetForm(); }
		}
	});

	let generatedOk = $state(false);
	let copiedOk = $state(false);

	function generatePassword() {
		const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*-_=+';
		// Rejection sampling to avoid modulo bias: 256 % 72 = 40, so bytes >= 216
		// are discarded and re-drawn, keeping every character uniformly likely.
		const max = 256 - (256 % chars.length); // 216
		const result: string[] = [];
		while (result.length < 32) {
			const batch = new Uint8Array(32);
			crypto.getRandomValues(batch);
			for (const b of batch) {
				if (b >= max) continue;
				result.push(chars[b % chars.length]);
				if (result.length === 32) break;
			}
		}
		formPassword = result.join('');
		generatedOk = true;
		setTimeout(() => { generatedOk = false; }, 1500);
	}

	async function copyPassword() {
		const ok = await copyToClipboard(formPassword);
		if (ok) {
			copiedOk = true;
			setTimeout(() => { copiedOk = false; }, 1500);
		} else {
			toast.error('Could not copy to clipboard. Copy it manually, or use HTTPS to enable one-click copy.');
		}
	}

	function handleBackendChange(value: string) {
		formBackendType = value;
		formFields = {};
	}

	async function testConnection() {
		testing = true;
		try {
			let payload: Record<string, unknown>;
			if (isEditing) {
				// Use saved credentials from DB
				payload = { destinationId: destination!.id };
			} else {
				// Test is disabled until formValid (all mandatory fields incl. credentials),
				// so empty creds can't reach restic here - which matters because without
				// them restic falls back to ambient auth (Azure ManagedIdentity, AWS
				// instance role) that hangs on a retry loop instead of failing fast.
				const repository = selectedBackend.buildRepo(formFields);
				const envVars = collectEnvVars();
				payload = {
					repository, password: formPassword,
					envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
					// Carry the TLS PEMs so a pre-save test of a private-CA backend can validate.
					cacert: formCacert.trim() || undefined,
					tlsClientCert: formTlsClientCert.trim() || undefined
				};
			}
			const res = await fetch('/api/backup/destinations/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const data = await res.json();
			// needsInit means restic REACHED the repo but it isn't initialised yet —
			// connectivity + credentials are fine, so this is NOT an error. The backend
			// returns success:false here, so check needsInit on its own.
			if (data.needsInit) {
				// Only the create flow gets the "Save and init" button; editing an
				// existing destination already has its own "Init repo" action.
				needsInit = !isEditing;
				testStatus = 'needs_init';
				testStatusMsg = 'Connectivity OK, repository needs init';
			} else if (res.ok && data.success) {
				needsInit = false;
				testStatus = 'ok';
				testStatusMsg = 'Connection successful';
			} else {
				needsInit = false;
				testStatus = 'error';
				testStatusMsg = data.error || 'Connection test failed';
			}
		} catch { testStatus = 'error'; testStatusMsg = 'Connection test failed'; } finally { testing = false; }
	}

	async function initRepo() {
		if (!destination) return;
		initializing = true;
		try {
			const res = await fetch(`/api/backup/destinations/${destination.id}/init`, { method: 'POST' });
			const data = await res.json();
			toast[res.ok && data.success ? 'success' : 'error'](data.success ? 'Repository initialized' : (data.error || 'Init failed'));
		} catch { toast.error('Init failed'); } finally { initializing = false; }
	}

	// Normalize a restic repository string for loose equality: lowercase, drop
	// trailing slashes, collapse internal whitespace. Good enough to catch the
	// common "same repo, two rows" mistake (s3:https://host/bucket vs the same
	// with a trailing slash). This only gates a non-blocking WARNING, so a missed
	// match just means no warning — never a false block.
	function normalizeRepo(repo: string): string {
		return repo.trim().toLowerCase().replace(/\/+$/, '').replace(/\s+/g, ' ');
	}

	// Set to the colliding destination's name when the entered repo matches an
	// existing destination's repo. Shows a warning + flips Save to "Save anyway".
	let repoConflictName = $state<string | null>(null);

	// Editing the repo after the warning appeared clears it, so the user must
	// re-confirm against whatever repo they end up with (not a stale acknowledgement).
	const currentRepo = $derived(selectedBackend.buildRepo(formFields));
	$effect(() => {
		currentRepo; // track
		repoConflictName = null;
	});
	// Any change to the target (repo string OR credentials OR password) invalidates a
	// prior Test verdict, so the "Save and init" state must not linger.
	$effect(() => {
		currentRepo; formFields; formPassword; // track
		needsInit = false;
		testStatus = null;
	});

	async function save() {
		if (!formName.trim()) { formError = 'Name is required'; return; }
		const repository = selectedBackend.buildRepo(formFields);
		if (!repository.trim()) { formError = 'Repository fields are incomplete'; return; }

		// Warn (once) if this repo is already used by another destination. Backups
		// to a shared repo are serialized (restic locks the repo), not parallel —
		// legitimate for rotation/migration, but usually a mistake. Non-blocking:
		// a second click on "Save anyway" proceeds.
		if (!repoConflictName) {
			const norm = normalizeRepo(repository);
			const clash = existingDestinations.find(
				(d) => d.id !== destination?.id && normalizeRepo(d.repository) === norm
			);
			if (clash) { repoConflictName = clash.name; return; }
		}

		formSaving = true; formError = '';
		try {
			const envVars = collectEnvVars();
			const policies = {
				pruneEnabled: policyPruneEnabled,
				pruneSchedule: policyPruneSchedule,
				pruneMaxUnused: policyPruneMaxUnused,
				checkEnabled: policyCheckEnabled,
				checkSchedule: policyCheckSchedule,
				verifyEnabled: policyVerifyEnabled,
				verifySchedule: policyVerifySchedule,
				verifyDataSubset: policyVerifyDataSubset,
				autoUnlock: policyAutoUnlock
			};
			const body: Record<string, unknown> = {
				name: formName.trim(), repository,
				envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
				backupFlags: formBackupFlags.trim(),
				restoreFlags: formRestoreFlags.trim(),
				policies: JSON.stringify(policies)
			};
			if (formPassword || !isEditing) body.password = formPassword || undefined;
			// TLS certs, with keep/clear semantics on edit:
			//   typed value  -> send it (set/replace)
			//   blank + one stored -> omit (server keeps the existing cert)
			//   explicitly cleared (blank + none was stored, or user hit Clear) -> send ''
			// On create, blank just means "no cert" so an empty string is fine to omit.
			if (formCacert.trim()) body.cacert = formCacert;
			else if (isEditing && !hadCacert) body.cacert = '';
			if (formTlsClientCert.trim()) body.tlsClientCert = formTlsClientCert;
			else if (isEditing && !hadTlsClientCert) body.tlsClientCert = '';
			const res = await fetch(isEditing ? `/api/backup/destinations/${destination!.id}` : '/api/backup/destinations', {
				method: isEditing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
			});
			// Creating a destination auto-initialises its repository server-side, so a
			// create over a reachable-but-uninitialised repo (needsInit) needs no extra
			// call here — the button just tells the user that up front ("Save and init").
			if (res.ok) { open = false; onSaved(); toast.success(needsInit ? 'Destination created and repository initialized' : isEditing ? 'Destination updated' : 'Destination created'); }
			else { const data = await res.json(); formError = data.error || 'Failed'; }
		} catch { formError = 'Failed'; } finally { formSaving = false; }
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (o) { formError = ''; repoConflictName = null; focusFirstInput(); } }}>
	<Dialog.Content class="max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
		<Dialog.Header>
			<Dialog.Title>{isEditing ? 'Edit backup destination' : 'Add backup destination'}</Dialog.Title>
			<Dialog.Description>{isEditing ? 'Update backup destination settings' : 'Configure a restic backup repository'}</Dialog.Description>
		</Dialog.Header>

		{#if formError}<p class="text-sm text-destructive">{formError}</p>{/if}

		<div class="flex-1 overflow-y-auto pr-3">
		{#if selectedBackend.value === 'local'}
			<div class="flex items-start gap-2 p-2.5 mt-4 rounded-md bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
				<HardDrive class="w-3.5 h-3.5 shrink-0 mt-0.5" />
				<span>Enter the path as Dockhand sees it inside its own container (the container side of your backup volume mount, e.g. <code>/app/local-backups/...</code>), not the host path. Local path repositories work on the local Docker host, or a co-located socket-proxy on that same host. For remote hosts, use S3, REST, or another remote backend.</span>
			</div>
		{/if}
		<div class="grid grid-cols-2 gap-6 py-4">
			<!-- Left column: connection -->
			<div class="space-y-4">
				<div class="space-y-2">
					<FieldLabel label="Name" forId="dest-name" required />
					<Input id="dest-name" bind:value={formName} />
				</div>

				<div class="space-y-2">
					<Label>Backend type</Label>
					<Select.Root type="single" value={formBackendType} onValueChange={handleBackendChange}>
						<Select.Trigger class="w-full">
							<span class="flex items-center gap-2">
								<selectedBackend.icon class="w-4 h-4 text-muted-foreground" />
								{selectedBackend.label}
							</span>
						</Select.Trigger>
						<Select.Content>
							{#each backendTypes as backend}
								<Select.Item value={backend.value}>
									<span class="flex items-center gap-2">
										<backend.icon class="w-4 h-4 text-muted-foreground" />
										{backend.label}
									</span>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>

				{#each repoFields as field}
					{#if field.key === 'region'}
						<div class="space-y-1">
							<FieldLabel label={field.label} forId="field-region" required={fieldRequired(field)} />
							<div class="flex gap-1.5">
								<!-- Free-text region: any provider (AWS, Wasabi, R2, ...). Always
								     passed to restic as AWS_DEFAULT_REGION. -->
								<Input
									id="field-region"
									value={formFields.region ?? ''}
									oninput={(e: Event) => { formFields.region = (e.target as HTMLInputElement).value; }}
									placeholder="e.g. eu-north-1"
									class="flex-1"
								/>
								<!-- Quick-pick of AWS regions: fills the region AND the regional
								     endpoint so AWS users don't have to know the URL. -->
								<Select.Root type="single" value={formFields.region ?? ''} onValueChange={(v) => {
									if (!v) return;
									formFields.region = v;
									formFields.endpoint = regionalEndpoint(v);
								}}>
									<Select.Trigger class="w-36 shrink-0" aria-label="AWS regions quick pick">AWS regions</Select.Trigger>
									<Select.Content class="max-h-64">
										{#each AWS_REGIONS as r}
											<Select.Item value={r}>{r}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							</div>
							<p class="text-xs text-muted-foreground">
								Passed to restic as <code class="font-mono">AWS_DEFAULT_REGION</code>.
							</p>
						</div>
					{:else}
						<div class="space-y-1">
							<FieldLabel label={field.label} forId="field-{field.key}" required={fieldRequired(field)} />
							<Input
								id="field-{field.key}"
								value={formFields[field.key] ?? ''}
								oninput={(e: Event) => { formFields[field.key] = (e.target as HTMLInputElement).value; }}
								placeholder={field.placeholder}
							/>
						</div>
					{/if}
				{/each}
			</div>

			<!-- Right column: credentials & security -->
			<div class="space-y-4">
				{#each credentialFields as field}
					{#if field.key === 'skipHostKey'}
						<div class="flex items-center justify-between">
							<Label>{field.label}</Label>
							<TogglePill checked={formFields[field.key] === 'true'} onchange={() => { formFields[field.key] = formFields[field.key] === 'true' ? '' : 'true'; }} />
						</div>
					{:else}
						<div class="space-y-1">
							{#if field.multiline}
								<div class="flex items-center justify-between">
									<FieldLabel label={field.label} forId="field-{field.key}" required={fieldRequired(field)} />
									<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => fileInputs[field.key]?.click()}>
										<Upload class="mr-1 h-3 w-3" />Upload file
									</Button>
								</div>
								<input
									type="file"
									accept="application/json,.json"
									class="hidden"
									bind:this={fileInputs[field.key]}
									onchange={(e) => uploadJsonToField(field.key, e)}
								/>
								<Textarea
									id="field-{field.key}"
									rows={5}
									value={formFields[field.key] ?? ''}
									oninput={(e: Event) => { formFields[field.key] = (e.target as HTMLTextAreaElement).value; }}
									placeholder={isEditing && field.secret ? '(leave blank to keep current)' : field.placeholder}
									class="field-sizing-fixed max-h-40 resize-y overflow-auto font-mono text-xs"
								/>
							{:else}
								<FieldLabel label={field.label} forId="field-{field.key}" required={fieldRequired(field)} />
								<Input
									id="field-{field.key}"
									type={field.secret ? 'password' : 'text'}
									value={formFields[field.key] ?? ''}
									oninput={(e: Event) => { formFields[field.key] = (e.target as HTMLInputElement).value; }}
									placeholder={isEditing && field.secret ? '(leave blank to keep current)' : field.placeholder}
								/>
							{/if}
							{#if field.hint}<p class="text-xs text-muted-foreground">{field.hint}</p>{/if}
						</div>
					{/if}
				{/each}

				<div class="space-y-2">
					<FieldLabel label="Encryption password" forId="dest-password" required={!isEditing} />
					<div class="flex gap-1.5">
						<Input id="dest-password" type="password" bind:value={formPassword} placeholder={isEditing ? '(leave blank to keep current)' : ''} class="flex-1" />
						<Button variant="outline" size="sm" class="h-9 px-2 shrink-0" onclick={generatePassword} title="Generate strong password">
							{#if generatedOk}<Check class="w-3.5 h-3.5 text-green-500" />{:else}<Dices class="w-3.5 h-3.5" />{/if}
						</Button>
						{#if formPassword}
							<Button variant="outline" size="sm" class="h-9 px-2 shrink-0" onclick={copyPassword} title="Copy password">
								{#if copiedOk}<Check class="w-3.5 h-3.5 text-green-500" />{:else}<Copy class="w-3.5 h-3.5" />{/if}
							</Button>
						{/if}
					</div>
					<p class="text-xs text-muted-foreground">Restic encrypts all data with this password. You will need it to restore.</p>
				</div>

				<div class="space-y-2">
					<Label for="dest-backup-flags">Extra backup flags</Label>
					<Input id="dest-backup-flags" bind:value={formBackupFlags} />
					<div class="text-xs text-muted-foreground space-y-0.5">
						<p>Applied to backups. Common flags:</p>
						<div class="flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
							<span class="cursor-pointer hover:text-foreground" onclick={() => { formBackupFlags = (formBackupFlags + ' --limit-upload 5120').trim(); }} title="Limit upload speed to 5 MB/s">--limit-upload</span>
							<span class="cursor-pointer hover:text-foreground" onclick={() => { formBackupFlags = (formBackupFlags + ' --limit-download 10240').trim(); }} title="Limit download speed to 10 MB/s">--limit-download</span>
							<span class="cursor-pointer hover:text-foreground" onclick={() => { formBackupFlags = (formBackupFlags + ' --verbose').trim(); }} title="Verbose output">--verbose</span>
							<span class="cursor-pointer hover:text-foreground" onclick={() => { formBackupFlags = (formBackupFlags + ' --compression max').trim(); }} title="Maximum compression">--compression max</span>
						</div>
					</div>
				</div>

				<div class="space-y-2">
					<Label for="dest-restore-flags">Extra restore flags</Label>
					<Input id="dest-restore-flags" bind:value={formRestoreFlags} />
					<div class="text-xs text-muted-foreground space-y-0.5">
						<p>Applied only to restores. Common flags:</p>
						<div class="flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
							<span class="cursor-pointer hover:text-foreground" onclick={() => { formRestoreFlags = (formRestoreFlags + ' --exclude-xattr security.selinux').trim(); }} title="Skip the SELinux xattr the helper can't remove on a cross-distro restore (e.g. Ubuntu -> Fedora)">--exclude-xattr security.selinux</span>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- TLS certificates: only for backends that can be self-hosted over HTTPS with a
		     private CA - S3 (MinIO/Ceph) and a REST server. A local path has no network, and
		     B2/Azure/Google Cloud are managed clouds with public CAs, so the section is hidden
		     there. Optional; blank = use the system trust store. PEM content, uploaded or pasted. -->
		{#if showTlsSection}
		<div class="border-t pt-3 mt-2 space-y-3">
			<span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">TLS certificates (optional)</span>
			<p class="text-xs text-muted-foreground -mt-1">
				For a backend served over HTTPS with a private/self-signed CA. Leave blank to use the system trust store.
			</p>
			<div class="grid grid-cols-2 gap-6">
				<div class="space-y-1">
					<div class="flex items-center justify-between">
						<Label for="dest-cacert">CA certificate</Label>
						<div class="flex gap-1">
							{#if isEditing && hadCacert && !formCacert}
								<Button variant="outline" size="sm" class="h-7 px-2 text-xs text-destructive" onclick={() => { hadCacert = false; }}>Clear</Button>
							{/if}
							<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => caFileInput?.click()}>
								<Upload class="mr-1 h-3 w-3" />Upload
							</Button>
						</div>
					</div>
					<input type="file" accept=".pem,.crt,.cer,.ca,application/x-pem-file,text/plain" class="hidden" bind:this={caFileInput} onchange={(e) => uploadPem('ca', e)} />
					<Textarea
						id="dest-cacert"
						rows={4}
						bind:value={formCacert}
						placeholder={isEditing && hadCacert ? '(a CA certificate is stored - leave blank to keep it)' : '-----BEGIN CERTIFICATE-----'}
						class="field-sizing-fixed max-h-40 resize-y overflow-auto font-mono text-xs"
					/>
					<p class="text-xs text-muted-foreground">Verifies the backend's TLS certificate (restic <code class="font-mono">RESTIC_CACERT</code>).</p>
				</div>
				<div class="space-y-1">
					<div class="flex items-center justify-between">
						<Label for="dest-client-cert">Client certificate (mTLS)</Label>
						<div class="flex gap-1">
							{#if isEditing && hadTlsClientCert && !formTlsClientCert}
								<Button variant="outline" size="sm" class="h-7 px-2 text-xs text-destructive" onclick={() => { hadTlsClientCert = false; }}>Clear</Button>
							{/if}
							<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => clientCertFileInput?.click()}>
								<Upload class="mr-1 h-3 w-3" />Upload
							</Button>
						</div>
					</div>
					<input type="file" accept=".pem,.crt,.cer,.key,application/x-pem-file,text/plain" class="hidden" bind:this={clientCertFileInput} onchange={(e) => uploadPem('client', e)} />
					<Textarea
						id="dest-client-cert"
						rows={4}
						bind:value={formTlsClientCert}
						placeholder={isEditing && hadTlsClientCert ? '(a client certificate is stored - leave blank to keep it)' : 'certificate + private key in one PEM'}
						class="field-sizing-fixed max-h-40 resize-y overflow-auto font-mono text-xs"
					/>
					<p class="text-xs text-muted-foreground">Certificate + key in one PEM for mutual TLS (restic <code class="font-mono">RESTIC_TLS_CLIENT_CERT</code>).</p>
				</div>
			</div>
		</div>
		{/if}


		<!-- Policies section -->
		<div class="border-t pt-3 mt-2 space-y-3">
			<span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Repository policies</span>

			<!-- Prune policy -->
			<div class="space-y-1.5">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-1.5">
						<Clock class="w-3.5 h-3.5 text-muted-foreground" />
						<Label class="text-sm">Scheduled prune</Label>
						<Tooltip.Provider delayDuration={200}>
							<Tooltip.Root><Tooltip.Trigger><CircleHelp class="w-3 h-3 text-muted-foreground/50 cursor-help" /></Tooltip.Trigger>
								<Tooltip.Portal><Tooltip.Content side="right" class="!w-64 text-xs">Removes unreferenced data from the repository. Frees disk space after snapshots are forgotten. Run monthly for most repos.</Tooltip.Content></Tooltip.Portal>
							</Tooltip.Root>
						</Tooltip.Provider>
					</div>
					<TogglePill bind:checked={policyPruneEnabled} />
				</div>
				{#if policyPruneEnabled}
					<div class="pl-5 space-y-2">
						<CronEditor value={policyPruneSchedule} onchange={(v) => policyPruneSchedule = v} />
						<div class="flex items-center gap-2">
							<label class="text-xs text-muted-foreground">Max unused %</label>
							<Input bind:value={policyPruneMaxUnused} type="number" min="0" max="100" class="h-8 text-xs w-20" />
						</div>
					</div>
				{/if}
			</div>

			<!-- Check policy -->
			<div class="space-y-1.5">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-1.5">
						<PackageCheck class="w-3.5 h-3.5 text-muted-foreground" />
						<Label class="text-sm">Scheduled integrity check</Label>
						<Tooltip.Provider delayDuration={200}>
							<Tooltip.Root><Tooltip.Trigger><CircleHelp class="w-3 h-3 text-muted-foreground/50 cursor-help" /></Tooltip.Trigger>
								<Tooltip.Portal><Tooltip.Content side="right" class="!w-64 text-xs">Verifies the structure and integrity of the repository. Detects corruption or missing data. Run monthly or after storage issues.</Tooltip.Content></Tooltip.Portal>
							</Tooltip.Root>
						</Tooltip.Provider>
					</div>
					<TogglePill bind:checked={policyCheckEnabled} />
				</div>
				{#if policyCheckEnabled}
					<div class="pl-5">
						<CronEditor value={policyCheckSchedule} onchange={(v) => policyCheckSchedule = v} />
					</div>
				{/if}
			</div>

			<!-- Data verification policy -->
			<div class="space-y-1.5">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-1.5">
						<FolderCheck class="w-3.5 h-3.5 text-muted-foreground" />
						<Label class="text-sm">Scheduled data verification</Label>
						<Tooltip.Provider delayDuration={200}>
							<Tooltip.Root><Tooltip.Trigger><CircleHelp class="w-3 h-3 text-muted-foreground/50 cursor-help" /></Tooltip.Trigger>
								<Tooltip.Portal><Tooltip.Content side="right" class="!w-64 text-xs">Reads a random subset of data packs to verify they're readable and intact. Catches bit rot and storage corruption. Slower and uses bandwidth on cloud repos. Off by default.</Tooltip.Content></Tooltip.Portal>
							</Tooltip.Root>
						</Tooltip.Provider>
					</div>
					<TogglePill bind:checked={policyVerifyEnabled} />
				</div>
				{#if policyVerifyEnabled}
					<div class="pl-5 space-y-2">
						<CronEditor value={policyVerifySchedule} onchange={(v) => policyVerifySchedule = v} />
						<div class="flex items-center gap-2">
							<label class="text-xs text-muted-foreground">Data %</label>
							<Select.Root type="single" value={policyVerifyDataSubset} onValueChange={(v) => policyVerifyDataSubset = v}>
								<Select.Trigger class="h-8 w-20 text-xs">{policyVerifyDataSubset}</Select.Trigger>
								<Select.Content>
									<Select.Item value="5%">5%</Select.Item>
									<Select.Item value="10%">10%</Select.Item>
									<Select.Item value="25%">25%</Select.Item>
									<Select.Item value="50%">50%</Select.Item>
									<Select.Item value="100%">100%</Select.Item>
								</Select.Content>
							</Select.Root>
						</div>
					</div>
				{/if}
			</div>

			<!-- Auto-unlock -->
			<div class="flex items-center gap-3">
				<div class="flex items-center gap-1.5">
					<Unlock class="w-3.5 h-3.5 text-muted-foreground" />
					<Label class="text-sm">Auto-unlock stale locks</Label>
					<Tooltip.Provider delayDuration={200}>
						<Tooltip.Root><Tooltip.Trigger><CircleHelp class="w-3 h-3 text-muted-foreground/50 cursor-help" /></Tooltip.Trigger>
							<Tooltip.Portal><Tooltip.Content side="right" class="!w-64 text-xs">Automatically removes stale repository locks before prune and check operations. Locks can be left behind by interrupted or crashed backups.</Tooltip.Content></Tooltip.Portal>
						</Tooltip.Root>
					</Tooltip.Provider>
				</div>
				<TogglePill bind:checked={policyAutoUnlock} />
			</div>
		</div>

		<!-- Stats section (only for existing destinations) -->
		{#if isEditing}
			<div class="border-t pt-3 mt-2">
				<div class="flex items-center gap-2 mb-2">
					<BarChart3 class="w-3.5 h-3.5 text-muted-foreground" />
					<span class="text-xs font-medium text-muted-foreground uppercase tracking-wide">Repository usage</span>
					{#if loadingStats}
						<Loader2 class="w-3 h-3 animate-spin text-muted-foreground" />
					{/if}
				</div>
				{#if repoStats}
					<div class="grid grid-cols-3 gap-2">
						<div class="bg-muted/30 rounded px-2 py-1.5 text-center border border-border/30">
							<div class="text-sm font-semibold">{formatBytes(repoStats.totalSize)}</div>
							<div class="text-[9px] text-muted-foreground">Size</div>
						</div>
						<div class="bg-muted/30 rounded px-2 py-1.5 text-center border border-border/30">
							<div class="text-sm font-semibold">{repoStats.totalFiles.toLocaleString()}</div>
							<div class="text-[9px] text-muted-foreground">Files</div>
						</div>
						<div class="bg-muted/30 rounded px-2 py-1.5 text-center border border-border/30">
							<div class="text-sm font-semibold">{repoStats.snapshots}</div>
							<div class="text-[9px] text-muted-foreground">Snapshots</div>
						</div>
					</div>
					<!-- Usage bar -->
					{#if repoStats.totalSize > 0}
						<div class="h-2 bg-muted rounded-full overflow-hidden">
							<div class="h-full bg-primary/60 rounded-full transition-all" style="width: {Math.min(100, (repoStats.totalSize / (1024 * 1024 * 1024)) * 10)}%"></div>
						</div>
						<p class="text-[10px] text-muted-foreground mt-1">{repoStats.snapshots} snapshots across {repoStats.totalFiles.toLocaleString()} files</p>
					{/if}
				{:else if !loadingStats}
					<p class="text-xs text-muted-foreground">Loading repository stats...</p>
				{/if}
			</div>
		{/if}

		</div>
		{#if repoConflictName}
			<div class="flex-shrink-0 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
				<AlertTriangle class="w-4 h-4 mt-0.5 flex-shrink-0" />
				<span>
					This repository is already used by <span class="font-medium">"{repoConflictName}"</span>.
					Backups to a shared repository run one at a time (restic locks the repo), not in parallel.
					Click <span class="font-medium">Save anyway</span> to continue.
				</span>
			</div>
		{/if}
		<Dialog.Footer class="flex-shrink-0 border-t mt-auto pt-4">
			<div class="flex items-center gap-2 mr-auto min-w-0">
				<Button variant="outline" size="sm" onclick={testConnection} disabled={testing || !formValid} title={!formValid ? 'Fill in all required fields first' : undefined}>
					{#if testing}<Loader2 class="w-4 h-4 mr-1 animate-spin" />{:else}<Wifi class="w-4 h-4 mr-1" />{/if}
					Test
				</Button>
				{#if isEditing}
					<Button variant="outline" size="sm" class="{destination?.lastTestStatus === 'success' ? 'opacity-30' : ''}" onclick={initRepo} disabled={initializing} title={destination?.lastTestStatus === 'success' ? 'Already initialized' : 'Initialize repository'}>
						{#if initializing}<Loader2 class="w-4 h-4 mr-1 animate-spin" />{:else}<Database class="w-4 h-4 mr-1" />{/if}
						Init repo
					</Button>
				{/if}
				{#if testStatus === 'ok'}
					<span class="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"><Check class="w-3.5 h-3.5 shrink-0" />{testStatusMsg}</span>
				{:else if testStatus === 'needs_init'}
					<span class="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"><Check class="w-3.5 h-3.5 shrink-0" />{testStatusMsg}{#if !isEditing} - done on save{/if}</span>
				{:else if testStatus === 'error'}
					<span class="flex items-center gap-1.5 min-w-0 text-xs text-destructive" title={testStatusMsg}>
						<AlertTriangle class="w-3.5 h-3.5 shrink-0" />
						<span class="truncate">{testStatusMsg}</span>
					</span>
				{/if}
			</div>
			<Button variant="outline" onclick={() => { open = false; onClose(); }}>Cancel</Button>
			<Button onclick={save} disabled={formSaving || !formValid} variant={repoConflictName ? 'destructive' : 'default'} title={!formValid ? 'Fill in all required fields first' : undefined}>
				{#if formSaving}<Loader2 class="w-4 h-4 mr-1 animate-spin" />{:else if repoConflictName}<AlertTriangle class="w-4 h-4 mr-1" />{:else if isEditing}<Check class="w-4 h-4 mr-1" />{:else}<Plus class="w-4 h-4 mr-1" />{/if}
				{repoConflictName ? 'Save anyway' : needsInit && !isEditing ? 'Create and init' : isEditing ? 'Save' : 'Create'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
