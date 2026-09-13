<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { themeStore } from '$lib/stores/theme';
	import { authStore } from '$lib/stores/auth';
	import { resolveToggleValue, shouldSkipApply } from '$lib/utils/theme-preference';
	import { toast } from 'svelte-sonner';

	interface Props {
		userId?: number; // omit for global default (login page / auth-disabled)
		// When set, the toggle reflects and saves this global default instead of the profile.
		globalValue?: boolean;
	}

	let { userId, globalValue }: Props = $props();

	// Same "skip applying" rule as ThemeSelector: don't toggle the live document
	// when the admin is editing the global default while logged in (their own
	// per-user preference still drives their session).
	const skipApply = $derived(shouldSkipApply($authStore.loading, $authStore.authEnabled, userId));

	let checked = $state(true);
	$effect(() => {
		checked = resolveToggleValue(globalValue, $themeStore.animateIcons);
	});

	function onToggle(value: boolean) {
		checked = value;
		themeStore.setPreference('animateIcons', value, userId, skipApply);
		toast.success(value ? 'Icon animation enabled' : 'Icon animation disabled');
	}
</script>

<div class="space-y-1">
	<div class="flex items-center gap-3">
		<Label>Animate icons</Label>
		<TogglePill {checked} onchange={onToggle} />
	</div>
	<p class="text-xs text-muted-foreground">Spinners during pulls, scans and updates.</p>
</div>
