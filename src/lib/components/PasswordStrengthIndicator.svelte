<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		password: string;
	}

	let { password }: Props = $props();

	// Calculate password strength (0-4)
	const strength = $derived.by(() => {
		if (!password) return 0;

		let score = 0;

		// Length checks
		if (password.length >= 8) score++;
		if (password.length >= 12) score++;

		// Character variety checks
		if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
		if (/\d/.test(password)) score++;
		if (/[^a-zA-Z0-9]/.test(password)) score++;

		return Math.min(score, 4);
	});

	const strengthLabel = $derived(
		strength === 0 ? m.password_strength_too_short() :
		strength === 1 ? m.password_strength_weak() :
		strength === 2 ? m.password_strength_fair() :
		strength === 3 ? m.password_strength_good() :
		m.password_strength_strong()
	);

	const strengthColor = $derived(
		strength === 0 ? 'bg-muted' :
		strength === 1 ? 'bg-red-500' :
		strength === 2 ? 'bg-orange-500' :
		strength === 3 ? 'bg-yellow-500' :
		'bg-green-500'
	);

	const strengthTextColor = $derived(
		strength === 0 ? 'text-muted-foreground' :
		strength === 1 ? 'text-red-500' :
		strength === 2 ? 'text-orange-500' :
		strength === 3 ? 'text-yellow-500' :
		'text-green-500'
	);
</script>

{#if password}
	<div class="space-y-1">
		<div class="flex gap-1 h-1">
			{#each [1, 2, 3, 4] as level}
				<div
					class="flex-1 rounded-full transition-colors {strength >= level ? strengthColor : 'bg-muted'}"
				></div>
			{/each}
		</div>
		<p class="text-xs {strengthTextColor}">{strengthLabel}</p>
	</div>
{/if}
