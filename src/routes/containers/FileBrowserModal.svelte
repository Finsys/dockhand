<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { FolderOpen, Loader2 } from 'lucide-svelte';
	import FileBrowserPanel from './FileBrowserPanel.svelte';
	import ModalHeader from '$lib/components/ModalHeader.svelte';
	import { canAccess } from '$lib/stores/auth';
	import { fileBrowserStartPath } from '$lib/utils/file-browser-start';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		containerId: string;
		containerName: string;
		containerImage?: string;
		envId?: number;
		onclose: () => void;
	}

	let { open = $bindable(), containerId, containerName, containerImage = '', envId, onclose }: Props = $props();

	// The list API has no WorkingDir, so inspect before mounting the panel; otherwise it
	// would load '/' first and then jump (#1285). Any failure or a slow env just opens root.
	let startPath = $state<string | null>(null);

	$effect(() => {
		if (!open || !containerId) return;
		const id = containerId;
		const params = envId ? `?env=${envId}` : '';
		let cancelled = false;
		fetch(`/api/containers/${encodeURIComponent(id)}${params}`, { signal: AbortSignal.timeout(5000) })
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (!cancelled) startPath = fileBrowserStartPath(data?.Config?.WorkingDir);
			})
			.catch(() => {
				if (!cancelled) startPath = '/';
			});
		return () => {
			cancelled = true;
			// Reset on close/switch so a reopen never mounts the panel with the previous path
			startPath = null;
		};
	});

	function handleOpenChange(isOpen: boolean) {
		if (!isOpen) {
			onclose();
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
	<Dialog.Content class="max-w-4xl h-[90vh] sm:h-[80vh] flex flex-col" onOpenAutoFocus={(e) => e.preventDefault()}>
		<Dialog.Header>
			<ModalHeader icon={FolderOpen} title={m.containers_files_browse_title()} name={containerName} iconImage={containerImage} iconName={containerName} />
			<Dialog.Description>
				{m.containers_files_modal_description()}
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex-1 overflow-hidden border rounded-lg">
			{#if startPath === null}
				<div class="flex items-center justify-center h-full text-muted-foreground">
					<Loader2 class="w-5 h-5 animate-spin" />
				</div>
			{:else}
				<FileBrowserPanel {containerId} {envId} initialPath={startPath} canEdit={$canAccess('containers', 'exec')} />
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
