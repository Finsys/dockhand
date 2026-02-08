<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Copy, Loader2 } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { appendEnvParam } from '$lib/stores/environment';
	import { focusFirstInput } from '$lib/utils';

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
			error = 'Please enter a name for the new volume';
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
				throw new Error(data.details || data.error || 'Failed to clone volume');
			}

			toast.success(`Volume cloned as "${newName}"`);
			onsuccess();
			open = false;
		} catch (e: any) {
			error = e.message || 'Failed to clone volume';
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
				Clone volume
			</Dialog.Title>
			<Dialog.Description>
				Create a new volume with the same driver and options as "{volumeName}".
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="new-name">New volume name</Label>
				<Input
					id="new-name"
					bind:value={newName}
					placeholder="Enter new volume name"
					disabled={cloning}
					onkeydown={(e) => e.key === 'Enter' && handleClone()}
				/>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<p class="text-xs text-muted-foreground">
				Note: This creates an empty volume with the same configuration. To copy data, use the Export feature on the source volume and import into the new volume.
			</p>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)} disabled={cloning}>
				Cancel
			</Button>
			<Button onclick={handleClone} disabled={cloning || !newName.trim()}>
				{#if cloning}
					<Loader2 class="w-4 h-4 animate-spin" />
				{:else}
					<Copy class="w-4 h-4" />
				{/if}
				Clone
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
