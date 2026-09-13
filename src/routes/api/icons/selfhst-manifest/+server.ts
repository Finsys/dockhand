import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSelfhstManifest } from '$lib/server/selfhst-icons';

/**
 * @openapi
 * summary: Get the selfh.st icon manifest (index.json), cached on disk with a 7-day TTL
 * description: Returns the selfh.st collection manifest (~2880 entries with Name, Reference, format flags, Category, Tags) so the icon picker can search it. Fetched once from the CDN and cached under DATA_DIR. Returns 503 only if it has never been fetched and the fetch fails.
 * resp-200: The raw selfh.st index.json array (application/json)
 * resp-503: The manifest is unavailable (never cached and the upstream fetch failed)
 */
export const GET: RequestHandler = async () => {
	const manifest = await getSelfhstManifest();
	if (!manifest) {
		return json({ error: 'Icon manifest unavailable' }, { status: 503 });
	}
	return new Response(manifest, {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
