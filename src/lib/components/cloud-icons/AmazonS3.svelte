<script lang="ts">
	let { class: className = 'w-4 h-4' }: { class?: string } = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512" class={className} fill="currentColor">
	<path opacity="0.85" d="M260 348l-137 33V131l137 32z"/>
	<path opacity="0.6" d="M256 349l133 32V131l-133 32v186"/>
	<g opacity="0.85"><path id="s3a" d="M256 64v97l58 14V93zm133 67v250l26-13V143zm-133 77v97l58-8v-82zm58 129l-58 14v97l58-29z"/></g>
	<use opacity="0.6" transform="rotate(180 256 256)" xlink:href="#s3a"/>
	<path opacity="0.4" d="M314 175l-58 11-58-11 58-15 58 15"/>
	<path opacity="0.95" d="M314 337l-58-11-58 11 58 16 58-16"/>
</svg>
