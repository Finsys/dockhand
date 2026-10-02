import { json, type RequestHandler } from '@sveltejs/kit';
import dependencies from '$lib/data/dependencies.json';
import { authorize } from '$lib/server/authorize';
import {
	DEFAULT_GRYPE_IMAGE,
	DEFAULT_TRIVY_IMAGE,
	scannerToolInventory
} from '$lib/utils/scanner-images';

// The scanner images Dockhand ships with. An install that pins its own images
// still reports these - this is the inventory of what the release was built around.
const externalTools = scannerToolInventory(DEFAULT_GRYPE_IMAGE, DEFAULT_TRIVY_IMAGE);

/**
 * GET /api/dependencies - Dependency and external-tool inventory
 *
 * Behind authentication: a version-exact inventory tells a reader which published
 * advisories apply to this instance, and the About screen that shows it is already
 * behind a login.
 *
 * @openapi
 * summary: Return the combined list of npm dependencies and external tool images (grype, trivy), sorted by name, excluding Dockhand itself
 * resp-200: array<{name:string!, version:string!, license:string, repository:string}>
 * resp-200-example: [{"name":"anchore/grype","version":"v0.119.0","license":"Apache-2.0","repository":"https://github.com/anchore/grype"}]
 * resp-401: Not authenticated
 */
export const GET: RequestHandler = async ({ cookies }) => {
	const auth = await authorize(cookies);
	if (auth.authEnabled && !auth.isAuthenticated) {
		return json({ error: 'Authentication required' }, { status: 401 });
	}

	// Combine npm dependencies with external tools, exclude dockhand itself
	const allDependencies = [...dependencies, ...externalTools]
		.filter((dep) => dep.name !== 'dockhand')
		.sort((a, b) => a.name.localeCompare(b.name));
	return json(allDependencies);
};
