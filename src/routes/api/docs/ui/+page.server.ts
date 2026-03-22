import type { PageServerLoad } from './$types';

// This page is publicly accessible — no auth required.
// The path is registered in PUBLIC_PATHS in hooks.server.ts.
export const load: PageServerLoad = async () => {
	return {};
};
