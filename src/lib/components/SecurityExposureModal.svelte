<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { ShieldAlert } from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		onDismiss: (dontShowAgain: boolean) => void;
	}

	let { open = $bindable(), onDismiss }: Props = $props();

	let dontShowAgain = $state(false);

	function close() {
		onDismiss(dontShowAgain);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<ShieldAlert class="w-5 h-5 text-destructive" />
				{m.security_exposure_title()}
			</Dialog.Title>
		</Dialog.Header>

		<div class="space-y-3 text-sm">
			<p>{m.security_exposure_risk()}</p>
			<p>
				{m.security_exposure_enable_auth_before()}
				<span class="font-medium">{m.security_exposure_enable_auth_path()}</span>
				{m.security_exposure_enable_auth_after()}
			</p>
		</div>

		<Dialog.Footer class="flex items-center justify-between gap-3 sm:justify-between">
			<label class="flex items-center gap-2 text-sm text-muted-foreground">
				<Checkbox bind:checked={dontShowAgain} />
				{m.security_exposure_dont_show_again()}
			</label>
			<Button onclick={close}>{m.security_exposure_dismiss()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
