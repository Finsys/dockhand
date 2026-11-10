<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Box, Clock, ExternalLink, RefreshCw, BookOpen, Info, CircleArrowUp } from 'lucide-svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { formatDate } from '$lib/stores/settings';
	import { m } from '$lib/paraglide/messages.js';

	// Minimal shape shared by the containers list and inspect view.
	type ModalContainer = { id: string; name: string; image: string };

	interface ReleaseNote {
		version: string;
		name: string;
		githubTag: string;
		body: string;
		publishedAt: string | null;
		url: string;
	}

	interface Props {
		/** The cooling-down container this modal is about; null closes it. */
		container: ModalContainer | null;
		/** Hours left on the held update, for the header. */
		cooldownHours: number | null;
		envId: number | null;
		/** Force the held update now, if the viewer may. Hidden when undefined. */
		onUpdateNow?: (id: string, name: string) => void;
	}

	let { container = $bindable(), cooldownHours, envId, onUpdateNow }: Props = $props();

	const open = $derived(!!container);

	// The current tag = the part after the last ':' of the image reference.
	const currentTag = $derived.by(() => {
		const img = container?.image ?? '';
		const colon = img.lastIndexOf(':');
		return colon > img.lastIndexOf('/') ? img.slice(colon + 1) : 'latest';
	});

	let loading = $state(false);
	let notes = $state<ReleaseNote[]>([]);
	let changelogUrl = $state<string | null>(null);
	let source = $state<string | null>(null);
	let loadedFor = $state<string | null>(null);
	let rateLimited = $state(false);

	// A held update is the same tag with a newer image, so there is no version path -
	// ask the endpoint with the current tag and take whatever changelog/notes it finds.
	$effect(() => {
		if (!open || !container) return;
		if (loadedFor === container.id) return;
		loadedFor = container.id;
		void loadNotes(container.id, currentTag);
	});

	async function loadNotes(containerId: string, tag: string) {
		loading = true;
		notes = [];
		changelogUrl = null;
		source = null;
		rateLimited = false;
		try {
			const qs = `versions=${encodeURIComponent(tag)}`;
			const res = await fetch(
				appendEnvParam(`/api/containers/${containerId}/version-notes?${qs}`, envId)
			);
			if (res.ok) {
				const data = await res.json();
				notes = data.notes ?? [];
				changelogUrl = data.changelogUrl ?? null;
				source = data.source ?? null;
				rateLimited = data.rateLimited ?? false;
			}
		} catch {
			// leave notes empty -> the "no notes" fallback renders
		} finally {
			loading = false;
		}
	}

	function close() {
		container = null;
		// Clear so reopening the same container refetches - a first open that hit a
		// rate limit or a network error must not stay stuck on that stale state.
		loadedFor = null;
	}

	function updateNow() {
		if (container && onUpdateNow) {
			onUpdateNow(container.id, container.name);
			close();
		}
	}
</script>

<Dialog.Root {open} onOpenChange={(v) => { if (!v) close(); }}>
	<Dialog.Content class="max-w-3xl max-h-[90vh] flex flex-col !animate-none">
		{#if container}
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2.5 flex-wrap pr-8">
					<Box class="w-5 h-5 text-muted-foreground shrink-0" />
					<span class="font-semibold">{container.name}</span>
					<span class="font-mono text-sm text-muted-foreground font-normal">{currentTag}</span>
					{#if cooldownHours}
						<span class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
							<Clock class="w-3.5 h-3.5" />
							{m.containers_inspect_update_held_short({ hours: cooldownHours })}
						</span>
					{/if}
				</Dialog.Title>
			</Dialog.Header>

			<p class="text-sm text-muted-foreground px-1">{m.cooldown_notes_intro()}</p>

			<!-- Release notes / changelog for the held image -->
			<div class="flex-1 overflow-auto pr-1 space-y-2 min-h-[120px]">
				{#if loading}
					<div class="flex items-center justify-center py-10 text-muted-foreground">
						<RefreshCw class="w-5 h-5 animate-spin" />
						<span class="ml-2 text-sm">{m.updates_loading_notes()}</span>
					</div>
				{:else if notes.length > 0}
					{#each notes as note}
						<div class="rounded-md border border-border bg-muted/30">
							<div class="flex items-center gap-2 px-3 py-2 border-b border-border/60">
								<span class="font-mono text-sm font-semibold">{note.name || note.githubTag}</span>
								{#if note.publishedAt}
									<span class="text-xs text-muted-foreground">{formatDate(note.publishedAt)}</span>
								{/if}
								<a
									href={note.url}
									target="_blank"
									rel="noopener noreferrer"
									class="ml-auto text-muted-foreground hover:text-foreground shrink-0"
									title={m.updates_open_on_github()}
								>
									<ExternalLink class="w-3.5 h-3.5" />
								</a>
							</div>
							<div class="markdown-body px-3 py-3 text-sm">
								{@html renderMarkdown(note.body)}
							</div>
						</div>
					{/each}
				{:else if rateLimited}
					<div class="flex flex-col items-start gap-3 py-8">
						<div class="flex items-start gap-2.5">
							<Info class="w-5 h-5 shrink-0 text-amber-500 mt-0.5" />
							<p class="text-sm text-muted-foreground">
								{m.updates_rate_limit_before()}
								<code class="text-xs">DOCKHAND_GITHUB_TOKEN</code> {m.updates_rate_limit_after()}
							</p>
						</div>
						{#if changelogUrl}
							<Button variant="outline" size="sm" href={changelogUrl} target="_blank" rel="noopener noreferrer">
								<ExternalLink class="w-3.5 h-3.5 mr-1.5" /> {m.updates_view_changelog()}
							</Button>
						{/if}
					</div>
				{:else}
					<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
						<BookOpen class="w-8 h-8 text-muted-foreground/50" />
						<p class="text-sm text-muted-foreground max-w-sm">
							{#if changelogUrl}
								{m.updates_notes_not_inline()}
							{:else}
								{m.updates_no_source_before()}
								<code class="text-xs">org.opencontainers.image.source</code> {m.updates_no_source_after()}
							{/if}
						</p>
						{#if changelogUrl}
							<Button variant="outline" size="sm" href={changelogUrl} target="_blank" rel="noopener noreferrer">
								<ExternalLink class="w-3.5 h-3.5 mr-1.5" /> {m.updates_view_changelog()}
							</Button>
						{/if}
					</div>
				{/if}
			</div>

			<Dialog.Footer class="flex-row items-center gap-2 sm:justify-between">
				<div class="text-xs text-muted-foreground">
					{#if source}
						{m.updates_notes_from()} <code class="text-xs">{source}</code>
					{/if}
				</div>
				<div class="flex gap-2">
					<Button variant="outline" size="sm" onclick={close}>{m.ui_close()}</Button>
					{#if onUpdateNow}
						<Button size="sm" onclick={updateNow}>
							<CircleArrowUp class="w-3.5 h-3.5 mr-1.5" /> {m.cooldown_notes_update_now()}
						</Button>
					{/if}
				</div>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	/* Scoped typography for rendered release-note markdown, matching VersionUpdateModal. */
	.markdown-body :global(h1),
	.markdown-body :global(h2),
	.markdown-body :global(h3) {
		font-weight: 600;
		margin: 0.75rem 0 0.4rem;
		line-height: 1.3;
	}
	.markdown-body :global(h1) { font-size: 1.05rem; }
	.markdown-body :global(h2) { font-size: 1rem; }
	.markdown-body :global(h3) { font-size: 0.9rem; }
	.markdown-body :global(p) { margin: 0.4rem 0; }
	.markdown-body :global(ul),
	.markdown-body :global(ol) { margin: 0.4rem 0; padding-left: 1.4rem; }
	.markdown-body :global(li) { margin: 0.15rem 0; }
	.markdown-body :global(ul) { list-style: disc; }
	.markdown-body :global(ol) { list-style: decimal; }
	.markdown-body :global(a) { color: hsl(var(--primary)); text-decoration: underline; }
	.markdown-body :global(code) {
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 0.85em;
		background: hsl(var(--muted));
		border-radius: 4px;
		padding: 0.1em 0.35em;
	}
	.markdown-body :global(pre) {
		background: hsl(var(--muted));
		border-radius: 6px;
		padding: 0.75rem;
		overflow-x: auto;
	}
</style>
