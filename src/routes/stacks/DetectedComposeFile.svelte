<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Loader2, MapPin } from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		stackName: string;
		envId: number;
		disabled?: boolean;
		onSelect: (path: string, name: string) => Promise<void>;
	}
	let { stackName, envId, disabled = false, onSelect }: Props = $props();
	let path = $state<string | null>(null);
	let error = $state<string | null>(null);
	let checking = $state(false);
	let selecting = $state(false);

	$effect(() => {
		const target = `/api/stacks/path-hints?name=${encodeURIComponent(stackName)}&env=${envId}`;
		const controller = new AbortController();
		path = null;
		error = null;
		checking = true;
		async function check() {
			try {
				const response = await fetch(target, { signal: controller.signal });
				const data = await response.json();
				if (controller.signal.aborted) { return; }
				if (!response.ok) { throw new Error(data.error || m.stacks_fs_detect_failed()); }
				const files = data.configFiles;
				if (files === null) { return; }
				if (!Array.isArray(files) || files.length != 1 || typeof files[0] != 'string' || !/^\/.*\.ya?ml$/i.test(files[0])) {
					throw new Error(m.stacks_fs_detect_invalid_labels());
				}
				path = files[0];
			} catch (cause) {
				if (!controller.signal.aborted) { error = cause instanceof Error ? cause.message : m.stacks_fs_detect_failed(); }
			} finally {
				if (!controller.signal.aborted) { checking = false; }
			}
		}
		void check();
		return () => controller.abort();
	});

	async function select() {
		if (!path || disabled || selecting) { return; }
		selecting = true;
		try {
			await onSelect(path, path.slice(path.lastIndexOf('/') + 1));
		} finally {
			selecting = false;
		}
	}
</script>

<div class="mb-4 w-full max-w-sm space-y-2 text-xs">
	{#if checking}
		<p class="flex items-center justify-center gap-2 text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" />{m.stacks_fs_detect_checking()}</p>
	{:else if path}
		<p class="text-muted-foreground">{m.stacks_fs_detect_from_labels()}</p>
		<code class="block break-all">{path}</code>
		<p class="text-muted-foreground">{m.stacks_fs_detect_shared_files_hint()}</p>
		<Button variant="outline" size="sm" onclick={select} disabled={disabled || selecting}>
			{#if selecting}<Loader2 class="h-4 w-4 animate-spin" />{:else}<MapPin class="h-4 w-4" />{/if}
			{m.stacks_fs_detect_use_file()}
		</Button>
		<p class="text-muted-foreground">{m.stacks_fs_detect_use_file_hint()}</p>
	{:else if !error}
		<p role="status" class="text-muted-foreground">{m.stacks_fs_detect_not_found()}</p>
	{/if}
	{#if error}<p role="status" class="break-words text-amber-700 dark:text-amber-400">{m.stacks_fs_detect_error_hint({ error })}</p>{/if}
</div>
