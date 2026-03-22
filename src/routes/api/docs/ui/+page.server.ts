import type { PageServerLoad } from './$types';

// This page is publicly accessible — no auth required.
// The path is registered in PUBLIC_PATHS in the root layout server load.
export const load: PageServerLoad = async () => {
	return {};
};
