<script lang="ts">
	import { onMount } from 'svelte';
	import { Palette, CodeXml } from 'lucide-svelte';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { themeStore } from '$lib/stores/theme';
	import { authStore } from '$lib/stores/auth';
	import { monospaceFonts } from '$lib/themes';
	import { EDITOR_THEMES, getEditorThemeMeta } from '$lib/utils/editor-themes';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		userId?: number; // per-user (profile) when set; global default otherwise
	}

	let { userId }: Props = $props();

	// Same skip-apply rule as ThemeSelector: editing the global default while logged in
	// must not change the admin's own live editors (their per-user pref drives their view).
	const skipApply = $derived($authStore.loading ? true : ($authStore.authEnabled && !userId));

	let selected = $state('default');
	let selectedFont = $state('system-mono');
	let valuesLoaded = $state(false);
	const awaitingGlobal = $derived(!userId && !valuesLoaded);
	const currentFontMeta = $derived(monospaceFonts.find((f) => f.id === selectedFont));
	const currentFontName = $derived(currentFontMeta?.name ?? 'System Monospace');

	const darkThemes = EDITOR_THEMES.filter((t) => t.dark && t.id !== 'default');
	const lightThemes = EDITOR_THEMES.filter((t) => !t.dark);
	const currentMeta = $derived(getEditorThemeMeta(selected));
	const currentLabel = $derived(currentMeta.id === 'default' ? m.themes_editor_default() : currentMeta.label);

	// A compact but representative compose so every theme's syntax colors and the gutter
	// are visible in the preview (keys, strings, numbers, comments, lists, nesting).
	const PREVIEW_COMPOSE = `# ${m.themes_editor_preview_comment()}
services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"
    environment:
      - NODE_ENV=production
      - TZ=Europe/Warsaw
    depends_on:
      - db
    restart: unless-stopped
  db:
    image: postgres:16
    volumes:
      - dbdata:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD:?required}
volumes:
  dbdata:
`;

	onMount(async () => {
		// Load bundled monospace fonts so the font-dropdown previews render.
		for (const font of monospaceFonts.filter((f) => f.googleFont)) {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = `/fonts/${font.id}/font.css`;
			document.head.appendChild(link);
		}

		if (userId) {
			selected = $themeStore.editorTheme;
			selectedFont = $themeStore.editorFont;
		} else {
			try {
				const res = await fetch('/api/settings/theme');
				if (res.ok) {
					const data = await res.json();
					selected = data.editorTheme || 'default';
					selectedFont = data.editorFont || 'system-mono';
				}
			} catch {
				// keep defaults
			}
		}
		valuesLoaded = true;
	});

	// Keep in sync with the store when editing the user profile.
	$effect(() => {
		if (userId) {
			selected = $themeStore.editorTheme;
			selectedFont = $themeStore.editorFont;
		}
	});

	async function handleChange(value: string | undefined) {
		if (!value) return;
		selected = value;
		await themeStore.setPreference('editorTheme', value, userId, skipApply);
	}

	async function handleFontChange(value: string | undefined) {
		if (!value) return;
		selectedFont = value;
		await themeStore.setPreference('editorFont', value, userId, skipApply);
	}
</script>

<div class="space-y-3">
	<div class="flex items-center gap-2">
		<Palette class="w-4 h-4 text-muted-foreground" />
		<Label class="text-sm font-medium">{m.cmdpalette_group_editor_theme()}</Label>
	</div>

	<!-- Font + theme on one row; editor font moved here from Appearance. -->
	<div class="flex flex-wrap items-center gap-x-6 gap-y-3">
		<div class="flex items-center gap-2">
			<CodeXml class="w-4 h-4 text-muted-foreground" />
			<Label>{m.cmdpalette_group_font()}</Label>
			{#if awaitingGlobal}
				<div class="h-10 w-52 animate-pulse rounded-md bg-muted/50"></div>
			{:else}
				<Select.Root type="single" value={selectedFont} onValueChange={handleFontChange}>
					<Select.Trigger class="w-52">
						<span style="font-family: {monospaceFonts.find((f) => f.id === selectedFont)?.family}">{currentFontName}</span>
					</Select.Trigger>
					<Select.Content class="max-h-72">
						{#each monospaceFonts as font}
							<Select.Item value={font.id}>
								<span style="font-family: {font.family}">{font.name}</span>
							</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			{/if}
		</div>

		<div class="flex items-center gap-2">
			<Label>{m.themes_theme()}</Label>
			{#if awaitingGlobal}
				<div class="h-10 w-64 animate-pulse rounded-md bg-muted/50"></div>
			{:else}
				<Select.Root type="single" value={selected} onValueChange={handleChange}>
					<Select.Trigger class="w-64">
						<span>{currentLabel}</span>
					</Select.Trigger>
					<Select.Content class="max-h-72">
						<Select.Item value="default">{m.themes_editor_default()}</Select.Item>
						<Select.Group>
							<Select.GroupHeading>{m.themes_group_dark()}</Select.GroupHeading>
							{#each darkThemes as t}
								<Select.Item value={t.id}>{t.label}</Select.Item>
							{/each}
						</Select.Group>
						<Select.Group>
							<Select.GroupHeading>{m.themes_group_light()}</Select.GroupHeading>
							{#each lightThemes as t}
								<Select.Item value={t.id}>{t.label}</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
			{/if}
		</div>
	</div>

	<!-- Live preview: overrides the editor theme AND font locally so the choice shows
	     immediately, even when editing the global default (skipApply) where the live
	     editors don't change. -->
	<div
		class="rounded-md border overflow-hidden"
		style="height: 320px;{currentFontMeta?.family ? ` --font-editor: ${currentFontMeta.family};` : ''}"
	>
		<CodeEditor value={PREVIEW_COMPOSE} language="yaml" readonly editorThemeOverride={selected} />
	</div>
	<p class="text-xs text-muted-foreground">{m.themes_editor_hint()}</p>
</div>
