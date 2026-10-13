<script lang="ts">
	import { getIconComponent } from '$lib/utils/icons';

	interface Props {
		name: string;
		class?: string;
		style?: string;
	}
	let { name, class: className = '', style = '' }: Props = $props();
	const Icon = $derived(getIconComponent(name));
</script>

<Icon class={className} {style} />
