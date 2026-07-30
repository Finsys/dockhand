<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	let container: HTMLDivElement;

	onMount(() => {
		if (!browser) return;

		// Self-hosted assets only (static/swagger-ui/, copied from the
		// swagger-ui-dist package by `npm run generate:openapi` — see
		// scripts/generate-openapi.ts copySwaggerUiAssets()). No CDN, works
		// offline / behind an internal-only Dockhand deployment.
		const cssLink = document.createElement('link');
		cssLink.rel = 'stylesheet';
		cssLink.href = '/swagger-ui/swagger-ui.css';
		document.head.appendChild(cssLink);

		function loadScript(src: string): Promise<void> {
			return new Promise((resolve, reject) => {
				const s = document.createElement('script');
				s.src = src;
				s.onload = () => resolve();
				s.onerror = () => reject(new Error(`Failed to load ${src}`));
				document.body.appendChild(s);
			});
		}

		(async () => {
			await loadScript('/swagger-ui/swagger-ui-bundle.js');
			await loadScript('/swagger-ui/swagger-ui-standalone-preset.js');
			// @ts-expect-error — SwaggerUIBundle is a global set by the script above
			window.SwaggerUIBundle({
				url: '/api/docs',
				dom_id: '#swagger-ui-container',
				presets: [
					// @ts-expect-error
					window.SwaggerUIBundle.presets.apis,
					// @ts-expect-error
					window.SwaggerUIStandalonePreset
				],
				layout: 'StandaloneLayout',
				deepLinking: true
			});
		})();

		return () => {
			cssLink.remove();
		};
	});
</script>

<svelte:head>
	<title>Dockhand API Docs</title>
</svelte:head>

<div id="swagger-ui-container" bind:this={container}></div>

<style>
	:global(body) {
		margin: 0;
	}
</style>
