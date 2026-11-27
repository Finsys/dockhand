import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({
			out: 'build'
		}),
		// SvelteKit's built-in CSRF origin check runs inside respond() before any handle
		// hook, so it cannot exempt the public cross-origin endpoints that authenticate by
		// signature (OIDC back-channel logout, git webhooks). We disable it here ('*') and
		// run our own origin check in hooks.server.ts (csrfHandle), which exempts those
		// paths - the pattern portainer/arcane use. Do NOT set this to [] without the hook,
		// or the signature-authenticated endpoints get 403'd before their handler runs.
		csrf: {
			trustedOrigins: ['*']
		}
	}
};

export default config;
