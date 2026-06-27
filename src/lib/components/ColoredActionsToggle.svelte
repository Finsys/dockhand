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

	const skipApply = $derived($authStore.loading ? true : ($authStore.authEnabled && !userId));

	let checked = $state(false);
	$effect(() => {
		checked = $themeStore.coloredActionButtons;
	});

	function onToggle(value: boolean) {
		checked = value;
		themeStore.setPreference('coloredActionButtons', value, userId, skipApply);
		toast.success(value ? 'Action buttons colored' : 'Action buttons reset to default');
	}
</script>

<div class="space-y-1">
	<div class="flex items-center gap-3">
		<Label>Colored grid buttons</Label>
		<TogglePill {checked} onchange={onToggle} />
	</div>
	<p class="text-xs text-muted-foreground">Use semantic colors instead of muted gray</p>
</div>
