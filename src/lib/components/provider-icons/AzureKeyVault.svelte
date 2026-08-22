<script lang="ts">
	let { class: className = 'w-4 h-4' }: { class?: string } = $props();
</script>

<!-- Azure Key Vault, monochrome (currentColor). Ring + key, toned via opacity. -->
<svg
	viewBox="0 0 18 18"
	xmlns="http://www.w3.org/2000/svg"
	class={className}
	fill="currentColor"
	aria-label="Azure Key Vault"
>
	<path
		d="M9,.5A8.5,8.5,0,1,0,17.5,9,8.51,8.51,0,0,0,9,.5ZM9,16.34A7.34,7.34,0,1,1,16.34,9,7.34,7.34,0,0,1,9,16.34Z"
		style="opacity:.55"
	/>
	<path
		d="M13.44,7.33a1.84,1.84,0,0,0,0-2.59h0L10.29,1.58a1.83,1.83,0,0,0-2.58,0h0L4.56,4.74a1.84,1.84,0,0,0,0,2.59L7.18,10a.51.51,0,0,1,.15.36v4.88a.63.63,0,0,0,.18.44l1.2,1.2a.41.41,0,0,0,.58,0l1.16-1.16h0l.68-.68a.25.25,0,0,0,0-.34l-.49-.49a.27.27,0,0,1,0-.37l.49-.49a.25.25,0,0,0,0-.34l-.49-.49a.27.27,0,0,1,0-.37l.49-.49a.25.25,0,0,0,0-.34l-.68-.69v-.25ZM9,2.35A1,1,0,0,1,9,4.42,1,1,0,1,1,9,2.35Z"
	/>
</svg>
