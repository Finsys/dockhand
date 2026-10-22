<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { themeStore } from '$lib/stores/theme';
	import { authStore } from '$lib/stores/auth';
	import { resolveToggleValue, shouldSkipApply } from '$lib/utils/theme-preference';
	import { toast } from 'svelte-sonner';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		userId?: number; // omit for global default (login page / auth-disabled)
		// When set, the toggle reflects and saves this global default (the General settings
		// editor) instead of the current user's profile preference. Omit elsewhere.
		globalValue?: boolean;
	}

	let { userId, globalValue }: Props = $props();

	const skipApply = $derived(shouldSkipApply($authStore.loading, $authStore.authEnabled, userId));

	let checked = $state(false);
	$effect(() => {
		checked = resolveToggleValue(globalValue, $themeStore.coloredActionButtons);
	});

	function onToggle(value: boolean) {
		checked = value;
		themeStore.setPreference('coloredActionButtons', value, userId, skipApply);
		toast.success(value ? m.toggles_colored_actions_enabled() : m.toggles_colored_actions_disabled());
	}
</script>

<div class="space-y-1">
	<div class="flex items-center gap-3">
		<Label>{m.toggles_colored_actions()}</Label>
		<TogglePill {checked} onchange={onToggle} />
	</div>
	<p class="text-xs text-muted-foreground">{m.toggles_colored_actions_description()}</p>
</div>
