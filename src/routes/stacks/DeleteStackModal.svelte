<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Trash2, Folder, Database, Loader2, ArrowRight } from 'lucide-svelte';
	import GitGenericIcon from '$lib/components/icons/GitGenericIcon.svelte';
	import StackIcon from '$lib/components/StackIcon.svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { m } from '$lib/paraglide/messages.js';

	// The parent owns the fetch; onConfirm receives what the user chose to remove.
	let {
		open = $bindable(false),
		stackName = '',
		envId = null as number | null,
		stackIcon = null as string | null,
		onConfirm,
	}: {
		open?: boolean;
		stackName?: string;
		envId?: number | null;
		stackIcon?: string | null;
		onConfirm: (opts: { deleteFiles: boolean; deleteVolumes: boolean }) => void | Promise<void>;
	} = $props();

	interface Preview {
		sourceType: string | null;
		stackDir: string | null;
		gitDir: string | null;
		namedVolumes: string[];
		canDeleteFiles: boolean;
	}

	let preview = $state<Preview | null>(null);
	let loading = $state(false);
	let busy = $state(false);

	// What to remove — the user ticks each. Containers are ALWAYS removed (the point of the
	// operation), so they aren't a checkbox. Files default ON (the common intent), volumes
	// default OFF (destructive, unrecoverable).
	let removeFiles = $state(true);
	let removeVolumes = $state(false);

	const hasFiles = $derived(!!(preview?.stackDir || preview?.gitDir));
	const hasVolumes = $derived((preview?.namedVolumes?.length ?? 0) > 0);

	$effect(() => {
		if (open && stackName) {
			loading = true;
			preview = null;
			removeFiles = true;
			removeVolumes = false;
			fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(stackName)}/delete-preview`, envId))
				.then((r) => (r.ok ? r.json() : null))
				.then((d) => { preview = d; })
				.catch(() => { preview = null; })
				.finally(() => { loading = false; });
		}
	});

	// Fixed set of outcome lines — ALWAYS shown (so the box never resizes as you toggle),
	// each flipping between a red "deleted" and a green "kept" state. `delete: null` = no
	// choice (containers are always removed). `kind` picks the icon for the "kept" state.
	const willHappen = $derived.by(() => {
		const lines: { delete: boolean | null; kind: 'container' | 'files' | 'volumes'; text: string }[] = [
			{ delete: null, kind: 'container', text: m.stacks_delete_will_remove_containers() },
		];
		if (hasFiles) {
			lines.push(removeFiles
				? { delete: true, kind: 'files', text: m.stacks_delete_will_delete_files() }
				: { delete: false, kind: 'files', text: m.stacks_delete_will_keep_files() });
		}
		if (hasVolumes) {
			const n = preview!.namedVolumes.length;
			lines.push(removeVolumes
				? { delete: true, kind: 'volumes', text: m.stacks_delete_will_delete_volumes({ count: n }) }
				: { delete: false, kind: 'volumes', text: m.stacks_delete_will_keep_volumes({ count: n }) });
		}
		return lines;
	});

	async function run() {
		busy = true;
		try {
			await onConfirm({ deleteFiles: hasFiles && removeFiles, deleteVolumes: hasVolumes && removeVolumes });
			open = false;
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<StackIcon icon={stackIcon} {stackName} {envId} class="w-5 h-5 shrink-0 text-muted-foreground" />
				{m.stacks_delete_title({ name: stackName })}
			</Dialog.Title>
			<Dialog.Description>
				{m.stacks_delete_description()}
			</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<div class="flex items-center gap-2 py-4 text-sm text-muted-foreground">
				<Loader2 class="w-4 h-4 animate-spin" /> {m.stacks_delete_checking()}
			</div>
		{:else if preview}
			<div class="my-1 space-y-3">
				{#if hasFiles}
					<label class="flex items-start gap-2.5 cursor-pointer">
						<Checkbox bind:checked={removeFiles} class="mt-0.5" />
						<Folder class="w-4 h-4 shrink-0 translate-y-0.5 text-amber-500" />
						<div class="min-w-0">
							<div class="text-sm">{m.stacks_delete_files_label()}</div>
							{#if preview.stackDir}
								<code class="block break-all text-xs text-muted-foreground">{preview.stackDir}</code>
							{/if}
							{#if preview.gitDir}
								<div class="mt-1 flex items-start gap-1.5">
									<GitGenericIcon class="w-3.5 h-3.5 shrink-0 translate-y-0.5 text-purple-500" />
									<code class="break-all text-xs text-muted-foreground">{preview.gitDir}</code>
								</div>
							{/if}
						</div>
					</label>
				{/if}

				{#if hasVolumes}
					<label class="flex items-start gap-2.5 cursor-pointer">
						<Checkbox bind:checked={removeVolumes} class="mt-0.5" />
						<Database class="w-4 h-4 shrink-0 translate-y-0.5 text-blue-500" />
						<div class="min-w-0">
							<div class="text-sm">{m.stacks_delete_volumes_label()} <span class="text-muted-foreground">{m.stacks_delete_volumes_unrecoverable()}</span></div>
							<div class="flex flex-wrap gap-1 mt-0.5">
								{#each preview.namedVolumes as v}
									<code class="rounded bg-muted px-1.5 py-0.5 text-xs">{v}</code>
								{/each}
							</div>
						</div>
					</label>
				{/if}

				{#if !preview.canDeleteFiles && !hasVolumes}
					<p class="text-sm text-muted-foreground">
						{m.stacks_delete_nothing_managed()}
					</p>
				{/if}
			</div>

			<!-- What will happen — fixed set of lines; each flips red(delete)/green(keep). -->
			<div class="mt-2 rounded-md border bg-muted/30 p-3">
				<div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
					{m.stacks_delete_what_will_happen()}
				</div>
				<ul class="space-y-1 text-sm">
					{#each willHappen as w}
						<li class="flex items-start gap-1.5">
							{#if w.delete === true}
								<Trash2 class="w-3.5 h-3.5 shrink-0 translate-y-0.5 text-destructive" />
								<span>{w.text}</span>
							{:else if w.delete === false}
								<!-- kept: green folder/volume icon so "kept" reads as safe -->
								{#if w.kind === 'files'}
									<Folder class="w-3.5 h-3.5 shrink-0 translate-y-0.5 text-emerald-500" />
								{:else}
									<Database class="w-3.5 h-3.5 shrink-0 translate-y-0.5 text-emerald-500" />
								{/if}
								<span class="text-muted-foreground">{w.text}</span>
							{:else}
								<ArrowRight class="w-3.5 h-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
								<span>{w.text}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="mt-4 flex justify-end gap-1.5">
			<Button variant="outline" size="sm" onclick={() => (open = false)} disabled={busy}>
				{m.stacks_delete_cancel()}
			</Button>
			<Button variant="destructive" size="sm" onclick={run} disabled={busy || loading}>
				{#if busy}<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />{:else}<Trash2 class="w-3.5 h-3.5 mr-1" />{/if}
				{m.stacks_delete_remove()}
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>
