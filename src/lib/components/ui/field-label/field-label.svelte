<script lang="ts">
	import { Label } from '$lib/components/ui/label';

	// Form field label with a consistent required/optional marker: a red "*" glued to
	// the label text for required fields, a muted "(optional)" suffix otherwise. Keeps
	// every form's marker identical instead of each field hand-rolling its own span.
	interface Props {
		label: string;
		forId?: string;
		required?: boolean;
		/** Show "(optional)" when not required. Off for forms that only mark required. */
		showOptional?: boolean;
	}
	let { label, forId, required = false, showOptional = true }: Props = $props();
</script>

<Label for={forId}>
	<span>{label}{#if required}<span class="text-destructive">&nbsp;*</span>{/if}</span>
	{#if !required && showOptional}<span class="text-muted-foreground text-xs font-normal">(optional)</span>{/if}
</Label>
