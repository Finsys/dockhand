<script lang="ts">
	import { Copy, Check, XCircle, FolderOpen, FolderSync } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

	interface Props {
		label: string;
		path: string | null;
		placeholder: string;
		onCopy: () => void;
		onBrowse: () => void;
		onChangeLocation?: () => void; // Optional: relocate entire folder
		defaultText?: string;
		isSuggested?: boolean;
		copied?: 'ok' | 'error' | null;
		sourceHint?: string; // e.g., "Using default location"
	}

	let {
		label,
		path,
		placeholder,
		onCopy,
		onBrowse,
		onChangeLocation,
		defaultText = 'Default location',
		isSuggested = false,
		copied = null,
		sourceHint
	}: Props = $props();

	// Truncate long paths - only truncate if really necessary
	function truncatePath(pathStr: string, maxLength: number = 80): { truncated: string; full: string } {
		if (!pathStr || pathStr.length <= maxLength) return { truncated: pathStr, full: pathStr };

		const parts = pathStr.split('/');
		const filename = parts.pop() || '';
		const parent = parts.pop() || '';
		const grandparent = parts.pop() || '';

		// Try to show more context: .../{grandparent}/{parent}/{filename}
		let truncated = `.../${grandparent}/${parent}/${filename}`;
		if (truncated.length > maxLength) {
			// Fall back to just parent/filename
			truncated = `.../${parent}/${filename}`;
		}
		return { truncated, full: pathStr };
	}

	const displayPath = $derived(path ? truncatePath(path) : { truncated: '', full: '' });
</script>

<div class="flex flex-col gap-0.5">
<div class="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
	<span class="font-medium text-zinc-600 dark:text-zinc-300 shrink-0">{label}</span>
	<code
		class="flex-1 min-w-0 truncate font-mono h-6 leading-6 {!path || isSuggested ? 'text-zinc-400 dark:text-zinc-500 italic' : ''}"
		title={displayPath.full}
	>
		{displayPath.truncated || defaultText}
	</code>
	<button
		onclick={onBrowse}
		class="p-1 rounded transition-colors shrink-0 hover:bg-zinc-200 dark:hover:bg-zinc-700"
		title={`Browse for ${label.toLowerCase()}`}
	>
		<FolderOpen class="w-3.5 h-3.5" />
	</button>
	{#if onChangeLocation}
		<button
			onclick={onChangeLocation}
			class="p-1 rounded transition-colors shrink-0 hover:bg-zinc-200 dark:hover:bg-zinc-700"
			title="Change location"
		>
			<FolderSync class="w-3.5 h-3.5" />
		</button>
	{/if}
	<button
		onclick={onCopy}
		class="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors shrink-0 {!path ? 'opacity-40 cursor-not-allowed' : ''}"
		title="Copy path"
		disabled={!path}
	>
		{#if copied === 'error'}
			<Tooltip.Root open>
				<Tooltip.Trigger>
					<XCircle class="w-3.5 h-3.5 text-red-500" />
				</Tooltip.Trigger>
				<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
			</Tooltip.Root>
		{:else if copied === 'ok'}
			<Check class="w-3.5 h-3.5 text-green-500" />
		{:else}
			<Copy class="w-3.5 h-3.5" />
		{/if}
	</button>
</div>
{#if sourceHint}
	<span class="text-[10px] text-zinc-400 dark:text-zinc-500 pl-[4.5rem]">{sourceHint}</span>
{/if}
</div>
