<script lang="ts">
	import { onMount } from "svelte";
	import * as Dialog from "$lib/components/ui/dialog";
	import CodeEditor from "$lib/components/CodeEditor.svelte";
	import { Layers, X } from "lucide-svelte";
	import { focusFirstInput } from "$lib/utils";
	import { ErrorDialog } from "$lib/components/ui/error-dialog";
	import NetworkGraphViewer from "./NetworkGraphViewer.svelte";
	import type { NetworkInfo } from "$lib/types";
	import { m } from "$lib/paraglide/messages.js";


	interface Props {
		open: boolean;
		networks: NetworkInfo[]; // Required for edit mode, optional for create
		onClose: () => void;
	}

	let { open = $bindable(), networks: propNetworks, onClose }: Props = $props();

	let networks = $state<NetworkInfo[]>([]);

	// Form state
	let saving = $state(false);
	let editorTheme = $state<"light" | "dark">("dark");

	// Error dialog state
	let operationError = $state<{
		title: string;
		message: string;
		details?: string;
	} | null>(null);

	// CodeEditor reference for explicit marker updates
	let codeEditorRef: CodeEditor | null = $state(null);

	// NetworkGraphViewer reference for resize on panel toggle
	let graphViewerRef: NetworkGraphViewer | null = $state(null);

	// Display title
	const displayName = "DEMO";

	onMount(() => {
		// Load saved editor theme, or fall back to app theme / system preference
		const savedEditorTheme = localStorage.getItem("dockhand-editor-theme");
		if (savedEditorTheme === "dark" || savedEditorTheme === "light") {
			editorTheme = savedEditorTheme;
		} else {
			const appTheme = localStorage.getItem("theme");
			if (appTheme === "dark" || appTheme === "light") {
				editorTheme = appTheme;
			} else {
				// Fallback to system preference
				editorTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
			}
		}
	});

	function tryClose() {
		handleClose();
	}

	let containerRef: HTMLDivElement | null = $state(null);

	function handleClose() {
		// Reset mode back to prop values
		networks = propNetworks;
		codeEditorRef = null;
		operationError = null;
		onClose();
	}

	// Initialize when dialog opens - ONLY ONCE per open
	let hasInitialized = $state(false);
	$effect(() => {
		if (open && !hasInitialized) {
			hasInitialized = true;
			// Reset mode to prop values on each open
			networks = propNetworks;
		} else if (!open) {
			hasInitialized = false; // Reset when modal closes
		}
	});
</script>

<Dialog.Root
	bind:open
	onOpenChange={(isOpen) => {
		if (isOpen) {
			focusFirstInput();
		} else {
			// No unsaved changes - reset state
			handleClose();
		}
	}}
>
	<Dialog.Content
		class="max-w-none w-[calc(100vw-4rem)] h-[95vh] flex flex-col p-0 gap-0 shadow-xl border-zinc-200 dark:border-zinc-700"
		showCloseButton={false}
	>
		<Dialog.Header class="px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2">
						<div class="p-1.5 rounded-md bg-zinc-200 dark:bg-zinc-700">
							<Layers class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
						</div>
						<div>
							<Dialog.Title class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{m.networks_graph_modal_title()}</Dialog.Title>
							<Dialog.Description class="text-xs text-zinc-500 dark:text-zinc-400">{m.networks_graph_modal_description()}</Dialog.Description>
						</div>
					</div>
				</div>

				<div class="flex items-center gap-2">
					<!-- Close button -->
					<button
						onclick={tryClose}
						class="p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
					>
						<X class="w-4 h-4" />
					</button>
				</div>
			</div>
		</Dialog.Header>

		<!-- Content area -->
		<div bind:this={containerRef} class="flex-1 min-h-0 flex flex-col">
			<!-- Graph tab: Full width -->
			<NetworkGraphViewer bind:this={graphViewerRef} {networks} class="h-full flex-1" />
		</div>

		<!-- Footer -->
		<div class="px-5 py-2.5 border-t border-zinc-200 dark:border-zinc-700 flex items-center justify-between flex-shrink-0" />
	</Dialog.Content>
</Dialog.Root>

<!-- Error dialog for failed operations -->
{#if operationError}
	{@const errorDialogOpen = true}
	<ErrorDialog open={errorDialogOpen} title={operationError.title} message={operationError.message} details={operationError.details} onClose={() => (operationError = null)} />
{/if}
