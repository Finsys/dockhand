import type { PageServerLoad } from './$types';

// No data needed server-side — the client-side Scalar bundle fetches
// GET /api/docs itself. This load exists only so the route participates in
// the normal SvelteKit page lifecycle (and so +layout.server.ts's auth-bypass
// check for PUBLIC_PATHS applies the same way it does for every other page).
export const load: PageServerLoad = async () => {
	return {};
};
