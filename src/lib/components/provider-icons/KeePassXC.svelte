<script lang="ts">
	let { class: className = 'w-4 h-4' }: { class?: string } = $props();
</script>

<!-- KeePassXC brand mark, monochrome (currentColor). -->
<svg
	viewBox="0 0 24 24"
	xmlns="http://www.w3.org/2000/svg"
	class={className}
	fill="currentColor"
	aria-label="KeePassXC"
>
	<path
		d="M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24m0 .8A11 11 0 0 1 23.2 12 11 11 0 0 1 12 23.2 11 11 0 0 1 .8 12 11 11 0 0 1 12 .8m0 1.9-1.7.1A1.7 1.7 0 0 0 12 5a1.7 1.7 0 0 0 1.7-2.2zM7.2 4a9 9 0 0 0-4.5 8 9.3 9.3 0 0 0 18.6 0 9 9 0 0 0-4.5-8 5 5 0 0 1-2.7 5.4l-.1 2 1.5 1.5-1.5 1.5 1 1-1 1v1.8l-2 2.1-2.1-2v-9A5 5 0 0 1 7.2 4m3.4 6.5v7h.7v-7z"
	/>
</svg>
