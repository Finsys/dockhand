<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Copy, Loader2 } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { appendEnvParam } from '$lib/stores/environment';
	import { focusFirstInput } from '$lib/utils';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		volumeName: string;
		envId?: number | null;
		onclose: () => void;
		onsuccess: () => void;
	}

	let { open = $bindable(), volumeName, envId, onclose, onsuccess }: Props = $props();

	let newName = $state('');
	let cloning = $state(false);
	let error = $state<string | null>(null);

	// Generate a default name when opening
	$effect(() => {
		if (open) {
			newName = `${volumeName}-copy`;
			error = null;
		}
	});

	function handleOpenChange(isOpen: boolean) {
		if (!isOpen) {
			onclose();
		}
	}

	async function handleClone() {
		if (!newName.trim()) {
			error = m.volumes_clone_error_name_required();
			return;
		}

		cloning = true;
		error = null;

		try {
			const url = appendEnvParam(`/api/volumes/${encodeURIComponent(volumeName)}/clone`, envId);
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newName.trim() })
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.details || data.error || m.volumes_clone_error_failed());
			}

			toast.success(m.volumes_clone_toast_cloned({ name: newName }));
			onsuccess();
			open = false;
		} catch (e: any) {
			error = e.message || m.volumes_clone_error_failed();
		} finally {
			cloning = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (isOpen) focusFirstInput(); handleOpenChange(isOpen); }}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Copy class="w-5 h-5" />
				{m.volumes_clone_title()}
			</Dialog.Title>
			<Dialog.Description>
				{m.volumes_clone_description({ name: volumeName })}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="new-name">{m.volumes_clone_new_name_label()}</Label>
				<Input
					id="new-name"
					bind:value={newName}
					placeholder={m.volumes_clone_new_name_placeholder()}
					disabled={cloning}
					onkeydown={(e) => e.key === 'Enter' && handleClone()}
				/>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<p class="text-xs text-muted-foreground">
				{m.volumes_clone_note()}
			</p>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={cloning}>
				{m.volumes_cancel()}
			</Button>
			<Button onclick={handleClone} disabled={cloning || !newName.trim()}>
				{#if cloning}
					<Loader2 class="w-4 h-4 animate-spin" />
				{:else}
					<Copy class="w-4 h-4" />
				{/if}
				{m.volumes_clone_submit()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
