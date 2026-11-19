<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { ShieldAlert } from 'lucide-svelte';

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
				Unsecured exposure
			</Dialog.Title>
		</Dialog.Header>

		<div class="space-y-3 text-sm">
			<p>
				This Dockhand is listening beyond localhost, authentication is disabled, and the
				Docker socket is mounted read-write. In this state anyone who can reach it can create
				containers on the host - which means full control of this machine.
			</p>
			<p>
				If this instance is reachable from the internet, enable authentication in
				<span class="font-medium">Settings &gt; Authentication</span> and create an admin user.
				Even with authentication on, keep Dockhand behind a firewall or VPN - it is an admin
				interface for Docker and should never be exposed directly.
			</p>
		</div>

		<Dialog.Footer class="flex items-center justify-between gap-3 sm:justify-between">
			<label class="flex items-center gap-2 text-sm text-muted-foreground">
				<Checkbox bind:checked={dontShowAgain} />
				I am aware, do not show this again
			</label>
			<Button onclick={close}>Got it</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
