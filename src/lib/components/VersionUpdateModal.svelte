<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Box, ArrowRight, ExternalLink, Copy, Check, RefreshCw, ChevronDown, BookOpen, ShieldCheck, Info } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { appendEnvParam } from '$lib/stores/environment';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import { renderMarkdown } from '$lib/utils/markdown';
	import { formatDate } from '$lib/stores/settings';
	import { repoBaseOf } from '$lib/utils/pinned-ref';
	import type { NewerVersion } from '$lib/types';

	// Minimal shape shared by ContainerInfo and StackContainer - all the modal needs.
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
		/** The container this modal is about; null closes the modal. */
		container: ModalContainer | null;
		/** The newer-version suggestion (target tag + skipped versions). */
		newerVersion: NewerVersion | null;
		envId: number | null;
	}

	let { container = $bindable(), newerVersion, envId }: Props = $props();

	const open = $derived(!!container && !!newerVersion);

	// The current tag = the part after the last ':' of the image reference.
	const currentTag = $derived.by(() => {
		const img = container?.image ?? '';
		const colon = img.lastIndexOf(':');
		return colon > img.lastIndexOf('/') ? img.slice(colon + 1) : 'latest';
	});

	const bumpColor = $derived(
		newerVersion?.bump === 'major'
			? 'text-red-400 border-red-400/40 bg-red-400/10'
			: newerVersion?.bump === 'minor'
				? 'text-amber-400 border-amber-400/40 bg-amber-400/10'
				: 'text-amber-400 border-amber-400/40 bg-amber-400/10'
	);

	// skipped is ordered current-exclusive .. target-inclusive.
	const versionPath = $derived(newerVersion?.skipped ?? []);

	let loading = $state(false);
	let notes = $state<ReleaseNote[]>([]);
	let changelogUrl = $state<string | null>(null);
	let source = $state<string | null>(null);
	let loadedFor = $state<string | null>(null);
	let copied = $state(false);
	let rateLimited = $state(false);

	// Fetch notes when the modal opens for a (container, target) pair we haven't loaded.
	$effect(() => {
		if (!open || !container || !newerVersion) return;
		const key = `${container.id}:${newerVersion.tag}`;
		if (loadedFor === key) return;
		loadedFor = key;
		void loadNotes(container.id, versionPath);
	});

	async function loadNotes(containerId: string, versions: string[]) {
		loading = true;
		notes = [];
		changelogUrl = null;
		source = null;
		rateLimited = false;
		try {
			const qs = `versions=${encodeURIComponent(versions.join(','))}`;
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

	// Repo without the tag OR digest, e.g. `ghcr.io/owner/app` from
	// `ghcr.io/owner/app:1.2@sha256:...` - a running image is often digest-pinned,
	// whose `@sha256:` colon must not be mistaken for the tag separator (#1437).
	const repoBase = $derived(repoBaseOf(container?.image ?? ''));

	async function copyTag() {
		if (!container || !newerVersion) return;
		const ok = await copyToClipboard(`${repoBase}:${newerVersion.tag}`);
		if (ok) {
			copied = true;
			toast.success('New image tag copied');
			setTimeout(() => (copied = false), 1500);
		}
	}

	// Digest-pinned form of the new tag (repo:tag@sha256).
	let copiedPinned = $state(false);
	async function copyPinnedTag() {
		if (!container || !newerVersion?.digest) return;
		const ok = await copyToClipboard(`${repoBase}:${newerVersion.tag}@${newerVersion.digest}`);
		if (ok) {
			copiedPinned = true;
			toast.success('New tag with digest copied');
			setTimeout(() => (copiedPinned = false), 1500);
		}
	}

	function close() {
		container = null;
	}

	// Note for a given version path entry, if GitHub had one.
	function noteFor(version: string): ReleaseNote | undefined {
		return notes.find((n) => n.version === version);
	}

	// A DOM-safe id for a version's release-note <details>, so the Path links can
	// open + scroll to it. Non-alphanumerics -> '-' (tags like `16.4-alpine` are fine).
	function noteId(version: string): string {
		return `note-${version.replace(/[^a-zA-Z0-9]+/g, '-')}`;
	}

	// Clicking a version in the Path opens its note and scrolls it into view.
	function jumpToNote(version: string) {
		const el = document.getElementById(noteId(version));
		if (!el) return;
		if (el instanceof HTMLDetailsElement) el.open = true;
		el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}
</script>

<Dialog.Root {open} onOpenChange={(v) => { if (!v) close(); }}>
	<Dialog.Content class="max-w-3xl max-h-[90vh] flex flex-col !animate-none">
		{#if container && newerVersion}
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2.5 flex-wrap pr-8">
					<Box class="w-5 h-5 text-muted-foreground shrink-0" />
					<span class="font-semibold">{container.name}</span>
					<span class="flex items-center gap-2 font-mono text-sm">
						<span class="text-muted-foreground font-normal">{currentTag}</span>
						<ArrowRight class="w-4 h-4 text-muted-foreground shrink-0" />
						<span class="font-semibold text-amber-400">{newerVersion.tag}</span>
						<button
							type="button"
							onclick={copyTag}
							title={copied ? 'Copied!' : 'Copy new tag'}
							class="inline-flex items-center p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							{#if copied}
								<Check class="w-3.5 h-3.5 text-green-500" />
							{:else}
								<Copy class="w-3.5 h-3.5" />
							{/if}
						</button>
					</span>
					<span class="ml-auto flex items-center gap-2">
						<span class="rounded-full border px-2 py-0.5 text-2xs font-semibold uppercase {bumpColor}">
							{newerVersion.bump}
						</span>
						{#if versionPath.length > 1}
							<span class="text-xs font-normal text-muted-foreground">{versionPath.length} versions ahead</span>
						{/if}
					</span>
				</Dialog.Title>
			</Dialog.Header>

			<!-- Digest-pinned reference for the new tag (repo:tag@sha256), inline copy. -->
			{#if newerVersion.digest}
				<button
					type="button"
					onclick={copyPinnedTag}
					title={copiedPinned ? 'Copied!' : 'Copy the new tag pinned to its digest (tag@sha256)'}
					class="group flex items-center gap-1.5 w-full text-left px-2 py-1.5 rounded-md border border-border bg-muted/30 hover:bg-muted/60 transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<ShieldCheck class="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
					<code class="text-xs text-muted-foreground truncate min-w-0 flex-1">{repoBase}:{newerVersion.tag}@{newerVersion.digest}</code>
					{#if copiedPinned}
						<Check class="w-3.5 h-3.5 text-green-500 shrink-0" />
					{:else}
						<Copy class="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground shrink-0" />
					{/if}
				</button>
			{/if}

			<!-- Version path. A version with release notes is a link that opens + scrolls to them. -->
			{#if versionPath.length > 1}
				<div class="flex items-center gap-1.5 flex-wrap text-xs px-1">
					<span class="text-muted-foreground">Path:</span>
					<span class="font-mono text-muted-foreground">{currentTag}</span>
					{#each versionPath as v, i}
						{@const isTarget = i === versionPath.length - 1}
						<ArrowRight class="w-3 h-3 text-muted-foreground/60 shrink-0" />
						{#if noteFor(v)}
							<button
								type="button"
								onclick={() => jumpToNote(v)}
								title="Jump to release notes for {v}"
								class="font-mono cursor-pointer transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded {isTarget ? 'text-amber-400 font-semibold' : 'text-foreground hover:text-amber-400'}"
							>{v}</button>
						{:else}
							<span class="font-mono {isTarget ? 'text-amber-400 font-semibold' : 'text-foreground'}">{v}</span>
						{/if}
					{/each}
				</div>
			{/if}

			<!-- Release notes -->
			<div class="flex-1 overflow-auto pr-1 space-y-2 min-h-[120px]">
				{#if loading}
					<div class="flex items-center justify-center py-10 text-muted-foreground">
						<RefreshCw class="w-5 h-5 animate-spin" />
						<span class="ml-2 text-sm">Loading release notes...</span>
					</div>
				{:else if notes.length > 0}
					{#each versionPath.slice().reverse() as version}
						{@const note = noteFor(version)}
						{#if note}
							<details id={noteId(version)} class="group rounded-md border border-border bg-muted/30 [&_summary::-webkit-details-marker]:hidden" open={version === newerVersion.tag || versionPath.length <= 3}>
								<summary class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-md list-none">
									<ChevronDown class="w-4 h-4 text-muted-foreground shrink-0 transition-transform group-open:rotate-0 -rotate-90" />
									<span class="font-mono text-sm font-semibold">{note.name || note.githubTag}</span>
									{#if note.publishedAt}
										<span class="ml-auto text-xs text-muted-foreground">{formatDate(note.publishedAt)}</span>
									{/if}
									<a
										href={note.url}
										target="_blank"
										rel="noopener noreferrer"
										onclick={(e) => e.stopPropagation()}
										class="text-muted-foreground hover:text-foreground shrink-0 {note.publishedAt ? '' : 'ml-auto'}"
										title="Open on GitHub"
									>
										<ExternalLink class="w-3.5 h-3.5" />
									</a>
								</summary>
								<div class="markdown-body border-t border-border/60 px-3 py-3 text-sm">
									{@html renderMarkdown(note.body)}
								</div>
							</details>
						{/if}
					{/each}
				{:else}
					<!-- Fallback: no per-version notes found -->
					{#if rateLimited}
						<div class="flex flex-col items-start gap-3 py-8">
							<div class="flex items-start gap-2.5">
								<Info class="w-5 h-5 shrink-0 text-amber-500 mt-0.5" />
								<p class="text-sm text-muted-foreground">
									GitHub's rate limit was hit while fetching release notes. Set a
									<code class="text-xs">DOCKHAND_GITHUB_TOKEN</code> (a personal access token, no scopes needed)
									to raise the limit from 60 to 5000 requests/hour.
								</p>
							</div>
							{#if changelogUrl}
								<Button variant="outline" size="sm" href={changelogUrl} target="_blank" rel="noopener noreferrer">
									<ExternalLink class="w-3.5 h-3.5 mr-1.5" /> View changelog
								</Button>
							{/if}
						</div>
					{:else}
						<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
							<BookOpen class="w-8 h-8 text-muted-foreground/50" />
							<p class="text-sm text-muted-foreground max-w-sm">
								{#if changelogUrl}
									Release notes for these versions aren't available inline.
								{:else}
									This image doesn't publish release notes Dockhand can read
									(no <code class="text-xs">org.opencontainers.image.source</code> label pointing at a GitHub or Gitea/Forgejo repo).
								{/if}
							</p>
							{#if changelogUrl}
								<Button variant="outline" size="sm" href={changelogUrl} target="_blank" rel="noopener noreferrer">
									<ExternalLink class="w-3.5 h-3.5 mr-1.5" /> View changelog
								</Button>
							{/if}
						</div>
					{/if}
				{/if}
			</div>

			<Dialog.Footer class="flex-row items-center gap-2 sm:justify-between">
				<div class="text-xs text-muted-foreground">
					{#if source}
						Notes from <code class="text-xs">{source}</code>
					{/if}
				</div>
				<div class="flex gap-2">
					<Button variant="outline" size="sm" onclick={close}>Close</Button>
				</div>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	/* Scoped typography for rendered release-note markdown. */
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
		margin: 0.5rem 0;
	}
	.markdown-body :global(pre code) { background: none; padding: 0; }
	.markdown-body :global(blockquote) {
		border-left: 3px solid hsl(var(--border));
		padding-left: 0.75rem;
		color: hsl(var(--muted-foreground));
		margin: 0.5rem 0;
	}
	.markdown-body :global(hr) { border: none; border-top: 1px solid hsl(var(--border)); margin: 0.75rem 0; }
	.markdown-body :global(img) { max-width: 100%; }
</style>
