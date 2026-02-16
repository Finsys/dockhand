<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { AlertCircle, Copy, Check, XCircle, AlertTriangle, CheckCircle2 } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface Props {
		open: boolean;
		title: string;
		message: string;
		details?: string;
		onClose: () => void;
	}

	let { open = $bindable(), title, message, details, onClose }: Props = $props();
	let copied = $state<'ok' | 'error' | null>(null);

	interface ParsedOutput {
		warnings: string[];
		steps: { action: string; status: 'creating' | 'created' | 'starting' | 'started' | 'error' }[];
		error: string | null;
		raw: string;
		parsed: boolean;
	}

	// Parse docker compose output into structured format
	function parseDockerOutput(text: string): ParsedOutput {
		const result: ParsedOutput = {
			warnings: [],
			steps: [],
			error: null,
			raw: text,
			parsed: false
		};

		try {
			const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

			for (const line of lines) {
				// Parse time="..." level=warning msg="..."
				const warningMatch = line.match(/time="[^"]*"\s+level=warning\s+msg="([^"]+)"/);
				if (warningMatch) {
					result.warnings.push(warningMatch[1]);
					result.parsed = true;
					continue;
				}

				// Parse container/network steps: "Network foo Creating" or "Container foo-1 Created"
				const stepMatch = line.match(/^\s*(Network|Container|Volume)\s+(\S+)\s+(Creating|Created|Starting|Started|Stopping|Stopped|Removing|Removed)\s*$/i);
				if (stepMatch) {
					const [, type, name, status] = stepMatch;
					const normalizedStatus = status.toLowerCase() as any;
					result.steps.push({
						action: `${type} ${name}`,
						status: normalizedStatus
					});
					result.parsed = true;
					continue;
				}

				// Parse error lines
				if (line.startsWith('Error') || line.includes('error') || line.includes('failed')) {
					result.error = result.error ? `${result.error}\n${line}` : line;
					result.parsed = true;
					continue;
				}
			}

			// If we parsed something but have no clear error, check for remaining unparsed content
			if (result.parsed && !result.error) {
				const unparsed = lines.filter(line => {
					if (line.match(/time="[^"]*"\s+level=warning/)) return false;
					if (line.match(/^\s*(Network|Container|Volume)\s+\S+\s+(Creating|Created|Starting|Started|Stopping|Stopped|Removing|Removed)\s*$/i)) return false;
					return true;
				});
				if (unparsed.length > 0) {
					result.error = unparsed.join('\n');
				}
			}
		} catch {
			// Parsing failed, will show raw message
		}

		return result;
	}

	const parsed = $derived(parseDockerOutput(message));

	async function copyError() {
		const text = details ? `${message}\n\n${details}` : message;
		const ok = await copyToClipboard(text);
		copied = ok ? 'ok' : 'error';
		setTimeout(() => (copied = null), 2000);
	}

	function handleClose() {
		open = false;
		onClose();
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => !o && handleClose()}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2 text-destructive">
				<AlertCircle class="w-5 h-5" />
				{title}
			</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-3 max-h-[60vh] overflow-y-auto">
			{#if parsed.parsed}
				<!-- Parsed docker compose output -->
				{#if parsed.warnings.length > 0}
					<div class="space-y-1">
						{#each parsed.warnings as warning}
							<div class="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 px-2.5 py-1.5 rounded-md">
								<AlertTriangle class="w-3.5 h-3.5 shrink-0 mt-0.5" />
								<span>{warning}</span>
							</div>
						{/each}
					</div>
				{/if}

				{#if parsed.steps.length > 0}
					<div class="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-2.5 space-y-1">
						{#each parsed.steps as step}
							<div class="flex items-center gap-2 text-xs font-mono">
								{#if step.status === 'created' || step.status === 'started' || step.status === 'removed' || step.status === 'stopped'}
									<CheckCircle2 class="w-3.5 h-3.5 text-green-500" />
								{:else if step.status === 'error'}
									<XCircle class="w-3.5 h-3.5 text-red-500" />
								{:else}
									<div class="w-3.5 h-3.5 rounded-full border-2 border-zinc-400"></div>
								{/if}
								<span class="text-zinc-600 dark:text-zinc-300">{step.action}</span>
								<span class="text-zinc-400 dark:text-zinc-500 capitalize">{step.status}</span>
							</div>
						{/each}
					</div>
				{/if}

				{#if parsed.error}
					<div class="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md p-3 relative group">
						<button
							onclick={copyError}
							class="absolute top-2 right-2 p-1 rounded text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-opacity"
							title="Copy error"
						>
							{#if copied === 'error'}
								<Tooltip.Root open>
									<Tooltip.Trigger>
										<XCircle class="w-3.5 h-3.5 text-red-500" />
									</Tooltip.Trigger>
									<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
								</Tooltip.Root>
							{:else if copied === 'ok'}
								<Check class="w-3.5 h-3.5" />
							{:else}
								<Copy class="w-3.5 h-3.5" />
							{/if}
						</button>
						<pre class="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words font-mono pr-6">{parsed.error}</pre>
					</div>
				{/if}
			{:else}
				<!-- Fallback to raw message -->
				<div class="relative group">
					<button
						onclick={copyError}
						class="absolute top-1 right-1 p-1 rounded text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity"
						title="Copy error"
					>
						{#if copied}
							<Check class="w-3.5 h-3.5" />
						{:else}
							<Copy class="w-3.5 h-3.5" />
						{/if}
					</button>
					<pre class="text-sm whitespace-pre-wrap font-sans pr-6">{message}</pre>
				</div>
			{/if}

			{#if details}
				<pre class="text-xs bg-zinc-100 dark:bg-zinc-800 p-3 rounded-md overflow-auto max-h-64 whitespace-pre-wrap break-all">{details}</pre>
			{/if}
		</div>
		<Dialog.Footer class="flex gap-2 sm:justify-end">
			<Button onclick={handleClose}>OK</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
