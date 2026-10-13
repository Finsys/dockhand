<script lang="ts">
	let { class: className = 'w-4 h-4' }: { class?: string } = $props();
</script>

<!-- Psono, monochrome (currentColor). Nested cubes; the lit top faces are toned
     with opacity so the brand's two greens read as depth in a single colour. -->
<svg
	viewBox="0 0 512 512"
	xmlns="http://www.w3.org/2000/svg"
	class={className}
	fill="currentColor"
	aria-label="Psono"
>
	<polygon points="33,130 256,2 476,130 396,177 256,94 114,177" style="opacity:.55" />
	<polygon points="33,130 114,177 114,428 33,383" />
	<polygon points="476,130 476,383 256,512 178,466 178,350 256,393 396,313 396,177" />
	<polygon points="178,201 256,158 332,203 256,247" style="opacity:.55" />
	<polygon points="178,201 256,247 332,203 332,283 256,327 178,283" />
</svg>
