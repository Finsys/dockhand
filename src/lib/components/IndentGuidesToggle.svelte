<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { themeStore } from '$lib/stores/theme';
	import { authStore } from '$lib/stores/auth';
	import { toast } from 'svelte-sonner';

	interface Props {
		userId?: number; // omit for global default (login page / auth-disabled)
	}

	let { userId }: Props = $props();

	// Same "skip applying" rule as ThemeSelector: don't touch the live editor when the
	// admin is editing the global default while logged in (their own per-user preference
	// still drives their session).
	const skipApply = $derived($authStore.loading ? true : ($authStore.authEnabled && !userId));

	let checked = $state(false);
	$effect(() => {
		checked = $themeStore.editorIndentGuides;
	});

	function onToggle(value: boolean) {
		checked = value;
		themeStore.setPreference('editorIndentGuides', value, userId, skipApply);
		toast.success(value ? 'Indentation guides enabled' : 'Indentation guides disabled');
	}
</script>

<div class="space-y-1">
	<div class="flex items-center gap-3">
		<Label>Indentation guides</Label>
		<TogglePill {checked} onchange={onToggle} />
	</div>
	<p class="text-xs text-muted-foreground">Vertical guides showing nesting depth in the code editor.</p>
</div>
