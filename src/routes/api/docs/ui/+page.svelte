<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';

	let container: HTMLDivElement;

	onMount(() => {
		if (!browser) return;

		// Self-hosted assets only (static/scalar/, copied from the
		// @scalar/api-reference package by `npm run generate:openapi` — see
		// scripts/generate-openapi.ts copyScalarAssets()). No CDN, works
		// offline / behind an internal-only Dockhand deployment.
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
			await loadScript('/scalar/standalone.js');
			// @ts-expect-error — window.Scalar is a global set by the script above
			window.Scalar.createApiReference(container, {
				url: '/api/docs',
				// Explicitly disabled: the default points at Scalar's hosted
				// proxy.scalar.com, which we never want to reach (self-hosted,
				// no external fetch — CSP would block it anyway, and the
				// Dockhand API is same-origin so no proxy is needed).
				proxyUrl: ''
			});
		})();
	});
</script>

<svelte:head>
	<title>Dockhand API Docs</title>
</svelte:head>

<div bind:this={container}></div>

<style>
	:global(body) {
		margin: 0;
	}
</style>
