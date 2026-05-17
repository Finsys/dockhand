// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { AuthenticatedUser } from '$lib/server/auth';

declare global {
	// Build-time constants injected by Vite
	const __APP_VERSION__: string | null;
	const __BUILD_DATE__: string | null;
	const __BUILD_COMMIT__: string | null;

	namespace App {
		// interface Error {}
		interface Locals {
			user: AuthenticatedUser | null;
			authEnabled: boolean;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
