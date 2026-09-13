import type { PageServerLoad } from './$types';

// No data needed server-side — the client-side Scalar bundle fetches
// GET /api/docs itself. The FEAT_API_DOCS gate is enforced in hooks.server.ts
// (a page load can't gate here: the app runs ssr=false, so this never fires on
// a cold server render).
export const load: PageServerLoad = async () => {
	return {};
};
