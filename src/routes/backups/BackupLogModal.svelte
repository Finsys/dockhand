<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Loader2, CheckCircle, XCircle, Archive, Copy, Check, Square } from 'lucide-svelte';
	import LogConsole from '$lib/components/LogConsole.svelte';

	// Backup-only progress window: shown for the Play-on-a-config path, which has no
	// form modal to host its log. Restore shows its log inline inside RestoreModal.
	interface Props {
		open: boolean;
		title: string;
		status: 'running' | 'success' | 'error';
		progress?: number;
		logs: string[];
		error?: string;
		onStop?: () => void;
	}

	let { open = $bindable(), title, status, progress = 0, logs, error, onStop }: Props = $props();

	let copied = $state(false);

	function copyLogs() {
		const text = logs.join('\n') + (error ? '\n' + error : '');
		navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => { copied = false; }, 2000);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-4xl h-[60vh] flex flex-col overflow-hidden" onOpenAutoFocus={(e) => e.preventDefault()}>
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Archive class="w-5 h-5" />
				{title}
				{#if status === 'running'}
					<Badge variant="secondary" class="text-xs gap-1"><Loader2 class="w-3 h-3 animate-spin" />Running</Badge>
				{:else if status === 'success'}
					<Badge variant="secondary" class="text-xs gap-1 text-green-500"><CheckCircle class="w-3 h-3" />Completed</Badge>
				{:else}
					<Badge variant="destructive" class="text-xs gap-1"><XCircle class="w-3 h-3" />Failed</Badge>
				{/if}
			</Dialog.Title>
		</Dialog.Header>

		{#if status === 'running' && progress > 0}
			<div class="h-1.5 bg-muted rounded-full overflow-hidden shrink-0">
				<div class="h-full bg-primary transition-all duration-300 rounded-full" style="width: {progress}%"></div>
			</div>
		{/if}

		<div class="relative flex min-h-0 flex-1 flex-col">
			<!-- Shared console (pills, dark toggle, auto-scroll) — same as the backup
			     and container/stack restore logs, so all operation logs look identical. -->
			<LogConsole lines={logs} class="flex-1 min-h-0" />
			{#if status === 'running' && logs.length === 0}
				<div class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
					<Loader2 class="h-3 w-3 animate-spin" /><span>Waiting for output…</span>
				</div>
			{/if}
			{#if error}<div class="mt-1 text-xs text-red-400">{error}</div>{/if}
			<!-- Copy button -->
			{#if logs.length > 0}
				<button
					type="button"
					class="absolute top-8 right-3 rounded border bg-background/80 p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
					onclick={copyLogs}
					title="Copy log content"
				>
					{#if copied}<Check class="w-3.5 h-3.5 text-green-500" />{:else}<Copy class="w-3.5 h-3.5" />{/if}
				</button>
			{/if}
		</div>

		<Dialog.Footer class="pt-3">
			{#if status === 'running' && onStop}
				<Button variant="destructive" onclick={onStop}>
					<Square class="w-3.5 h-3.5 mr-1" />
					Stop
				</Button>
			{/if}
			<Button variant="outline" onclick={() => (open = false)}>
				{status === 'running' ? 'Run in background' : 'Close'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
