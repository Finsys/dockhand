<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import CopyButton from '$lib/components/CopyButton.svelte';

	interface Props {
		url: string;
		label?: string;
	}

	let { url, label = 'Webhook URL' }: Props = $props();
</script>

<div class="space-y-2">
	<Label>{label}</Label>
	<div class="flex gap-2">
		<Input value={url} readonly class="font-mono text-xs bg-background" />
		<CopyButton text={url} title="Copy URL" />
	</div>
</div>
