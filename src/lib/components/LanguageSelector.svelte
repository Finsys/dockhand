<script lang="ts">
	/**
	 * Pick the interface language.
	 *
	 * Without this the language comes only from the browser's Accept-Language, so
	 * somebody running a Polish browser who wants the interface in German has no way
	 * to say so.
	 *
	 * The choice is kept in localStorage, read synchronously at startup, and on the server
	 * (per user with auth, for the install without), which the client init hook copies
	 * back before the first render and the root layout after sign-in. "Follow the browser" is the ABSENCE of a choice
	 * rather than a value, which is what keeps Accept-Language working for everyone who
	 * never opens this.
	 *
	 * Changing it reloads the page. Messages are plain function calls, so Svelte has
	 * nothing to re-run and the text already on screen would otherwise stay put.
	 */
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { locales, baseLocale } from '$lib/paraglide/runtime';
	import {
		LOCALE_STORAGE_KEY,
		FOLLOW_BROWSER,
		asLocale,
		fromNavigator,
		chooseLanguage
	} from '$lib/i18n/locale-preference';
	import { m } from '$lib/paraglide/messages.js';
	import { toast } from 'svelte-sonner';

	/** Endonyms: each language is listed the way its own speakers write it. */
	const NAMES: Record<string, string> = {
		en: 'English',
		de: 'Deutsch',
		'es-ES': 'Español',
		'fr-FR': 'Français',
		'fr-CA': 'Français (Canada)',
		pl: 'Polski',
		'zh-CN': '简体中文',
		ru: 'Русский'
	};

	/** What is stored, which is not what is rendered: absent means follow the browser. */
	let chosen = $state(readChoice());

	function readChoice(): string {
		try {
			return asLocale(localStorage.getItem(LOCALE_STORAGE_KEY)) ?? FOLLOW_BROWSER;
		} catch {
			return FOLLOW_BROWSER;
		}
	}

	/** The browser's own answer, so the "follow" option names the language it would
	    give - not the stored one, which is what the option exists to discard. */
	const browserLocale = $derived(fromNavigator(navigator.languages ?? [navigator.language]) ?? baseLocale);
	const browserLabel = $derived(NAMES[browserLocale] ?? browserLocale);
	const label = $derived(
		chosen === FOLLOW_BROWSER
			? m.language_follow_browser({ language: browserLabel })
			: (NAMES[chosen] ?? chosen)
	);

	/** Bumped after a refused choice so the menu drops the selection it kept locally. */
	let resetKey = $state(0);

	async function choose(value: string | undefined) {
		if (!value || value === chosen) return;
		let store: Storage;
		try {
			store = localStorage;
		} catch {
			toast.error(m.language_storage_blocked());
			resetKey++;
			return;
		}
		const result = await chooseLanguage(value, fetch, store, () => location.reload());
		if (result === 'saved' || result === 'ignored') return;
		toast.error(result === 'blocked' ? m.language_storage_blocked() : m.language_save_failed());
		resetKey++;
	}
</script>

<div class="space-y-1">
	<Label for="language-select">{m.language_label()}</Label>
	{#key resetKey}
	<Select.Root type="single" value={chosen} onValueChange={choose}>
		<Select.Trigger id="language-select" class="w-full">{label}</Select.Trigger>
		<Select.Content>
			<Select.Item value={FOLLOW_BROWSER}>
				{m.language_follow_browser({ language: browserLabel })}
			</Select.Item>
			{#each locales as locale (locale)}
				<Select.Item value={locale}>{NAMES[locale] ?? locale}</Select.Item>
			{/each}
		</Select.Content>
	</Select.Root>
	{/key}
	<p class="text-xs text-muted-foreground">{m.language_hint()}</p>
</div>
