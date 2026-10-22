<script lang="ts">
	/**
	 * Pick the interface language.
	 *
	 * Without this the language comes only from the browser's Accept-Language, so
	 * somebody running a Polish browser who wants the interface in German has no way
	 * to say so.
	 *
	 * The choice belongs to the browser, not the account: paraglide decides the
	 * locale before the first message renders, which is earlier than any answer from
	 * the server could arrive, so it has to be readable synchronously at startup.
	 * "Follow the browser" is the ABSENCE of a choice rather than a value, which is
	 * what keeps Accept-Language working for everyone who never opens this.
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
		fromNavigator
	} from '$lib/i18n/locale-preference';
	import { m } from '$lib/paraglide/messages.js';

	/** Endonyms: each language is listed the way its own speakers write it. */
	const NAMES: Record<string, string> = {
		en: 'English',
		de: 'Deutsch',
		'fr-FR': 'Français',
		'fr-CA': 'Français (Canada)',
		pl: 'Polski',
		'zh-CN': '简体中文'
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

	function choose(value: string | undefined) {
		if (!value || value === chosen) return;
		try {
			if (value === FOLLOW_BROWSER) {
				// Removing it, not storing a marker: an absent key is what hands the
				// decision back to Accept-Language.
				localStorage.removeItem(LOCALE_STORAGE_KEY);
			} else if (asLocale(value)) {
				localStorage.setItem(LOCALE_STORAGE_KEY, value);
			} else {
				return;
			}
		} catch {
			// A blocked store cannot remember the choice, so do not reload and pretend.
			return;
		}
		location.reload();
	}
</script>

<div class="space-y-1">
	<Label for="language-select">{m.language_label()}</Label>
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
	<p class="text-xs text-muted-foreground">{m.language_hint()}</p>
</div>
