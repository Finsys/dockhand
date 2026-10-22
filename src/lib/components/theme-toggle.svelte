<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Sun, Moon, Monitor } from 'lucide-svelte';
	import { onMount, onDestroy } from 'svelte';
	import { onDarkModeChange } from '$lib/stores/theme';
	import { m } from '$lib/paraglide/messages.js';

	type ThemeMode = 'light' | 'dark' | 'system';

	let mode = $state<ThemeMode>('system');
	let mediaQuery: MediaQueryList | null = null;

	onMount(() => {
		const saved = localStorage.getItem('theme') as ThemeMode | null;
		mode = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';

		mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
		mediaQuery.addEventListener('change', onSystemChange);

		applyMode();
	});

	onDestroy(() => {
		mediaQuery?.removeEventListener('change', onSystemChange);
	});

	function onSystemChange() {
		if (mode === 'system') {
			applyMode();
		}
	}

	function applyMode() {
		const isDark = mode === 'dark' || (mode === 'system' && !!mediaQuery?.matches);

		if (isDark) {
			document.documentElement.classList.add('dark');
		} else {
			document.documentElement.classList.remove('dark');
		}
		onDarkModeChange();
	}

	function cycleTheme() {
		const order: ThemeMode[] = ['light', 'dark', 'system'];
		mode = order[(order.indexOf(mode) + 1) % order.length];
		localStorage.setItem('theme', mode);
		applyMode();
	}
</script>

<Button variant="ghost" size="icon" onclick={cycleTheme} class="h-9 w-9" title={mode === 'system' ? m.theme_title_system() : mode === 'dark' ? m.theme_title_dark() : m.theme_title_light()}>
	{#if mode === 'dark'}
		<Moon class="h-4 w-4" />
	{:else if mode === 'light'}
		<Sun class="h-4 w-4" />
	{:else}
		<Monitor class="h-4 w-4" />
	{/if}
	<span class="sr-only">{m.theme_toggle()}</span>
</Button>
