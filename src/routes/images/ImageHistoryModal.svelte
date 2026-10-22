<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Layers } from 'lucide-svelte';
	import ImageLayersView from './ImageLayersView.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { splitAtName } from '$lib/i18n/split';

	interface Props {
		open: boolean;
		imageId: string;
		imageName?: string;
	}

	let { open = $bindable(), imageId, imageName }: Props = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-5xl max-h-[90vh] flex flex-col min-h-[400px] !animate-none">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<Layers class="w-5 h-5" />
				{splitAtName(m.images_list_layers_title)[0]}<span class="text-muted-foreground font-normal">{imageName || imageId.slice(7, 19)}</span>{splitAtName(m.images_list_layers_title)[1]}
			</Dialog.Title>
		</Dialog.Header>

		<div class="flex-1 overflow-auto space-y-4 pr-2">
			<ImageLayersView
				imageId={imageId}
				imageName={imageName}
				visible={open}
			/>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>{m.ui_close()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
