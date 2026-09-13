<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { stackIconMap, getStackIconComponent } from '$lib/utils/icons';
	import { Upload, Search, Loader2, ExternalLink, ImageOff } from 'lucide-svelte';
	import AvatarCropper from '$lib/components/AvatarCropper.svelte';

	interface Props {
		open: boolean;
		/** Current icon value (lucide name / selfhst:<ref> / custom:...). */
		value?: string | null;
		/** Called with the chosen value string, or '' to clear. */
		onselect: (icon: string) => void;
		/** Dialog heading - defaults to a generic label; callers can scope it. */
		title?: string;
	}

	let { open = $bindable(false), value = null, onselect, title = 'Choose an icon' }: Props = $props();

	// --- Lucide tab ---
	const lucideNames = Object.keys(stackIconMap);
	let lucideQuery = $state('');
	const filteredLucide = $derived(
		lucideQuery.trim()
			? lucideNames.filter((n) => n.includes(lucideQuery.trim().toLowerCase()))
			: lucideNames
	);

	function pickLucide(name: string) {
		onselect(name);
		open = false;
	}

	// --- selfh.st tab (lazy) ---
	interface SelfhstEntry { Name: string; Reference: string; SVG: string }
	let manifest = $state<SelfhstEntry[]>([]);
	let manifestLoading = $state(false);
	let manifestError = $state('');
	let selfhstQuery = $state('');

	async function loadManifest() {
		if (manifest.length || manifestLoading) return;
		manifestLoading = true;
		manifestError = '';
		try {
			const res = await fetch('/api/icons/selfhst-manifest');
			if (!res.ok) throw new Error(`manifest ${res.status}`);
			const all = (await res.json()) as SelfhstEntry[];
			// Only SVG-capable entries (that's what our proxy serves).
			manifest = all.filter((e) => e.SVG === 'Yes' && e.Reference);
		} catch (e) {
			manifestError = 'Could not load the selfh.st icon list. Check the server has internet access.';
		} finally {
			manifestLoading = false;
		}
	}

	// Cap the rendered result count so a blank query doesn't try to lazy-load 2800 icons.
	const selfhstResults = $derived(
		(selfhstQuery.trim()
			? manifest.filter(
					(e) =>
						e.Name.toLowerCase().includes(selfhstQuery.trim().toLowerCase()) ||
						e.Reference.includes(selfhstQuery.trim().toLowerCase())
				)
			: manifest
		).slice(0, 120)
	);

	// ref -> data: URI for the currently-shown grid. The icons are fetched in ONE
	// batch request instead of one <img> request per ref, so a WAF (CrowdSec) doesn't
	// see the grid as crawling and block the client (#1467).
	let iconData = $state<Record<string, string>>({});
	let iconsLoading = $state(false);
	let batchSeq = 0;
	// Refs already asked for (resolved OR omitted-as-unresolvable). We key `missing`
	// off THIS, not off iconData, so a ref the batch omits still counts as attempted
	// and never gets requested again - otherwise the effect (which reads+writes
	// iconData) would re-fire forever, POSTing the same unresolvable refs in a loop.
	// It is intentionally a plain Set (non-reactive), so mutating it doesn't retrigger.
	const attempted = new Set<string>();
	$effect(() => {
		const refs = selfhstResults.map((e) => e.Reference);
		if (refs.length === 0) return;
		const missing = refs.filter((r) => !attempted.has(r));
		if (missing.length === 0) return;
		for (const r of missing) attempted.add(r);
		const seq = ++batchSeq;
		iconsLoading = true;
		fetch('/api/icons/selfhst/batch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ refs: missing })
		})
			.then((r) => (r.ok ? r.json() : { icons: {} }))
			.then((data: { icons?: Record<string, string> }) => {
				const icons = data.icons ?? {};
				if (Object.keys(icons).length > 0) iconData = { ...iconData, ...icons };
			})
			.catch(() => {
				/* leave unresolved refs as placeholder tiles */
			})
			.finally(() => {
				if (seq === batchSeq) iconsLoading = false;
			});
	});

	// The first batch is still in flight and no icon has resolved yet -> show a spinner
	// instead of a grid of empty pulse tiles.
	const showIconSpinner = $derived(iconsLoading && Object.keys(iconData).length === 0);

	function pickSelfhst(ref: string) {
		onselect(`selfhst:${ref}`);
		open = false;
	}

	function onTabChange(v: string) {
		if (v === 'selfhst') loadManifest();
	}

	// --- Upload tab (crop like env icons) ---
	let iconCropperImageUrl = $state('');
	let showIconCropper = $state(false);

	function onFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			iconCropperImageUrl = reader.result as string;
			input.value = '';
			showIconCropper = true;
		};
		reader.readAsDataURL(file);
	}

	// The cropped 128px webp data URL goes to the parent, which owns the stack name
	// and POSTs it (same flow env icons use).
	function handleIconCropSave(dataUrl: string) {
		showIconCropper = false;
		onselect(`upload:${dataUrl}`);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-2xl h-[640px] flex flex-col">
		<Dialog.Header class="shrink-0">
			<Dialog.Title>{title}</Dialog.Title>
		</Dialog.Header>

		<Tabs.Root value="icons" onValueChange={onTabChange} class="flex-1 flex flex-col min-h-0">
			<Tabs.List class="grid grid-cols-3 shrink-0">
				<Tabs.Trigger value="icons">Icons</Tabs.Trigger>
				<Tabs.Trigger value="selfhst">App logos</Tabs.Trigger>
				<Tabs.Trigger value="upload">Upload</Tabs.Trigger>
			</Tabs.List>

			<!-- Lucide icons -->
			<Tabs.Content value="icons" class="mt-3 flex-1 min-h-0 data-[state=active]:flex flex-col">
				<div class="relative mb-3 shrink-0">
					<Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
					<Input bind:value={lucideQuery} placeholder="Search icons..." class="pl-8" />
				</div>
				<div class="grid grid-cols-12 gap-1 flex-1 overflow-y-auto pr-1 content-start">
					{#each filteredLucide as name (name)}
						{@const Icon = getStackIconComponent(name)}
						<button
							type="button"
							title={name}
							onclick={() => pickLucide(name)}
							class="flex items-center justify-center aspect-square rounded-md border hover:bg-accent hover:border-primary transition-colors {value === name ? 'border-primary bg-accent' : 'border-transparent'}"
						>
							<Icon class="w-4 h-4" />
						</button>
					{/each}
				</div>
			</Tabs.Content>

			<!-- selfh.st app logos -->
			<Tabs.Content value="selfhst" class="mt-3 flex-1 min-h-0 data-[state=active]:flex flex-col">
				<div class="relative mb-3 shrink-0">
					<Search class="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
					<Input bind:value={selfhstQuery} placeholder="Search app logos (plex, jellyfin, grafana...)" class="pl-8" />
				</div>
				<div class="flex-1 min-h-0 overflow-y-auto pr-1">
					{#if manifestLoading}
						<div class="flex items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
							<Loader2 class="w-4 h-4 animate-spin" /> Loading icon list...
						</div>
					{:else if manifestError}
						<div class="flex flex-col items-center gap-2 py-10 text-muted-foreground text-sm">
							<ImageOff class="w-6 h-6" />
							<span class="text-center max-w-sm">{manifestError}</span>
						</div>
					{:else}
						{#if showIconSpinner}
							<div class="flex items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
								<Loader2 class="w-4 h-4 animate-spin" /> Loading icons...
							</div>
						{/if}
						<div class="grid grid-cols-12 gap-1 content-start" class:hidden={showIconSpinner}>
							{#each selfhstResults as entry (entry.Reference)}
								<button
									type="button"
									title={entry.Name}
									onclick={() => pickSelfhst(entry.Reference)}
									class="flex items-center justify-center aspect-square rounded-md border p-1 hover:bg-accent hover:border-primary transition-colors {value === `selfhst:${entry.Reference}` ? 'border-primary bg-accent' : 'border-transparent'}"
								>
									{#if iconData[entry.Reference]}
										<img src={iconData[entry.Reference]} alt={entry.Name} class="w-full h-full object-contain" />
									{:else}
										<div class="w-full h-full rounded bg-muted animate-pulse" aria-label={entry.Name}></div>
									{/if}
								</button>
							{/each}
						</div>
						{#if selfhstResults.length === 0 && selfhstQuery.trim()}
							<p class="py-8 text-center text-sm text-muted-foreground">No app logos match "{selfhstQuery}".</p>
						{/if}
					{/if}
				</div>
				<p class="mt-3 shrink-0 text-[11px] text-muted-foreground leading-relaxed">
					<svg viewBox="0 0 64 64" class="inline-block w-3.5 h-3.5 align-text-bottom mr-1 fill-current" aria-hidden="true"><path d="M31.957,0.311c-8.682,0-16.322,3.213-22.226,9.203C3.653,15.678,0.354,23.666,0.354,32c0,8.422,3.212,16.236,9.29,22.313c6.078,6.078,13.978,9.377,22.313,9.377c8.334,0,16.409-3.299,22.66-9.463c5.904-5.817,9.029-13.544,9.029-22.227c0-8.595-3.125-16.408-9.116-22.399C48.453,3.523,40.639,0.311,31.957,0.311z M32.043,6.041c7.12,0,13.458,2.691,18.406,7.641c4.862,4.861,7.466,11.286,7.466,18.318c0,7.119-2.518,13.371-7.379,18.146c-5.123,5.035-11.721,7.727-18.493,7.727c-6.858,0-13.283-2.691-18.232-7.641C8.862,45.283,6.084,38.772,6.084,32c0-6.858,2.778-13.369,7.727-18.406C18.673,8.646,24.924,6.041,32.043,6.041z"/><path id="cc-c" d="M31.635,26.734c-1.79-3.264-4.844-4.563-8.389-4.563c-5.16,0-9.267,3.65-9.267,9.828c0,6.283,3.861,9.829,9.442,9.829c3.581,0,6.635-1.966,8.319-4.949l-3.931-2.001c-0.878,2.105-2.212,2.738-3.896,2.738c-2.914,0-4.248-2.422-4.248-5.617c0-3.193,1.124-5.616,4.248-5.616c0.842,0,2.527,0.456,3.51,2.563L31.635,26.734z"/><use href="#cc-c" transform="translate(18.281)"/></svg>App logos by
					<a href="https://selfh.st" target="_blank" rel="noopener" class="inline-flex items-center gap-0.5 underline hover:text-foreground">selfh.st<ExternalLink class="w-3 h-3" /></a>,
					licensed CC BY 4.0. Fetched once and cached locally.
				</p>
				<p class="mt-1 text-[11px] text-muted-foreground leading-relaxed">
					Product names, logos and trademarks are the property of their respective owners and are shown for identification only; their use does not imply endorsement.
				</p>
			</Tabs.Content>

			<!-- Upload -->
			<Tabs.Content value="upload" class="mt-3 flex-1 min-h-0 data-[state=active]:flex flex-col justify-center gap-3">
				<label class="flex flex-col items-center justify-center gap-2 py-12 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary transition-colors">
					<Upload class="w-6 h-6 text-muted-foreground" />
					<span class="text-sm text-muted-foreground">Click to upload an image, then crop it</span>
					<span class="text-xs text-muted-foreground">PNG, SVG or WebP</span>
					<input type="file" accept="image/*" class="hidden" onchange={onFileSelect} />
				</label>
			</Tabs.Content>
		</Tabs.Root>

		<Dialog.Footer>
			{#if value}
				<Button variant="ghost" onclick={() => { onselect(''); open = false; }}>Clear icon</Button>
			{/if}
		</Dialog.Footer>

		<AvatarCropper
			show={showIconCropper}
			imageUrl={iconCropperImageUrl}
			cropShape="round"
			outputSize={128}
			outputFormat="image/webp"
			outputQuality={0.85}
			title="Crop icon"
			saveLabel="Save icon"
			onCancel={() => (showIconCropper = false)}
			onSave={handleIconCropSave}
		/>
	</Dialog.Content>
</Dialog.Root>
