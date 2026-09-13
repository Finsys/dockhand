import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { resolveChangelogUrl } from '$lib/utils/changelog-url';
import { resolveAndFetchReleaseNotes } from '$lib/server/semver/release-notes';

/**
 * GET /api/containers/{id}/version-notes - Release notes for a newer version tag
 *
 * @openapi
 * summary: Resolve GitHub release notes for the versions a semver update-check surfaced (requires the 'view' permission)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * query: versions:string! Comma-separated version tags to fetch notes for (target + skipped), e.g. "16.3-alpine,16.4-alpine"
 * resp-200: {changelogUrl:string, source:string, rateLimited:boolean, notes:array<{version:string!, name:string, githubTag:string, body:string, publishedAt:string, url:string!}>!}
 * resp-200-example: {"changelogUrl":"https://github.com/go-gitea/gitea/releases","source":"go-gitea/gitea","notes":[{"version":"1.22.0","name":"v1.22.0","githubTag":"v1.22.0","body":"## Changes...","publishedAt":"2024-05-01T00:00:00Z","url":"https://github.com/go-gitea/gitea/releases/tag/v1.22.0"}]}
 * resp-403: Permission denied
 * resp-500: Failed to resolve release notes
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);

	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !(await auth.can('containers', 'view', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	const versions = (url.searchParams.get('versions') ?? '')
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);

	try {
		const inspectData = (await inspectContainer(params.id, envIdNum)) as any;
		const imageName: string | undefined = inspectData.Config?.Image;
		const labels: Record<string, string> = inspectData.Config?.Labels ?? {};

		// Resolve the source and fetch notes together: a confident forge (image.source
		// label / ghcr name) is used directly; otherwise a guessed repo (image name /
		// another label) is accepted only once a release matches a wanted version.
		const result = await resolveAndFetchReleaseNotes(imageName, labels, versions);

		// Prefer the label-based changelog URL; fall back to the accepted forge's
		// releases page. `versions` is ordered oldest->newest (the semver path), so the
		// LAST entry is the target tag - feed it to the label so a `{{version}}` template
		// resolves to the version being offered.
		const targetVersion = versions.length ? versions[versions.length - 1] : null;
		const changelogUrl =
			resolveChangelogUrl(imageName, labels, targetVersion) ?? result.source?.releasesUrl ?? null;

		return json({ changelogUrl, source: result.source?.slug ?? null, notes: result.notes, rateLimited: result.rateLimited });
	} catch (error) {
		console.error('Failed to resolve version notes:', error);
		return json({ error: 'Failed to resolve release notes' }, { status: 500 });
	}
};
