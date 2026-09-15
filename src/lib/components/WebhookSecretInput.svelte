<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Key } from 'lucide-svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import { generateWebhookSecret } from '$lib/utils/webhook-secret';

	interface Props {
		id: string;
		value?: string;
		error?: string;
		label?: string;
		showCopy?: boolean;
		oninput?: () => void;
	}

	let {
		id,
		value = $bindable(''),
		error,
		label = 'Webhook secret',
		showCopy = false,
		oninput
	}: Props = $props();
</script>

<div class="space-y-2">
	<Label for={id}>{label}</Label>
	<div class="flex gap-2">
		<Input
			{id}
			bind:value
			placeholder="Required - generate or paste a secret"
			class="font-mono text-xs {error ? 'border-destructive focus-visible:ring-destructive' : ''}"
			oninput={() => oninput?.()}
		/>
		{#if showCopy && value}
			<CopyButton text={value} title="Copy secret" />
		{/if}
		<Tooltip.Root>
			<Tooltip.Trigger>
				<Button
					variant="outline"
					size="sm"
					type="button"
					onclick={() => value = generateWebhookSecret()}
				>
					<Key class="w-4 h-4" />
				</Button>
			</Tooltip.Trigger>
			<Tooltip.Content>Generate secret</Tooltip.Content>
		</Tooltip.Root>
	</div>
	{#if error}
		<p class="text-xs text-destructive">{error}</p>
	{/if}
</div>
