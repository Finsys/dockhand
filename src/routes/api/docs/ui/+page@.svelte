<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	let loading = $state(true);

	onMount(async () => {
		if (!browser) return;

		// Dynamically import swagger-ui-dist to avoid SSR issues
		const { default: SwaggerUIBundle } = await import('swagger-ui-dist/swagger-ui-bundle');

		// Import CSS
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = '/swagger-ui.css';
		document.head.appendChild(link);

		const el = document.getElementById('swagger-ui');
		if (el) {
			SwaggerUIBundle({
				url: '/api/docs',
				dom_id: '#swagger-ui',
				presets: [SwaggerUIBundle.presets.apis],
				layout: 'BaseLayout',
				deepLinking: true,
				defaultModelsExpandDepth: 1,
				defaultModelExpandDepth: 1
			});
		}

		loading = false;
	});
</script>

<svelte:head>
	<title>Dockhand API Documentation</title>
	<link
		rel="stylesheet"
		href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"
	/>
	<style>
		body {
			margin: 0;
			padding: 0;
		}
		#swagger-ui .topbar {
			display: none;
		}
	</style>
</svelte:head>

<div style="min-height: 100vh; background: white;">
	{#if loading}
		<div style="display: flex; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; color: #666;">
			<p>Loading API documentation...</p>
		</div>
	{/if}
	<div id="swagger-ui"></div>
</div>
