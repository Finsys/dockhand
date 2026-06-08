<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as Dialog from "$lib/components/ui/dialog";
	import { Label } from "$lib/components/ui/label";
	import { Input } from "$lib/components/ui/input";
	import { Plus, Check, RefreshCw, PlugZap } from "lucide-svelte";
	import { toast } from "svelte-sonner";
	import { focusFirstInput } from "$lib/utils";

	export interface OpServiceAccount {
		id: number;
		name: string;
		hasToken: boolean;
		createdAt: string;
	}

	interface Props {
		open: boolean;
		account?: OpServiceAccount | null;
		onClose: () => void;
		onSaved: () => void;
	}

	let {
		open = $bindable(),
		account = null,
		onClose,
		onSaved,
	}: Props = $props();

	const isEditing = $derived(account !== null);

	let formName = $state("");
	let formToken = $state("");
	let formError = $state("");
	let formSaving = $state(false);
	let formTesting = $state(false);

	function resetForm() {
		formName = "";
		formToken = "";
		formError = "";
		formSaving = false;
		formTesting = false;
	}

	$effect(() => {
		if (open) {
			if (account) {
				formName = account.name;
				formToken = "";
				formError = "";
			} else {
				resetForm();
			}
		}
	});

	async function testCurrent() {
		formTesting = true;
		formError = "";
		try {
			let response: Response;
			if (isEditing && !formToken.trim()) {
				response = await fetch(`/api/onepassword/${account!.id}/test`, {
					method: "POST",
				});
			} else {
				if (!formToken.trim()) {
					formError = "Provide a token to test";
					return;
				}
				response = await fetch("/api/onepassword/test", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ token: formToken.trim() }),
				});
			}
			const data = await response.json();
			if (data.ok) {
				toast.success("1Password connection works");
			} else {
				toast.error(data.error || "Connection failed");
				formError = data.error || "Connection failed";
			}
		} catch {
			toast.error("Connection test failed");
		} finally {
			formTesting = false;
		}
	}

	async function save() {
		if (!formName.trim()) {
			formError = "Name is required";
			return;
		}
		if (!isEditing && !formToken.trim()) {
			formError = "Token is required";
			return;
		}

		formSaving = true;
		formError = "";

		try {
			const body: Record<string, string> = { name: formName.trim() };
			if (formToken.trim()) body.token = formToken.trim();

			const url = isEditing
				? `/api/onepassword/${account!.id}`
				: "/api/onepassword";
			const method = isEditing ? "PUT" : "POST";

			const response = await fetch(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (response.ok) {
				open = false;
				onSaved();
			} else {
				const data = await response.json();
				formError =
					data.error ||
					`Failed to ${isEditing ? "update" : "create"} service account`;
			}
		} catch {
			formError = `Failed to ${isEditing ? "update" : "create"} service account`;
		} finally {
			formSaving = false;
		}
	}

	function handleClose() {
		open = false;
		onClose();
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		if (o) {
			formError = "";
			focusFirstInput();
		}
	}}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title
				>{isEditing ? "Edit" : "Add"} 1Password service account</Dialog.Title
			>
		</Dialog.Header>
		<div class="space-y-4">
			{#if formError}
				<div class="text-sm text-red-600 dark:text-red-400">
					{formError}
				</div>
			{/if}
			<div class="space-y-2">
				<Label for="op-name">Name</Label>
				<Input
					id="op-name"
					bind:value={formName}
					placeholder="Production secrets"
				/>
			</div>
			<div class="space-y-2">
				<Label for="op-token">Service account token</Label>
				<Input
					id="op-token"
					type="password"
					bind:value={formToken}
					placeholder={isEditing
						? "leave blank to keep existing"
						: "ops_eyJ..."}
				/>
				<p class="text-xs text-muted-foreground">
					Token is stored encrypted
				</p>
			</div>
		</div>
		<Dialog.Footer>
			<Button
				variant="outline"
				onclick={testCurrent}
				disabled={formTesting || formSaving}
			>
				{#if formTesting}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else}
					<PlugZap class="w-4 h-4 mr-1" />
				{/if}
				Test connection
			</Button>
			<div class="flex-1"></div>
			<Button variant="outline" onclick={handleClose}>Cancel</Button>
			<Button onclick={save} disabled={formSaving}>
				{#if formSaving}
					<RefreshCw class="w-4 h-4 mr-1 animate-spin" />
				{:else if isEditing}
					<Check class="w-4 h-4" />
				{:else}
					<Plus class="w-4 h-4" />
				{/if}
				{isEditing ? "Save" : "Add"}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
