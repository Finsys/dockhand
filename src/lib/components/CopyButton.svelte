<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Check, Copy, XCircle } from 'lucide-svelte';
	import { copyToClipboard } from '$lib/utils/clipboard';

	interface Props {
		text: string;
		title?: string;
	}

	let { text, title = 'Copy' }: Props = $props();

	let copied = $state<'ok' | 'error' | null>(null);

	async function copyText() {
		const ok = await copyToClipboard(text);
		copied = ok ? 'ok' : 'error';
		setTimeout(() => copied = null, 2000);
	}
</script>

<Button variant="outline" size="sm" onclick={copyText} {title}>
	{#if copied === 'error'}
		<Tooltip.Root open>
			<Tooltip.Trigger>
				<XCircle class="w-4 h-4 text-red-500" />
			</Tooltip.Trigger>
			<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
		</Tooltip.Root>
	{:else if copied === 'ok'}
		<Check class="w-4 h-4 text-green-500" />
	{:else}
		<Copy class="w-4 h-4" />
	{/if}
</Button>
