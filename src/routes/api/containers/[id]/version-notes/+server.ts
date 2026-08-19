import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inspectContainer } from '$lib/server/docker';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { resolveReleaseSource } from '$lib/server/semver/release-source';
import { resolveChangelogUrl } from '$lib/utils/changelog-url';
import { fetchReleaseNotes } from '$lib/server/semver/release-notes';

/**
 * GET /api/containers/{id}/version-notes - Release notes for a newer version tag
 *
 * @openapi
 * summary: Resolve GitHub release notes for the versions a semver update-check surfaced (requires the 'view' permission)
 * path: id:string! Container ID or name (from GET /api/containers)
 * query: env:integer The target environment ID (omit for the local/default Docker host) (from GET /api/environments)
 * query: versions:string! Comma-separated version tags to fetch notes for (target + skipped), e.g. "16.3-alpine,16.4-alpine"
 * resp-200: {changelogUrl:string, source:string, notes:array<{version:string!, name:string, githubTag:string, body:string, publishedAt:string, url:string!}>!}
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

		const src = resolveReleaseSource(imageName, labels);
		// Prefer the label-based changelog URL; fall back to the forge's releases page.
		const changelogUrl = resolveChangelogUrl(imageName, labels) ?? src?.releasesUrl ?? null;

		// No recognizable forge -> no per-version notes, just the changelog link (if any).
		const notes = src ? await fetchReleaseNotes(src, versions) : [];

		return json({ changelogUrl, source: src?.slug ?? null, notes });
	} catch (error) {
		console.error('Failed to resolve version notes:', error);
		return json({ error: 'Failed to resolve release notes' }, { status: 500 });
	}
};
