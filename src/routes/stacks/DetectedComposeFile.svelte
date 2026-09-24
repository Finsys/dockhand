<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Loader2, MapPin } from 'lucide-svelte';

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
				if (!response.ok) { throw new Error(data.error || 'Could not detect a Compose file.'); }
				const files = data.configFiles;
				if (!Array.isArray(files) || files.length != 1 || typeof files[0] != 'string' || !/^\/.*\.ya?ml$/i.test(files[0])) {
					throw new Error('The labels must specify exactly one absolute path to a YAML file.');
				}
				path = files[0];
			} catch (cause) {
				if (!controller.signal.aborted) { error = cause instanceof Error ? cause.message : 'Could not detect a Compose file.'; }
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
		<p class="flex items-center justify-center gap-2 text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" />Checking Compose path labels...</p>
	{:else if path}
		<p class="text-muted-foreground">Detected from container labels:</p>
		<code class="block break-all">{path}</code>
		<p class="text-muted-foreground">Uses files on Dockhand's filesystem. For a remote environment, these must be the same shared files.</p>
		<Button variant="outline" size="sm" onclick={select} disabled={disabled || selecting}>
			{#if selecting}<Loader2 class="h-4 w-4 animate-spin" />{:else}<MapPin class="h-4 w-4" />{/if}
			Use detected file
		</Button>
		<p class="text-muted-foreground">Loads the file into the editor, just like Browse. Click Save to keep the assignment.</p>
	{/if}
	{#if error}<p role="status" class="break-words text-amber-700 dark:text-amber-400">{error} You can still browse for a file manually.</p>{/if}
</div>
